import { Controller, Get, HttpException, Inject, Query, UseGuards } from '@nestjs/common';
import { PublicTenantGuard } from '../storefront/public-tenant.guard';
import { StorefrontTenantId } from '../storefront/storefront-tenant.decorator';
import { OrderTrackingService, type OrderTrackingDto } from './order-tracking.service';

export type { OrderTrackingDto } from './order-tracking.service';

// A SEPARATE controller class (rather than a method on CheckoutController)
// purely because of the URL: the brief's spec is `GET
// /v1/storefront/orders/track`, which does NOT sit under
// `v1/storefront/checkout` — Nest has no way to make a method route "escape"
// its controller's own @Controller() prefix (a leading `/` in a @Get() path
// is not special-cased; Nest simply joins the two path segments), so reaching
// `v1/storefront/orders/track` from a controller prefixed
// `v1/storefront/checkout` is not possible. Registered in CheckoutModule's
// `controllers` array (see checkout.module.ts).
@Controller('v1/storefront/orders')
@UseGuards(PublicTenantGuard)
export class OrderTrackingController {
  // Explicit @Inject, matching every other controller in this codebase:
  // esbuild (vitest's TS transform) doesn't emit `design:paramtypes`, so
  // Nest's implicit constructor injection by type alone can't resolve this.
  constructor(@Inject(OrderTrackingService) private readonly tracking: OrderTrackingService) {}

  // Same "no extra guard beyond PublicTenantGuard" reasoning as
  // CheckoutController.confirmation(): a plain lookup, no cart cookie
  // involved. The one difference from confirmation() is this route ALSO
  // requires a matching `contact` (email or phone) — order numbers alone are
  // shareable/guessable-by-increment, but this endpoint additionally
  // surfaces `status`/`events`/`shipment`, which together tell a caller "did
  // this order ship yet, and to where" — enough that it shouldn't be
  // enumerable by order number alone the way the narrower confirmation DTO
  // is.
  //
  // The lookup itself now lives in OrderTrackingService, shared with the AI
  // agent's `get_order_status` tool — see that service for why the double
  // factor and the wrong-contact/nonexistent indistinguishability are worth
  // having exactly one copy of.
  @Get('track')
  async track(
    @StorefrontTenantId() tenantId: string,
    @Query('orderNumber') orderNumberParam: string | undefined,
    @Query('contact') contact: string | undefined,
  ): Promise<OrderTrackingDto> {
    // `contact` missing entirely is the one genuinely caller-side validation
    // failure in this route ("you forgot a required param") — unlike the
    // NaN/not-found cases, there's no order-existence question tied up in it,
    // so it stays a real 400 rather than collapsing into the 404. A PRESENT
    // but non-matching contact is handled inside the service and collapses
    // into the 404 below, which is the case that must stay indistinguishable.
    if (typeof contact !== 'string' || contact.trim().length === 0) {
      throw new HttpException(
        { error: 'VALIDATION_FAILED', details: { contact: 'contact es requerido' } },
        400,
      );
    }

    const dto = await this.tracking.track(tenantId, orderNumberParam ?? '', contact);
    if (!dto) {
      throw new HttpException({ error: 'ORDER_NOT_FOUND' }, 404);
    }
    return dto;
  }
}
