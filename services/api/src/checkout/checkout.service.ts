import { HttpException, Inject, Injectable } from '@nestjs/common';
import { Prisma, platformDb, tenantDb, type TaxRate as PrismaTaxRate } from '@ventia/db';
import {
  DEPARTAMENTOS,
  generateOrderReference,
  type CheckoutAddressInput,
  type TaxRateValue,
} from '@ventia/core';
import type { PaymentProviderId, TenantProviderConfig } from '@ventia/payments';
import { MAILER, type Mailer } from '../mailer/mailer';
import { sendOrderEmails, type OrderEmailContext } from '../mailer/order-emails';
import { adjustStockLine } from '../orders/orders.service';
import { PaymentsService } from '../payments/payments.service';
import { getProvider, PAYMENT_PROVIDER_NOT_CONFIGURED } from '../payments/provider-registry';
import { tenantStorefrontBaseUrl } from '../tenants/tenant-public-url';
import { ShippingService } from './shipping.service';
import { nextOrderNumber } from './order-number';
import { privacyPolicyVersionFor } from './privacy-consent';

// Stock is held for 15 minutes while a non-`cod` order's payment is pending
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
  paymentMethod: 'cod' | PaymentProviderId;
  /**
   * The shopper's Ley 1581 art. 9 authorization, already asserted by
   * `parseCheckoutBody`.
   *
   * Typed `true`, not `boolean`, on purpose: the controller 400s a submission
   * that lacks it, so by the time a `CheckoutInput` exists the authorization
   * has been given — and a `boolean` here would leave a representable state
   * ("checkout proceeding without authorization") that this system must never
   * be in. The field is kept rather than dropped so the service does not have
   * to take the controller's word for it implicitly; it reads as a
   * precondition carried in the type.
   */
  acceptedPrivacyPolicy: true;
}

export interface CheckoutResult {
  orderNumber: number;
  totalCents: number;
  // Only present for a non-`cod` checkout (design decision 8) — the
  // storefront redirects the browser here instead of going straight to the
  // order-confirmation page. Absent entirely (not `undefined`-valued) on
  // every `cod` response, matching this file's own test suite's exact-
  // equality assertion on the `cod` response shape.
  redirectUrl?: string;
}

// Everything the post-checkout email flow (and, for a non-`cod` payment
// method, the post-commit createCheckoutSession call) needs, computed once
// inside the transaction
// (cheap, since it's all already loaded/derived there) rather than re-queried
// afterward. `CheckoutResult` (the actual HTTP response shape, asserted
// verbatim by test/checkout.test.ts for the `cod` path) stays exactly
// `{orderNumber, totalCents}` for `cod` — this wider shape is internal to
// this service.
interface CheckoutTransactionResult extends CheckoutResult {
  orderId: string;
  /** `Order.reference` — the gateway-facing identifier for this order. Stays
   * internal to this service and the adapter call below; nothing shopper- or
   * merchant-facing renders it. */
  gatewayReference: string;
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

  /** @param tenantDomain The PUBLIC domain this request's tenant was resolved
   * through (`TenantDomain.domain`, supplied by `PublicTenantGuard` via
   * `@StorefrontTenantDomain()`). Used for exactly one thing: building the
   * tenant's own public storefront base URL, which every non-`cod` checkout
   * hands the payment adapter as `OrderForPayment.storefrontBaseUrl`.
   *
   * ## Why this parameter exists (multi-tenancy fix)
   *
   * Wompi's `redirect-url` and ePayco's bridge-page + `response` URLs must
   * point at the storefront the shopper is actually checking out on. Those
   * adapters used to resolve that base from ONE global env var
   * (`PAYMENTS_STOREFRONT_BASE_URL`), because nothing in their inputs carried a
   * tenant domain — so in any deployment with two or more tenants on Wompi or
   * ePayco, EVERY tenant's shopper was redirected to whichever single
   * storefront that variable named. Once Wompi's return page began `PATCH`ing
   * the API, that also became a cross-tenant WRITE: tenant B's shopper landing
   * on tenant A's storefront had A's proxy stamp `x-tenant-domain: A`, writing
   * B's transaction id onto A's same-numbered order, which A's reconciliation
   * worker then looked up with A's own credentials.
   *
   * Deliberately threaded from the request rather than re-resolved here: this
   * method already runs inside a real HTTP request whose tenant
   * `DomainResolver` matched against the `TenantDomain` table, and adding a
   * second resolution mechanism (a `TenantDomain` query of its own, or a
   * derivation from `PLATFORM_ROOT_DOMAIN`) would be both redundant and wrong
   * — a tenant can own a fully custom domain that no root-domain rule
   * produces, and a tenant can own several, of which the right one is the one
   * the shopper actually arrived on. */
  async checkout(
    tenantId: string,
    tenantDomain: string,
    cartCookieKey: string,
    input: CheckoutInput,
  ): Promise<CheckoutResult> {
    // The chosen online provider's tenant-provider-config check happens
    // FIRST, before this method touches the database at all — deliberately
    // BEFORE the transaction below, not after it commits. If this ran after
    // commit (or inside the transaction but after the Order/stock-reservation
    // writes), a tenant that never configured credentials for the chosen
    // provider would still get a real Order row created and real stock
    // decremented, only to then fail on a condition that was knowable up
    // front with zero side effects. A `cod` checkout never reaches this
    // branch at all (`onlineProviderConfig` stays `null` and unused for it).
    let onlineProviderConfig: TenantProviderConfig | null = null;
    // The tenant's own public storefront base URL, e.g.
    // `https://tienda.example.com` (or, in dev,
    // `http://demo-moda.ventia.localhost`). Resolved here, BEFORE the
    // transaction opens, for exactly the same reason the credential checks
    // below are: a malformed/absent tenant domain is knowable up front with
    // zero side effects, and discovering it post-commit would leave a real
    // Order row with real stock decremented and a shopper with no usable
    // checkout. `cod` never needs it and never computes it.
    let storefrontBaseUrl: string | null = null;
    if (input.paymentMethod !== 'cod') {
      storefrontBaseUrl = tenantStorefrontBaseUrl(tenantDomain);
      onlineProviderConfig = await this.paymentsService.getTenantProviderConfig(tenantId, input.paymentMethod);
      if (!onlineProviderConfig) {
        throw new HttpException({ error: PAYMENT_PROVIDER_NOT_CONFIGURED }, 400);
      }
      // Per-provider completeness check, generalized (closing a gap P3b's
      // phase-7 review found still open): each provider's fields are
      // OPTIONAL on their own credentials schema (a merchant can save
      // public/private keys alone), but there is no real checkout for which
      // they're actually dispensable in practice — a webhook can never be
      // verified without them, so an order paid for by a checkout that lacks
      // them would be created successfully now and only fail forever
      // afterward (at createCheckoutSession, or permanently at the webhook —
      // `401 WEBHOOK_INVALID_SIGNATURE` on every delivery, stranding the
      // order at PENDING/PENDING with no merchant-facing signal), after this
      // transaction has already decremented real stock. Checking this here,
      // alongside the `!onlineProviderConfig` check above and for the
      // identical reason, catches that case before any side effect exists at
      // all. Per-provider, not a blanket `!eventsSecret` check, because the
      // three providers' real requirements genuinely differ (verified
      // against each adapter's own `require*` guards, packages/payments/src/
      // {wompi,mercadopago,epayco}.ts): Wompi needs BOTH `integritySecret`
      // (signs the outbound checkout redirect) AND `eventsSecret` (verifies
      // the webhook); Mercado Pago has no `integritySecret` concept at all
      // and needs only `eventsSecret`; ePayco needs `eventsSecret` (its
      // `P_KEY`) AND `epaycoCustomerId` (its `P_CUST_ID_CLIENTE`) together.
      const incomplete =
        input.paymentMethod === 'wompi'
          ? !onlineProviderConfig.integritySecret || !onlineProviderConfig.eventsSecret
          : input.paymentMethod === 'epayco'
            ? !onlineProviderConfig.eventsSecret || !onlineProviderConfig.epaycoCustomerId
            : !onlineProviderConfig.eventsSecret; // mercadopago
      if (incomplete) {
        throw new HttpException({ error: PAYMENT_PROVIDER_NOT_CONFIGURED }, 400);
      }
    }

    // Read the tenant's shipping config BEFORE opening the transaction.
    //
    // The two questions asked of it (`isCodAllowedIn`, `priceForIn`) are still
    // asked from exactly where they were, in exactly the same order, and still
    // throw the same 400s at the same point — only the DATABASE READ behind
    // them moved out here. It had to: those calls used to run on `tenantDb`
    // from inside `platformDb.$transaction()`, which means asking the Prisma
    // pool for a SECOND connection while this request is already holding one.
    // A burst of concurrent checkouts wider than the pool then deadlocks —
    // every connection parked inside a transaction, waiting for a connection
    // only a parked transaction can free — until Prisma's transaction timeout
    // fires and the whole batch returns bare 500s. `scripts/load-test.mjs`
    // reproduces it at 100 concurrent checkouts (see docs/operations.md); the
    // failure is invisible below the pool size and total above it.
    //
    // Reading it a few milliseconds earlier is not a semantic change: this is
    // committed data read outside the transaction either way (the transaction
    // is on `platformDb`, `tenantDb` never joined it), so it was never
    // transactionally consistent with the order write to begin with.
    const shippingConfig = await this.shippingService.loadConfig(tenantId);

    // The política de tratamiento this tenant has published RIGHT NOW,
    // fingerprinted onto the order below as the Ley 1581 art. 8 lit. e)
    // *prueba de la autorización* — see checkout/privacy-consent.ts for why a
    // fingerprint and not the text, and why the client never supplies it.
    //
    // Read HERE, before the transaction opens, for exactly the reason the
    // `loadConfig` call above is: `tenantDb(...)` asks the Prisma pool for a
    // connection of its own, and asking for a second one while this request is
    // already holding one inside `platformDb.$transaction()` deadlocks the
    // pool under concurrent checkouts — the failure documented on
    // `ShippingConfig` in shipping.service.ts and reproduced by
    // scripts/load-test.mjs. Reading it milliseconds earlier is not a semantic
    // change: a merchant republishing their policy in the same instant a
    // shopper submits is a race with no correct answer, and the answer this
    // picks (the text that was published when the shopper's browser was
    // looking at it) is the one the evidence should record anyway.
    const publishedPolicy = await tenantDb(tenantId).tenantContent.findUnique({
      where: { tenantId_type: { tenantId, type: 'policy_privacy' } },
      select: { title: true, bodyMd: true },
    });
    const privacyPolicyVersion = privacyPolicyVersionFor(publishedPolicy);

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

        // Both calls below are pure functions over `shippingConfig`, loaded
        // before this transaction opened — no database access from in here.
        // See the note at the `loadConfig` call site.
        //
        // `isCodAllowed` is a COD-only concept (design doc decision 8) — any
        // non-COD checkout (wompi, mercadopago, epayco, ...) skips this check
        // entirely. This is the ONE place the `cod`
        // branch's own pre-existing 3 lines are now conditionally reached
        // rather than unconditionally reached; their own content/behavior for
        // an actual `cod` checkout is unchanged.
        if (input.paymentMethod === 'cod') {
          const codAllowed = this.shippingService.isCodAllowedIn(shippingConfig, input.address.departamentoCode);
          if (!codAllowed) {
            throw new HttpException({ error: 'SHIPPING_METHOD_UNAVAILABLE' }, 400);
          }
        }

        const shippingCents = this.shippingService.priceForIn(
          shippingConfig,
          input.shippingMethodId,
          input.address.departamentoCode,
          subtotalCents,
        );

        // NOT `+ taxCents`. SPEC.md §5: "Colombian retail convention —
        // **prices include IVA**. Order stores the tax breakdown per line
        // derived from each product's tax rate (`price_cents - price_cents /
        // (1 + rate)` for the tax portion)". `taxCents` is therefore the IVA
        // ALREADY CONTAINED IN `subtotalCents`, recorded so the order can show
        // a DIAN-ready breakdown — adding it charges the shopper IVA twice.
        //
        // This read as `subtotalCents + taxCents + shippingCents` until the P4
        // DoD test computed a total by hand and disagreed with it by 57.479
        // pesos on a 360.000-peso basket. Every order placed before this was
        // over-charged by the IVA portion of its own contents.
        const totalCents = subtotalCents + shippingCents;
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
            // The gateway-facing identifier, generated per order. Distinct
            // from `number` because `number` is per-tenant and two tenants may
            // share one gateway merchant account — see
            // docs/superpowers/specs/2026-08-15-per-order-gateway-references.md.
            // Generated for EVERY order, COD included: it costs nothing, and a
            // column that is only sometimes populated invites a consumer to
            // treat null as meaningful.
            reference: generateOrderReference(),
            status: 'PENDING',
            // `cod` keeps its original literal `'COD'`; any non-`cod`
            // payment method is `'PENDING'` (already the schema default, but
            // set explicitly per the design doc/brief) — the only other
            // Order-create fields that differ by paymentMethod
            // (`paymentProvider`, `stockReservedUntil`) are spread in below,
            // never present at all for `cod`.
            paymentStatus: input.paymentMethod !== 'cod' ? 'PENDING' : 'COD',
            customerId: customer.id,
            email: input.email,
            phone: input.phone,
            shippingAddress: input.address as Prisma.InputJsonValue,
            // Ley 1581 art. 8 lit. e) — the proof that this collection was
            // authorized, written in the same insert as the data it
            // authorizes, so the two can never come apart. The clock is the
            // SERVER's: the browser is asked whether it authorized, never
            // when. `input.acceptedPrivacyPolicy` is typed `true`, so there
            // is no branch here in which an order is created without this.
            privacyAcceptedAt: new Date(),
            privacyPolicyVersion,
            shippingMethod: input.shippingMethodId,
            shippingCents,
            subtotalCents,
            taxCents,
            totalCents,
            // Inherited from the cart, not hardcoded: SPEC.md §7's attribution
            // rule is that a cart the agent built (`create_cart_link` sets
            // `source: 'agent'`) produces an order the merchant can see was
            // AI-assisted, which is what the "ventas asistidas por IA" KPI
            // counts. Every ordinary cart is already `web` by column default,
            // so this reads as `'web'` for all non-agent traffic exactly as
            // the literal did.
            source: cart.source,
            // Same inheritance, different question: `source` is who assembled
            // the cart, `channel` is where the shopper was when they did. A
            // WhatsApp basket checked out on the web is still a WhatsApp sale —
            // the conversation is what earned it — so the order keeps the
            // cart's channel rather than the origin of the final click.
            channel: cart.channel,
            ...(input.paymentMethod !== 'cod'
              ? {
                  paymentProvider: input.paymentMethod,
                  stockReservedUntil: new Date(Date.now() + STOCK_RESERVATION_MS),
                }
              : {}),
          },
        });

        if (input.paymentMethod !== 'cod') {
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
          gatewayReference: order.reference,
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
    // sending that to a shopper checking out with any online provider
    // (wompi, mercadopago, epayco, ...) who hasn't paid yet (they're about to
    // be redirected to that provider's checkout, and may never come back /
    // may pay with a different attempt) would be actively misleading. No
    // equivalent "your order is confirmed" email is sent for an online-
    // provider checkout at THIS point in the flow — `PaymentsService.markPaid`
    // (fires from the provider's webhook once payment is actually confirmed)
    // does not currently send any email either, so that shopper gets no order
    // email at all until a later task adds one to `markPaid`. Flagged here
    // deliberately: this is a real, known gap in this task's scope, not an
    // oversight — sending the wrong (COD-worded) email would be worse than
    // sending none.
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

    if (input.paymentMethod !== 'cod') {
      // `onlineProviderConfig` is guaranteed non-null here: the only way to
      // reach this branch is `input.paymentMethod !== 'cod'`, and this method
      // already threw PAYMENT_PROVIDER_NOT_CONFIGURED and returned before the
      // transaction ever opened if it were null (see the top of this
      // method). Unlike the fire-and-forget email above, this call's result
      // (the redirect URL) IS needed synchronously for this method's own
      // return value/the HTTP response, so it's awaited, not fire-and-forget
      // — a real failure here (the provider's API/network) surfaces as a
      // genuine error to the caller instead of being swallowed, since the
      // shopper has no usable checkout outcome without a redirect URL.
      const { redirectUrl } = await getProvider(input.paymentMethod).createCheckoutSession(
        {
          orderId: result.orderId,
          // The HUMAN-facing number, used for the storefront return-URL path
          // and a gateway line item's title. Plain digits (`"42"`), never the
          // `VNT-`-prefixed display string used in emails/UI — the return
          // routes parse this back out of the path.
          orderNumber: String(result.orderNumber),
          // What the gateway echoes back, and the ONLY thing the webhook
          // handler resolves a settle through. Previously this was the order
          // number, which is per-tenant: a delivery about another tenant's
          // same-numbered order, arriving at this tenant's webhook URL,
          // resolved to THIS tenant's order, with only the amount check
          // between that and settling it with someone else's money.
          gatewayReference: result.gatewayReference,
          totalCents: result.totalCents,
          customerEmail: result.email,
          // The PER-TENANT public storefront base, computed above from this
          // request's own resolved tenant domain. This is what makes two
          // tenants' shoppers come back to two different storefronts; see this
          // method's `tenantDomain` doc comment for the cross-tenant write the
          // previous single-global-env-var version produced. Non-null here for
          // the same reason `onlineProviderConfig` is: both are set on exactly
          // the `paymentMethod !== 'cod'` path, before the transaction opened.
          storefrontBaseUrl: storefrontBaseUrl!,
        },
        onlineProviderConfig!,
      );
      return { orderNumber: result.orderNumber, totalCents: result.totalCents, redirectUrl };
    }

    return { orderNumber: result.orderNumber, totalCents: result.totalCents };
  }
}
