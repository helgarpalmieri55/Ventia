import {
  Body,
  Controller,
  Get,
  HttpException,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { Prisma, tenantDb } from '@ventia/db';
import { checkoutAddressSchema, DEPARTAMENTOS, type CheckoutAddressInput } from '@ventia/core';
import type { PaymentProviderId } from '@ventia/payments';
import { PublicTenantGuard } from '../storefront/public-tenant.guard';
import { StorefrontTenantId } from '../storefront/storefront-tenant.decorator';
import { CartCookieGuard } from './cart-cookie.guard';
import { CartCookieKey } from './cart-cookie.decorator';
import { ShippingService } from './shipping.service';
import { CheckoutService, type CheckoutInput } from './checkout.service';

type JsonRecord = Record<string, unknown>;

// Same defensive-parse posture as checkout.service.ts's own `asRecord` /
// settings.controller.ts's / shipping.service.ts's: `shippingAddress` is a
// loosely-typed `Json` column. Every row here was in fact written by this
// same module's checkout.service.ts through the validated `CheckoutAddressInput`
// shape, but the column itself carries no schema guarantee at the DB level,
// so this read still narrows defensively rather than casting blindly.
function asRecord(value: Prisma.JsonValue | null | undefined): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {};
}

/** Narrow, intentionally minimal DTO for the post-checkout confirmation
 * screen — NOT the full order-detail shape a future P2c tracking page will
 * need. Deliberately omits `direccion`/`complemento`/`barrio`/`telefono`/
 * `email` (and everything else on Order/its address): this is a security-
 * relevant contract (order numbers are shareable/guessable-by-increment, so
 * this route is intentionally public — see the route's own comment below —
 * and must never leak the full address or any contact info to whoever holds
 * just the order number). */
export interface OrderConfirmationDto {
  orderNumber: number;
  totalCents: number;
  createdAt: string;
  items: Array<{ nameSnapshot: string; qty: number; priceCentsSnapshot: number }>;
  shippingCiudad: string;
  shippingDepartamento: string;
}

const CART_COOKIE_NAME = 'ventia_cart';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Every online provider id (`wompi`/`mercadopago`/`epayco`) is a valid
// `paymentMethod` at the validation layer, same as `wompi` alone was before
// this task — imported from @ventia/payments rather than hand-rolled so this
// list can never drift from `PaymentProviderId` itself.
const VALID_PAYMENT_METHODS: readonly PaymentProviderId[] = ['wompi', 'mercadopago', 'epayco'];

// Hand-rolled top-level shape validation, same rationale as
// cart.controller.ts's parseAddItemBody: this package avoids a direct `zod`
// dependency (see catalog/parse.ts's ParsableSchema doc comment), so a
// combined `email`/`phone`/`shippingMethodId`/`paymentMethod` + `address`
// schema can't be built with `z.object({...})` here without importing zod
// directly. `checkoutAddressSchema` itself, however, is a full zod schema
// object already built and owned by @ventia/core — calling `.safeParse` on
// an already-constructed schema instance needs no `zod` import of our own,
// so the nested `address` field is validated by calling that schema's
// `.safeParse` directly (structurally, the same thing parseOr400 does
// elsewhere in this codebase) and its errors are merged into this
// function's own `details` object rather than thrown separately, so the
// caller gets ONE 400 response covering both the top-level fields and the
// nested address in one shot.
function parseCheckoutBody(body: unknown): CheckoutInput {
  const b = (body ?? {}) as Record<string, unknown>;
  const details: Record<string, unknown> = {};

  if (typeof b.email !== 'string' || !EMAIL_RE.test(b.email)) {
    details.email = 'email inválido';
  }
  if (typeof b.phone !== 'string' || b.phone.trim().length < 7) {
    details.phone = 'phone es requerido';
  }
  if (typeof b.shippingMethodId !== 'string' || b.shippingMethodId.length === 0) {
    details.shippingMethodId = 'shippingMethodId es requerido';
  }
  if (b.paymentMethod !== 'cod' && !VALID_PAYMENT_METHODS.includes(b.paymentMethod as PaymentProviderId)) {
    details.paymentMethod = "paymentMethod debe ser 'cod', 'wompi', 'mercadopago' o 'epayco'";
  }

  const addressResult = checkoutAddressSchema.safeParse(b.address);
  if (!addressResult.success) {
    details.address = addressResult.error.flatten();
  }

  if (Object.keys(details).length > 0) {
    throw new HttpException({ error: 'VALIDATION_FAILED', details }, 400);
  }

  // Every branch above passed with no `details` entries, so addressResult is
  // guaranteed the success variant here — TypeScript can't correlate that
  // through the generic `details` object, hence the narrowing cast.
  const address = (addressResult as { success: true; data: CheckoutAddressInput }).data;

  return {
    email: b.email as string,
    phone: b.phone as string,
    address,
    shippingMethodId: b.shippingMethodId as string,
    paymentMethod: b.paymentMethod as 'cod' | PaymentProviderId,
  };
}

/** The largest value Postgres's `int4` can hold, and therefore the largest
 * value `Order.number` can. Prisma REJECTS an out-of-range value for an `Int`
 * filter by THROWING (a `PrismaClientValidationError`), exactly as it does for
 * `NaN` — so an all-digits-but-huge path param 500s in precisely the same
 * place, and with the same consequence, as the `NaN` the parse guards below
 * were originally written for. Verified live: `/checkout/confirmacion/99999999999`
 * returned a 500 before this bound existed. Wave 1 added the identical bound
 * to the webhook route's reference parse; these two sibling routes are the
 * ones it did not reach. */
const MAX_INT4 = 2_147_483_647;

/** Parses an `:orderNumber` path param into a value that is safe to hand
 * Prisma as an `Order.number` filter, or `null` if it is not one. Folded into
 * the callers' `ORDER_NOT_FOUND` 404 (rather than a distinct 400) since from
 * the shopper's perspective a malformed order-number URL and a genuinely
 * nonexistent order are the same outcome: "this URL doesn't point at a real
 * order". */
function parseOrderNumberParam(raw: string): number | null {
  const orderNumber = parseInt(raw, 10);
  if (!Number.isInteger(orderNumber) || orderNumber < 0 || orderNumber > MAX_INT4) return null;
  return orderNumber;
}

/** Upper bound on a stored `providerRef` (P3 wave-2 FIX 5). No cap existed at
 * all: a 90 KB `providerRef` was accepted and written to the column, with only
 * `express.json()`'s 100 kb default standing between an unauthenticated caller
 * and unbounded per-order storage growth.
 *
 * 128 is ample for every id this column ever legitimately holds — Wompi's
 * transaction ids look like `01-1531231271-19365` (~20 chars), Mercado Pago's
 * are numeric (~11), ePayco's `ref_payco` is numeric (~10). Anything longer is
 * not a gateway id, so rejecting it loses nothing real and is far below any
 * threshold where the write becomes interesting to an attacker. */
const MAX_PROVIDER_REF_LENGTH = 128;

/** Hand-rolled shape validation for the provider-ref-hint body, same
 * rationale (and same `VALIDATION_FAILED` + `details` response shape) as
 * `parseCheckoutBody` above: this package avoids a direct `zod` dependency
 * (see catalog/parse.ts's `ParsableSchema` doc comment), and unlike
 * `checkoutAddressSchema` there is no pre-built @ventia/core schema for this
 * one-field body to borrow.
 *
 * Trimmed before storing: a browser round trip can easily append whitespace
 * to a query param, and a `providerRef` with a stray space would be fed
 * verbatim into a gateway URL path later and simply 404 there. A body whose
 * `providerRef` is missing, not a string, empty, whitespace-only, or longer
 * than `MAX_PROVIDER_REF_LENGTH` is a 400 rather than a silently-ignored
 * no-op, so a broken caller is visible. The length is checked AFTER trimming,
 * so trailing whitespace can't push a legitimate id over the bound. */
function parseProviderRefHintBody(body: unknown): { providerRef: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const trimmed = typeof b.providerRef === 'string' ? b.providerRef.trim() : '';
  if (trimmed.length === 0) {
    throw new HttpException(
      { error: 'VALIDATION_FAILED', details: { providerRef: 'providerRef es requerido' } },
      400,
    );
  }
  if (trimmed.length > MAX_PROVIDER_REF_LENGTH) {
    throw new HttpException(
      {
        error: 'VALIDATION_FAILED',
        details: { providerRef: `providerRef debe tener máximo ${MAX_PROVIDER_REF_LENGTH} caracteres` },
      },
      400,
    );
  }
  return { providerRef: trimmed };
}

@Controller('v1/storefront/checkout')
@UseGuards(PublicTenantGuard)
export class CheckoutController {
  // Explicit @Inject: see cart.controller.ts's comment — esbuild (vitest's TS
  // transform) doesn't emit `design:paramtypes` metadata, so Nest's implicit
  // constructor-injection by type alone can't resolve providers here.
  constructor(
    @Inject(ShippingService) private readonly shippingService: ShippingService,
    @Inject(CheckoutService) private readonly checkoutService: CheckoutService,
  ) {}

  // No cart cookie needed for a quote — this is a "what are my options"
  // listing keyed only on tenant + destination departamento, not on any
  // particular guest's cart.
  @Get('shipping-quote')
  quote(@StorefrontTenantId() tenantId: string, @Query('departamento') departamento?: string) {
    if (!departamento || !DEPARTAMENTOS.some((d) => d.code === departamento)) {
      throw new HttpException(
        { error: 'VALIDATION_FAILED', details: { departamento: 'departamento inválido' } },
        400,
      );
    }
    return this.shippingService.quote(tenantId, departamento);
  }

  // CartCookieGuard applied at the METHOD level (not controller-level, unlike
  // CartController) — shipping-quote above is a tenant+destination-only
  // lookup that must never require or create a cart cookie.
  @Post()
  @UseGuards(CartCookieGuard)
  async checkout(
    @StorefrontTenantId() tenantId: string,
    @CartCookieKey() cartCookieKey: string | null,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    // Cheap short-circuit: no cart cookie at all means no cart to check out,
    // so skip validating the body and opening a transaction entirely.
    if (!cartCookieKey) {
      throw new HttpException({ error: 'CART_EMPTY' }, 400);
    }
    const input = parseCheckoutBody(body);
    const result = await this.checkoutService.checkout(tenantId, cartCookieKey, input);
    // No explicit res.status() call — Nest's default status code for a POST
    // handler is already 201 (see cart.controller.ts's addItem, which relies
    // on the same default while also using @Res({ passthrough: true }) for
    // its own cookie write).
    res.clearCookie(CART_COOKIE_NAME);
    return result;
  }

  // No CartCookieGuard (unlike POST / above) and no other guard beyond the
  // controller-level PublicTenantGuard: this is a plain lookup by order
  // number, not tied to any particular guest's cart. Publicly reachable is
  // intentional — order numbers alone (VNT-1042-style) reveal nothing
  // sensitive per the spec, and this is exactly the URL a shopper lands on
  // right after checkout, unauthenticated.
  //
  // This read is intentionally inlined here rather than added as a new
  // CheckoutService method: it's a single, non-transactional tenantDb read
  // plus DTO shaping with no write/locking concerns (unlike
  // CheckoutService.checkout's raw-SQL advisory-lock transaction, which is
  // exactly why that one lives in the service), and it doesn't reuse or
  // share any state with CheckoutService's constructor-injected
  // dependencies (ShippingService, MAILER). This app's storefront
  // controllers commonly read straight off `tenantDb` for a plain lookup
  // with no service in between (see e.g. `storefront/categories.controller.ts`,
  // `storefront/content.controller.ts`, `settings.controller.ts`) — this
  // route follows that same convention, not `quote()`'s (which delegates
  // the actual data access to `ShippingService` and only validates inline).
  @Get('confirmacion/:orderNumber')
  async confirmation(
    @StorefrontTenantId() tenantId: string,
    @Param('orderNumber') orderNumberParam: string,
  ): Promise<OrderConfirmationDto> {
    // A non-numeric param parses to NaN. Verified experimentally (this file's
    // own test suite caught this): passing `NaN` as an `Int` where-clause
    // value does NOT simply match zero rows the way a merely-nonexistent
    // number would — Prisma's query engine rejects `NaN` outright with a
    // `PrismaClientValidationError` ("Argument `number` is missing"), which
    // would otherwise surface as an uncaught 500. An out-of-int4-range value
    // throws in the same place for the same reason (P3 wave-2 FIX 6) — see
    // `parseOrderNumberParam`/`MAX_INT4`.
    const orderNumber = parseOrderNumberParam(orderNumberParam);
    if (orderNumber === null) {
      throw new HttpException({ error: 'ORDER_NOT_FOUND' }, 404);
    }

    const order = await tenantDb(tenantId).order.findFirst({
      where: { tenantId, number: orderNumber },
      include: { items: true },
    });
    if (!order) {
      throw new HttpException({ error: 'ORDER_NOT_FOUND' }, 404);
    }

    const address = asRecord(order.shippingAddress);
    const departamentoCode = typeof address.departamentoCode === 'string' ? address.departamentoCode : '';
    const shippingCiudad = typeof address.municipioName === 'string' ? address.municipioName : '';
    // Same "fall back to the raw code" defensive posture as
    // checkout.service.ts's own DEPARTAMENTOS lookup when building the
    // post-checkout email context.
    const shippingDepartamento = DEPARTAMENTOS.find((d) => d.code === departamentoCode)?.name ?? departamentoCode;

    return {
      orderNumber: order.number,
      totalCents: order.totalCents,
      createdAt: order.createdAt.toISOString(),
      items: order.items.map((item) => ({
        nameSnapshot: item.nameSnapshot,
        qty: item.qty,
        priceCentsSnapshot: item.priceCentsSnapshot,
      })),
      shippingCiudad,
      shippingDepartamento,
    };
  }

  /** Records a gateway transaction id onto `Order.providerRef` as a
   * RECONCILIATION HINT (P3c, design doc decision 2's second/third bullets).
   * Called by the storefront's post-payment bridge pages — Wompi's
   * `/pago/wompi-retorno/:orderNumber` return page and (later) ePayco's
   * `/pago/epayco` widget hook — one narrow endpoint, two callers.
   *
   * ## Why this is UNAUTHENTICATED on purpose, and why that is safe
   *
   * No `CartCookieGuard` (only the class-level `PublicTenantGuard`): by the
   * time the shopper's browser comes back from the gateway, checkout has
   * already cleared `ventia_cart` and there is no session of any kind — the
   * caller is an anonymous browser holding only an order number. So anyone
   * who can guess an order number can PATCH any string onto that order's
   * `providerRef`.
   *
   * **That is safe ONLY because the value stored here is never trusted on
   * its own.** It is exclusively an input to a LATER, AUTHENTICATED call to
   * the gateway's own status API, and the reconciliation worker (P3c Task 4)
   * MUST verify that call's response binds back to THIS order — i.e.
   * `result.reference === String(order.number)` (and, where the provider
   * reliably reports it, `result.amountCents === order.totalCents`) — BEFORE
   * ever calling `markPaid`/`markFailed`. See `TransactionStatusResult` in
   * packages/payments/src/index.ts, which exists specifically to carry that
   * binding, and its doc comment for the concrete attack it closes.
   *
   * **Do not "optimize away" that binding check.** Without it, a shopper
   * holding ONE real, genuinely-PAID transaction id (their own past
   * purchase) could PATCH it onto a DIFFERENT, still-`PENDING` order; the
   * worker would ask the gateway "is transaction X paid?", get a truthful
   * "yes", and settle the WRONG order. Free-order fraud, no guessing
   * required. The already-shipped webhook path
   * (`payments/webhooks.controller.ts`) doesn't have this problem because a
   * gateway signature cryptographically binds reference+amount+status
   * together and the order is looked up BY that verified reference; this
   * by-id path needs the equivalent binding done explicitly.
   *
   * Correspondingly, this endpoint writes `Order.providerRef` (plus its
   * `providerRefSource` provenance marker, and an `OrderEvent` audit row) and
   * NOTHING else — never `paymentStatus`/`status`. It cannot move an order's
   * state one inch on its own.
   *
   * ## What P3 wave-2 hardened here (FIX 5 + FIX 3), and why
   *
   * The original version accepted anything, from anyone, in any order state,
   * and left no trace. Four verified defects, and what replaced each:
   *
   *  1. **No length cap.** A 90 KB `providerRef` was accepted and stored;
   *     only `express.json()`'s 100 kb default bounded it. Now capped at
   *     `MAX_PROVIDER_REF_LENGTH` — see that constant for why 128 is ample.
   *  2. **No state filter.** Accepted on `PAID`, `CANCELLED` and COD orders
   *     alike, none of which the reconciliation job will ever look at. Now
   *     only while the order is genuinely awaiting an online payment:
   *     `paymentProvider != null` and `paymentStatus` in (`PENDING`,
   *     `FAILED`). `FAILED` is included on purpose — a declined attempt
   *     leaves the order recoverable and retryable (see
   *     `PaymentsService.markPaid`'s FIX 1 note), so the retry's return page
   *     must still be able to report its new transaction id.
   *  3. **Unconditional overwrite.** A `providerRef` a signature-verified
   *     webhook had already stamped could be clobbered by anyone who knew the
   *     order number — a repeatable denial of settlement. Now refused: a ref
   *     whose `providerRefSource` is `'verified'` wins over any hint. This is
   *     a deliberate REVERSAL of design decision 2's "a later source wins",
   *     which assumed every source was equally trustworthy because every
   *     source is re-verified against the gateway. FIX 3 established that is
   *     false: re-verification proves the transaction exists and matches, not
   *     that it was paid into THIS tenant's account.
   *  4. **No audit trail.** The mutation left nothing behind. Now writes a
   *     `provider_ref_hint` `OrderEvent` with actor `'shopper'`, so an
   *     unexpected ref on an order is traceable to this endpoint rather than
   *     being indistinguishable from a webhook stamp.
   *
   * `providerRefSource: 'hint'` is the load-bearing part for FIX 3: the
   * reconciliation worker refuses to settle a by-id lookup from a hint-sourced
   * ref on any provider whose transaction lookup is not merchant-account-scoped
   * (today: Wompi and ePayco — see `ACCOUNT_SCOPED_LOOKUP_PROVIDERS` in
   * `payments/reconciliation.worker.ts`). So even a hint that passes every
   * check here cannot, on its own, settle an order on those providers.
   *
   * **Rate limiting is explicitly out of scope** and this endpoint remains
   * unauthenticated and unthrottled: no rate-limiting infrastructure exists
   * anywhere in this codebase, and it is tracked as a separate platform-wide
   * item. 60 rapid unauthenticated PATCHes still all return 200. What the
   * above changes bound is the DAMAGE per accepted call, not the call rate. */
  @Patch(':orderNumber/provider-ref-hint')
  async providerRefHint(
    @StorefrontTenantId() tenantId: string,
    @Param('orderNumber') orderNumberParam: string,
    @Body() body: unknown,
  ): Promise<{ ok: true }> {
    const { providerRef } = parseProviderRefHintBody(body);

    // Same guard, and the same fold-into-404, as `confirmation` above — see
    // that method's comment for why this branch is load-bearing rather than
    // defensive: Prisma's query engine REJECTS both a literal `NaN` and an
    // out-of-int4-range value for an `Int` where-clause by THROWING, instead
    // of matching zero rows, which would otherwise surface as an uncaught 500.
    const orderNumber = parseOrderNumberParam(orderNumberParam);
    if (orderNumber === null) {
      throw new HttpException({ error: 'ORDER_NOT_FOUND' }, 404);
    }

    // Read-then-write rather than the previous single `updateMany`: the
    // acceptance rules above (state filter, and "never clobber a verified
    // ref") are conditions on the CURRENT row, and the audit event needs the
    // order's id anyway. The tenant-scoped client AND-scopes this `where`
    // with `tenantId` on top of RLS (see packages/db's tenant-client.ts), so
    // an order number belonging to another tenant matches nothing here and
    // 404s rather than being read or written.
    //
    // No advisory lock and no transaction: the two writes below touch only
    // this order's `providerRef`/`providerRefSource` and append one event, and
    // a hint racing a webhook stamp is not a correctness problem — whichever
    // lands last, the reconciliation worker re-reads BOTH the ref and its
    // provenance together and applies the same rules to whatever it finds.
    // (The worst case is a hint landing microseconds after a verified stamp
    // and downgrading it, which is exactly the pre-existing "attacker can make
    // an order un-reconcilable" blast radius, not a new one.)
    const db = tenantDb(tenantId);
    const order = await db.order.findFirst({
      where: { tenantId, number: orderNumber },
      select: { id: true, paymentStatus: true, paymentProvider: true, providerRefSource: true },
    });
    if (!order) {
      throw new HttpException({ error: 'ORDER_NOT_FOUND' }, 404);
    }

    const awaitingOnlinePayment =
      order.paymentProvider !== null &&
      (order.paymentStatus === 'PENDING' || order.paymentStatus === 'FAILED');
    if (!awaitingOnlinePayment) {
      // 409, not a silent 200: the caller is a bridge page that genuinely got
      // this wrong (or an attacker), and a hint for an order that is already
      // settled, cancelled, or COD can never be acted on. `ORDER_NOT_FOUND`
      // would be a lie, and 200 would hide a broken storefront integration.
      throw new HttpException(
        {
          error: 'ORDER_NOT_AWAITING_PAYMENT',
          details: { paymentStatus: order.paymentStatus, paymentProvider: order.paymentProvider },
        },
        409,
      );
    }

    if (order.providerRefSource === 'verified') {
      throw new HttpException({ error: 'PROVIDER_REF_ALREADY_VERIFIED' }, 409);
    }

    await db.order.update({
      where: { id: order.id },
      data: { providerRef, providerRefSource: 'hint' },
    });

    // Audit trail (FIX 5, defect 4). `actor: 'shopper'` — this endpoint is
    // reached by an anonymous browser, never by staff or by the system, and
    // the event `data` deliberately records the value written so a support
    // engineer looking at an order can see exactly what was planted and when.
    await db.orderEvent.create({
      data: {
        tenantId,
        orderId: order.id,
        type: 'provider_ref_hint',
        actor: 'shopper',
        data: { providerRef, source: 'hint' } as Prisma.InputJsonValue,
      },
    });

    return { ok: true };
  }
}

