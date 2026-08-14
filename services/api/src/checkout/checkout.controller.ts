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
 * `providerRef` is missing, not a string, empty, or whitespace-only is a 400
 * rather than a silently-ignored no-op, so a broken caller is visible. */
function parseProviderRefHintBody(body: unknown): { providerRef: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.providerRef !== 'string' || b.providerRef.trim().length === 0) {
    throw new HttpException(
      { error: 'VALIDATION_FAILED', details: { providerRef: 'providerRef es requerido' } },
      400,
    );
  }
  return { providerRef: b.providerRef.trim() };
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
    // would otherwise surface as an uncaught 500. So malformed input needs
    // its own explicit branch after all; it's folded into the same
    // `ORDER_NOT_FOUND` 404 (rather than a distinct 400) since from the
    // shopper's perspective a malformed confirmation URL and a genuinely
    // nonexistent order number are the same outcome: "this URL doesn't point
    // at a real order".
    const orderNumber = parseInt(orderNumberParam, 10);
    if (!Number.isInteger(orderNumber)) {
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
   * Correspondingly, this endpoint writes `Order.providerRef` and NOTHING
   * else — never `paymentStatus`/`status`. It cannot move an order's state
   * one inch on its own, which is what keeps its blast radius at "an
   * attacker can make an order un-reconcilable" (a denial of convenience
   * that falls through to the existing stock-reservation expiry worker)
   * rather than "an attacker can mark an order paid".
   *
   * The write is unconditional — an existing, different `providerRef` is
   * overwritten rather than protected (design doc decision 2): a later,
   * more-authoritative source (e.g. a real webhook that already ran) should
   * win, and since every source is re-verified against the gateway anyway,
   * guarding on "only if null" would buy nothing and would let a stale value
   * pin an order into permanent unreconcilability. */
  @Patch(':orderNumber/provider-ref-hint')
  async providerRefHint(
    @StorefrontTenantId() tenantId: string,
    @Param('orderNumber') orderNumberParam: string,
    @Body() body: unknown,
  ): Promise<{ ok: true }> {
    const { providerRef } = parseProviderRefHintBody(body);

    // Same NaN guard, and the same fold-into-404, as `confirmation` above —
    // see that method's comment for why this branch is load-bearing rather
    // than defensive: Prisma's query engine REJECTS a literal `NaN`
    // where-value with a PrismaClientValidationError instead of matching
    // zero rows, which would otherwise surface as an uncaught 500.
    const orderNumber = parseInt(orderNumberParam, 10);
    if (!Number.isInteger(orderNumber)) {
      throw new HttpException({ error: 'ORDER_NOT_FOUND' }, 404);
    }

    // `updateMany` rather than findFirst-then-update: one round trip, and
    // its `count` is exactly the "did this order exist for this tenant"
    // answer the 404 needs. The tenant-scoped client AND-scopes this
    // `where` with `tenantId` on top of RLS (see packages/db's
    // tenant-client.ts), so an order number belonging to another tenant
    // matches nothing here and 404s rather than being written.
    const { count } = await tenantDb(tenantId).order.updateMany({
      where: { tenantId, number: orderNumber },
      data: { providerRef },
    });
    if (count === 0) {
      throw new HttpException({ error: 'ORDER_NOT_FOUND' }, 404);
    }

    return { ok: true };
  }
}

