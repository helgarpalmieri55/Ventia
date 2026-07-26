import { Body, Controller, Get, HttpException, Inject, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { Prisma, tenantDb } from '@ventia/db';
import { checkoutAddressSchema, DEPARTAMENTOS, type CheckoutAddressInput } from '@ventia/core';
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
  if (b.paymentMethod !== 'cod') {
    details.paymentMethod = "paymentMethod debe ser 'cod'";
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
    paymentMethod: 'cod',
  };
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
  // dependencies (ShippingService, MAILER). Matches this controller's own
  // established precedent: `quote()` above also does its (admittedly
  // smaller) validation logic directly in the controller rather than
  // pushing a one-line check into ShippingService.
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
}
