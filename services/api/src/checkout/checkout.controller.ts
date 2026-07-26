import { Body, Controller, Get, HttpException, Inject, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { checkoutAddressSchema, DEPARTAMENTOS, type CheckoutAddressInput } from '@ventia/core';
import { PublicTenantGuard } from '../storefront/public-tenant.guard';
import { StorefrontTenantId } from '../storefront/storefront-tenant.decorator';
import { CartCookieGuard } from './cart-cookie.guard';
import { CartCookieKey } from './cart-cookie.decorator';
import { ShippingService } from './shipping.service';
import { CheckoutService, type CheckoutInput } from './checkout.service';

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
}
