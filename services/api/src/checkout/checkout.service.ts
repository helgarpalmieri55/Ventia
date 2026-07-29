import { HttpException, Inject, Injectable } from '@nestjs/common';
import { Prisma, platformDb, type TaxRate as PrismaTaxRate } from '@ventia/db';
import { DEPARTAMENTOS, type CheckoutAddressInput, type TaxRateValue } from '@ventia/core';
import type { TenantProviderConfig } from '@ventia/payments';
import { MAILER, type Mailer } from '../mailer/mailer';
import { sendOrderEmails, type OrderEmailContext } from '../mailer/order-emails';
import { adjustStockLine } from '../orders/orders.service';
import { PaymentsService } from '../payments/payments.service';
import { getProvider, PAYMENT_PROVIDER_NOT_CONFIGURED } from '../payments/provider-registry';
import { ShippingService } from './shipping.service';
import { nextOrderNumber } from './order-number';

// Stock is held for 15 minutes while a `wompi` order's payment is pending
// (P3a design doc decision 2) — released by a later BullMQ job (a
// subsequent task) if it's abandoned. `null` for every `cod` order.
const STOCK_RESERVATION_MS = 15 * 60_000;

type JsonRecord = Record<string, unknown>;

// Same defensive-parse posture as settings/settings.controller.ts's asRecord
// and checkout/shipping.service.ts's asRecord: `settings` is a loosely-typed
// JSON column, so a read through it treats an absent/malformed shape as
// "nothing configured" rather than throwing.
function asRecord(value: Prisma.JsonValue | null | undefined): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {};
}

// Same DB-enum <-> human-string maps as cart.service.ts / storefront/products.service.ts
// / csv-import.service.ts (duplicated locally, matching this codebase's
// established per-module-copy convention for these small const tables).
const TAX_RATE_FROM_DB: Record<PrismaTaxRate, TaxRateValue> = {
  ZERO: '0',
  FIVE: '5',
  NINETEEN: '19',
  EXCLUIDO: 'excluido',
};

const TAX_RATE_TO_DB: Record<TaxRateValue, PrismaTaxRate> = {
  '0': 'ZERO',
  '5': 'FIVE',
  '19': 'NINETEEN',
  excluido: 'EXCLUIDO',
};

const TAX_RATE_DECIMAL: Record<TaxRateValue, number> = {
  '0': 0,
  '5': 0.05,
  '19': 0.19,
  excluido: 0,
};

export interface CheckoutInput {
  email: string;
  phone: string;
  address: CheckoutAddressInput; // from @ventia/core — already validated by the controller before this service is called
  shippingMethodId: string;
  paymentMethod: 'cod' | 'wompi';
}

export interface CheckoutResult {
  orderNumber: number;
  totalCents: number;
  // Only present for a `wompi` checkout (design decision 8) — the storefront
  // redirects the browser here instead of going straight to the order-
  // confirmation page. Absent entirely (not `undefined`-valued) on every
  // `cod` response, matching this file's own test suite's exact-equality
  // assertion on the `cod` response shape.
  redirectUrl?: string;
}

// Everything the post-checkout email flow (and, for `wompi`, the post-commit
// createCheckoutSession call) needs, computed once inside the transaction
// (cheap, since it's all already loaded/derived there) rather than re-queried
// afterward. `CheckoutResult` (the actual HTTP response shape, asserted
// verbatim by test/checkout.test.ts for the `cod` path) stays exactly
// `{orderNumber, totalCents}` for `cod` — this wider shape is internal to
// this service.
interface CheckoutTransactionResult extends CheckoutResult {
  orderId: string;
  email: string;
  phone: string;
  items: OrderEmailContext['items'];
  departamentoCode: string;
  municipioName: string;
  tenantName: string;
  merchantContactEmail: string | null;
}

interface CheckoutLine {
  productId: string;
  variantId: string | null;
  qty: number;
  name: string;
  priceCents: number;
  taxRate: TaxRateValue;
}

@Injectable()
export class CheckoutService {
  // Explicit @Inject: esbuild (vitest's TS transform) doesn't emit
  // `design:paramtypes` metadata, so Nest's implicit constructor-injection by
  // type alone can't resolve ShippingService (or MAILER, a Symbol token that
  // was never resolvable by type alone in the first place) here — same
  // caution as every other controller/service in this codebase (see
  // cart.controller.ts).
  constructor(
    @Inject(ShippingService) private readonly shippingService: ShippingService,
    @Inject(MAILER) private readonly mailer: Mailer,
    @Inject(PaymentsService) private readonly paymentsService: PaymentsService,
  ) {}

  async checkout(tenantId: string, cartCookieKey: string, input: CheckoutInput): Promise<CheckoutResult> {
    // `wompi`'s tenant-provider-config check happens FIRST, before this
    // method touches the database at all — deliberately BEFORE the
    // transaction below, not after it commits. If this ran after commit (or
    // inside the transaction but after the Order/stock-reservation writes),
    // a tenant that never configured Wompi credentials would still get a
    // real Order row created and real stock decremented, only to then fail
    // on a condition that was knowable up front with zero side effects. A
    // `cod` checkout never reaches this branch at all (`wompiConfig` stays
    // `null` and unused for it).
    let wompiConfig: TenantProviderConfig | null = null;
    if (input.paymentMethod === 'wompi') {
      wompiConfig = await this.paymentsService.getTenantProviderConfig(tenantId, 'wompi');
      // `integritySecret`/`eventsSecret` are optional on `wompiCredentialsSchema`
      // (a merchant can save public/private keys alone), but there is no real
      // Wompi checkout for which they're actually dispensable: this method's
      // own post-commit `createCheckoutSession` call needs `integritySecret`
      // to sign the checkout request, and a webhook can never be verified
      // without `eventsSecret` either — so an order paid for by a wompi
      // checkout that lacks either would be created successfully now and only
      // fail later (createCheckoutSession, or forever at the webhook), after
      // this transaction has already decremented real stock. Checking both
      // here, alongside the existing !wompiConfig check and for the identical
      // reason (see the comment above), catches that case before any side
      // effect exists at all.
      if (!wompiConfig || !wompiConfig.integritySecret || !wompiConfig.eventsSecret) {
        throw new HttpException({ error: PAYMENT_PROVIDER_NOT_CONFIGURED }, 400);
      }
    }

    const result = await platformDb.$transaction(
      async (tx): Promise<CheckoutTransactionResult> => {
        // Manual RLS transaction escape (same pattern as
        // storefront/products.service.ts's list() and csv-import.service.ts's
        // commit()): allocating a sequential per-tenant order number needs a
        // Postgres advisory lock, which is raw SQL — and tenantDb's Prisma
        // extension deliberately blocks raw queries (see
        // packages/db/src/tenant-client.ts). We re-establish RLS scoping
        // ourselves for the lifetime of this one transaction; every
        // read/write below uses `tx` directly (NOT tenantDb). Every read and
        // every create includes tenantId explicitly; `customer.update` and
        // `cart.delete` further down key off ids already resolved from a
        // tenantId-scoped read earlier in this same transaction (no
        // time-of-check/time-of-use gap) and also carry tenantId in their own
        // `where` as redundant defense-in-depth — Postgres RLS (the
        // tenant_isolation policy's WITH CHECK clause) is the fail-closed
        // backstop underneath all of this regardless.
        await tx.$executeRawUnsafe('SET LOCAL ROLE ventia_app');
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
        // Advisory lock taken up front (inside nextOrderNumber) serializes
        // concurrent checkouts for this SAME tenant for the rest of this
        // transaction's lifetime — see order-number.ts's doc comment.

        const cart = await tx.cart.findFirst({
          where: { tenantId, cookieKey: cartCookieKey },
          include: { items: true },
        });
        if (!cart || cart.items.length === 0) {
          throw new HttpException({ error: 'CART_EMPTY' }, 400);
        }

        // Re-fetch every line's CURRENT product/variant state — checkout
        // must never trust the cart's possibly-stale price/stock snapshot.
        const productIds = [...new Set(cart.items.map((i) => i.productId))];
        const variantIds = [
          ...new Set(cart.items.map((i) => i.variantId).filter((v): v is string => v !== null)),
        ];
        const [products, variants] = await Promise.all([
          tx.product.findMany({ where: { tenantId, id: { in: productIds } } }),
          variantIds.length
            ? tx.productVariant.findMany({ where: { tenantId, id: { in: variantIds } } })
            : Promise.resolve([]),
        ]);
        const productById = new Map(products.map((p) => [p.id, p]));
        const variantById = new Map(variants.map((v) => [v.id, v]));

        let subtotalCents = 0;
        let taxCents = 0;
        const lines: CheckoutLine[] = [];

        for (const item of cart.items) {
          const product = productById.get(item.productId);
          // A product removed/archived since it was added to the cart has no
          // meaningful "available" count to report — treat as 0 available,
          // same bucket as a genuine stock shortfall (INSUFFICIENT_STOCK),
          // since the underlying customer-facing problem is identical: this
          // line can no longer be fulfilled. This throw aborts the whole
          // $transaction callback, so Prisma rolls back everything already
          // written above (nothing is written above at this point, but later
          // lines/order/customer rows would be too) — no partial order.
          if (!product) {
            throw new HttpException(
              { error: 'INSUFFICIENT_STOCK', details: { productId: item.productId, available: 0 } },
              400,
            );
          }
          // A product the merchant archived/unpublished after it was added to
          // the cart must not be purchasable, even if its stock count is
          // still nonzero — same "no longer orderable" bucket as the missing-
          // row case above (not a distinct error code: from the shopper's
          // perspective, both mean "this item can't be bought right now").
          if (product.status !== 'active') {
            throw new HttpException(
              { error: 'INSUFFICIENT_STOCK', details: { productId: item.productId, available: 0 } },
              400,
            );
          }
          const variant = item.variantId ? variantById.get(item.variantId) : undefined;
          if (item.variantId && !variant) {
            throw new HttpException(
              { error: 'INSUFFICIENT_STOCK', details: { productId: item.productId, available: 0 } },
              400,
            );
          }

          // ProductVariant has no `trackInventory` flag of its own (schema.prisma) —
          // it always defers to the parent product's flag, only substituting
          // its own `stock` count when a variant is selected.
          const stock = variant ? variant.stock : product.stock;
          if (product.trackInventory && stock < item.qty) {
            throw new HttpException(
              { error: 'INSUFFICIENT_STOCK', details: { productId: item.productId, available: stock } },
              400,
            );
          }

          const priceCents = variant?.priceCents ?? product.priceCents;
          const taxRate = TAX_RATE_FROM_DB[product.taxRate];
          const lineSubtotalCents = priceCents * item.qty;
          const rateDecimal = TAX_RATE_DECIMAL[taxRate];
          const lineTaxCents = lineSubtotalCents - Math.round(lineSubtotalCents / (1 + rateDecimal));
          subtotalCents += lineSubtotalCents;
          taxCents += lineTaxCents;

          lines.push({
            productId: item.productId,
            variantId: item.variantId,
            qty: item.qty,
            name: product.name,
            priceCents,
            taxRate,
          });
        }

        // ShippingService's methods run on plain tenantDb (each a read of
        // Tenant.settings, committed independently of this transaction) —
        // calling them from inside our transaction is safe since they don't
        // need transactional consistency with the order write below, and
        // they never touch Cart/Order/Customer rows themselves.
        //
        // `isCodAllowed` is a COD-only concept (design doc decision 8) — a
        // `wompi` checkout skips this check entirely, same as it would for
        // any other non-COD payment method. This is the ONE place the `cod`
        // branch's own pre-existing 3 lines are now conditionally reached
        // rather than unconditionally reached; their own content/behavior for
        // an actual `cod` checkout is unchanged.
        if (input.paymentMethod === 'cod') {
          const codAllowed = await this.shippingService.isCodAllowed(tenantId, input.address.departamentoCode);
          if (!codAllowed) {
            throw new HttpException({ error: 'SHIPPING_METHOD_UNAVAILABLE' }, 400);
          }
        }

        const shippingCents = await this.shippingService.priceFor(
          tenantId,
          input.shippingMethodId,
          input.address.departamentoCode,
          subtotalCents,
        );

        const totalCents = subtotalCents + taxCents + shippingCents;
        const orderNumber = await nextOrderNumber(tx, tenantId);

        // Only needed for the post-checkout email flow below (tenant display
        // name + the merchant's optional contact address) — one cheap extra
        // read inside the same transaction rather than a second round trip
        // after commit.
        const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
        const storeInfo = asRecord(asRecord(tenant.settings).storeInfo as Prisma.JsonValue | undefined);
        const merchantContactEmail =
          typeof storeInfo.contactEmail === 'string' ? storeInfo.contactEmail : null;

        const existingCustomer = await tx.customer.findFirst({ where: { tenantId, email: input.email } });
        const customer = existingCustomer
          ? await tx.customer.update({
              where: { id: existingCustomer.id, tenantId },
              data: { ordersCount: { increment: 1 }, totalSpentCents: { increment: totalCents } },
            })
          : await tx.customer.create({
              data: {
                tenantId,
                email: input.email,
                phone: input.phone,
                name: input.address.nombreCompleto,
                ordersCount: 1,
                totalSpentCents: totalCents,
              },
            });

        const order = await tx.order.create({
          data: {
            tenantId,
            number: orderNumber,
            status: 'PENDING',
            // `cod` keeps its original literal `'COD'`; `wompi` is `'PENDING'`
            // (already the schema default, but set explicitly per the design
            // doc/brief) — the only other Order-create fields that differ by
            // paymentMethod (`paymentProvider`, `stockReservedUntil`) are
            // spread in below, never present at all for `cod`.
            paymentStatus: input.paymentMethod === 'wompi' ? 'PENDING' : 'COD',
            customerId: customer.id,
            email: input.email,
            phone: input.phone,
            shippingAddress: input.address as Prisma.InputJsonValue,
            shippingMethod: input.shippingMethodId,
            shippingCents,
            subtotalCents,
            taxCents,
            totalCents,
            source: 'web',
            ...(input.paymentMethod === 'wompi'
              ? {
                  paymentProvider: 'wompi',
                  stockReservedUntil: new Date(Date.now() + STOCK_RESERVATION_MS),
                }
              : {}),
          },
        });

        if (input.paymentMethod === 'wompi') {
          // Stock reservation (design doc decision 2): an online-payment
          // order actually decrements Product/ProductVariant.stock right now
          // (reusing orders.service.ts's own atomic floor-checked
          // adjustStockLine primitive, same as OrdersService.transition()'s
          // `confirm` branch does), rather than a separate reservation
          // ledger. Runs INSIDE this same transaction, after the Order row
          // above but before OrderItem/OrderEvent/cart-delete below — if any
          // line's floor check fails, this throws and Prisma rolls back
          // EVERYTHING this transaction has written so far (the Order row
          // included), so "reserve stock only if the whole order succeeds"
          // holds atomically; no compensating action is ever needed.
          for (const line of lines) {
            try {
              await adjustStockLine(tx, tenantId, line, -line.qty, 'order_reserved', order.id, 'system');
            } catch (err) {
              // adjustStockLine throws HttpException({error:'STOCK_BELOW_ZERO',
              // details:{productId}}, 422) on its floor check failing — an
              // internal error vocabulary from orders.service.ts's own
              // confirm/cancel flows, never meant to reach a shopper directly.
              // Deliberately remapped here to the SAME `INSUFFICIENT_STOCK`
              // 400 shape (`details: {productId, available}`) the `cod`
              // branch's own per-line stock check above already throws, so a
              // shopper checking out with either payment method sees one
              // consistent error vocabulary — never the internal
              // STOCK_BELOW_ZERO code. `available: 0` is a deliberate
              // approximation (the exact current stock isn't known here
              // without an extra read this task doesn't add) — this branch
              // only fires when the real-time stock has already dropped
              // below what's needed, so "0 left for you" is directionally
              // correct even if a nonzero-but-insufficient amount technically
              // remains.
              if (
                err instanceof HttpException &&
                (err.getResponse() as { error?: string })?.error === 'STOCK_BELOW_ZERO'
              ) {
                throw new HttpException(
                  { error: 'INSUFFICIENT_STOCK', details: { productId: line.productId, available: 0 } },
                  400,
                );
              }
              throw err;
            }
          }
        }

        await Promise.all(
          lines.map((line) =>
            tx.orderItem.create({
              data: {
                tenantId,
                orderId: order.id,
                productId: line.productId,
                variantId: line.variantId,
                nameSnapshot: line.name,
                priceCentsSnapshot: line.priceCents,
                qty: line.qty,
                taxRateSnapshot: TAX_RATE_TO_DB[line.taxRate],
              },
            }),
          ),
        );

        await tx.orderEvent.create({
          data: { tenantId, orderId: order.id, type: 'created', actor: 'shopper' },
        });

        // Cascades to CartItem via the schema's onDelete: Cascade. Two
        // concurrent checkouts sharing the SAME cart cookie both pass every
        // earlier check (the advisory lock only serializes order-number
        // allocation, not this whole method), so the loser reaches this
        // delete after the winner's transaction already committed and
        // deleted the same row — Prisma throws P2025 ("record to delete does
        // not exist") rather than a no-op, which would otherwise surface as
        // an uncaught 500. Mapped to the same CART_EMPTY the method's own
        // opening check throws for an already-empty/nonexistent cart: by the
        // time this fires, that's exactly what's true for the loser (their
        // cart is gone), and this throw still rolls back everything else
        // this transaction wrote (Order/OrderItem/OrderEvent/Customer), same
        // as any other throw inside this callback.
        try {
          await tx.cart.delete({ where: { id: cart.id, tenantId } });
        } catch (err) {
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
            throw new HttpException({ error: 'CART_EMPTY' }, 400);
          }
          throw err;
        }

        return {
          orderId: order.id,
          orderNumber,
          totalCents,
          email: input.email,
          phone: input.phone,
          items: lines.map((line) => ({
            nameSnapshot: line.name,
            qty: line.qty,
            priceCentsSnapshot: line.priceCents,
          })),
          departamentoCode: input.address.departamentoCode,
          municipioName: input.address.municipioName,
          tenantName: tenant.name,
          merchantContactEmail,
        };
      },
      { timeout: 15_000 },
    );

    // Fire-and-forget post-checkout email flow, same pattern as
    // storefront/revalidate.ts's revalidateStorefrontTag: called AFTER the
    // transaction has committed, never awaited by this method, and its own
    // failure is swallowed here (not re-thrown) so a slow/failed email
    // provider can never delay or fail the checkout response itself.
    //
    // `cod`-only: sendOrderEmails' own template (order-emails.ts) explicitly
    // says "Tu pedido ... se pagará contra entrega" (COD-specific wording) —
    // sending that to a `wompi` shopper who hasn't paid yet (they're about to
    // be redirected to Wompi's checkout, and may never come back / may pay
    // with a different attempt) would be actively misleading. No equivalent
    // "your order is confirmed" email is sent for `wompi` at THIS point in
    // the flow — `PaymentsService.markPaid` (Task 4, fires from the webhook
    // once Wompi actually confirms payment) does not currently send any
    // email either, so a `wompi` shopper gets no order email at all until a
    // later task adds one to `markPaid`. Flagged here deliberately: this is a
    // real, known gap in this task's scope, not an oversight — sending the
    // wrong (COD-worded) email would be worse than sending none.
    if (input.paymentMethod === 'cod') {
      const departamentoName = DEPARTAMENTOS.find((d) => d.code === result.departamentoCode)?.name ?? result.departamentoCode;
      const emailCtx: OrderEmailContext = {
        orderNumber: result.orderNumber,
        email: result.email,
        phone: result.phone,
        totalCents: result.totalCents,
        items: result.items,
        shippingAddress: { departamentoName, municipioName: result.municipioName },
        merchantContactEmail: result.merchantContactEmail,
        tenantName: result.tenantName,
      };
      sendOrderEmails(this.mailer, emailCtx).catch((err: unknown) => {
        console.error('[checkout] order email failed', err);
      });
    }

    if (input.paymentMethod === 'wompi') {
      // `wompiConfig` is guaranteed non-null here: the only way to reach this
      // branch is `input.paymentMethod === 'wompi'`, and this method already
      // threw PAYMENT_PROVIDER_NOT_CONFIGURED and returned before the
      // transaction ever opened if it were null (see the top of this
      // method). Unlike the fire-and-forget email above, this call's result
      // (the redirect URL) IS needed synchronously for this method's own
      // return value/the HTTP response, so it's awaited, not fire-and-forget
      // — a real failure here (the Wompi API/network) surfaces as a genuine
      // error to the caller instead of being swallowed, since the shopper
      // has no usable checkout outcome without a redirect URL.
      const { redirectUrl } = await getProvider('wompi').createCheckoutSession(
        {
          orderId: result.orderId,
          // CRITICAL contract with the webhook handler (Task 4,
          // webhooks.controller.ts): this MUST be the plain string form of
          // the Prisma `Int` order number (`String(result.orderNumber)`,
          // e.g. `"42"`), NEVER the `VNT-`-prefixed display string used in
          // emails/UI. The webhook handler resolves an incoming event back to
          // this order via `Number(event.reference)` against `Order.number`
          // — sending the prefixed form here would silently break webhook
          // resolution for every real Wompi order.
          orderNumber: String(result.orderNumber),
          totalCents: result.totalCents,
          customerEmail: result.email,
        },
        wompiConfig!,
      );
      return { orderNumber: result.orderNumber, totalCents: result.totalCents, redirectUrl };
    }

    return { orderNumber: result.orderNumber, totalCents: result.totalCents };
  }
}
