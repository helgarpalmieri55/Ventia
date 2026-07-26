import { HttpException, Inject, Injectable } from '@nestjs/common';
import { Prisma, platformDb, type TaxRate as PrismaTaxRate } from '@ventia/db';
import { DEPARTAMENTOS, type CheckoutAddressInput, type TaxRateValue } from '@ventia/core';
import { MAILER, type Mailer } from '../mailer/mailer';
import { sendOrderEmails, type OrderEmailContext } from '../mailer/order-emails';
import { ShippingService } from './shipping.service';
import { nextOrderNumber } from './order-number';

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
  paymentMethod: 'cod';
}

export interface CheckoutResult {
  orderNumber: number;
  totalCents: number;
}

// Everything the post-checkout email flow needs, computed once inside the
// transaction (cheap, since it's all already loaded/derived there) rather
// than re-queried afterward. `CheckoutResult` (the actual HTTP response
// shape, asserted verbatim by test/checkout.test.ts) stays exactly
// `{orderNumber, totalCents}` — this wider shape is internal to this service.
interface CheckoutTransactionResult extends CheckoutResult {
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
  ) {}

  async checkout(tenantId: string, cartCookieKey: string, input: CheckoutInput): Promise<CheckoutResult> {
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
        const codAllowed = await this.shippingService.isCodAllowed(tenantId, input.address.departamentoCode);
        if (!codAllowed) {
          throw new HttpException({ error: 'SHIPPING_METHOD_UNAVAILABLE' }, 400);
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
            paymentStatus: 'COD',
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
          },
        });

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

        // Cascades to CartItem via the schema's onDelete: Cascade.
        await tx.cart.delete({ where: { id: cart.id, tenantId } });

        return {
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

    return { orderNumber: result.orderNumber, totalCents: result.totalCents };
  }
}
