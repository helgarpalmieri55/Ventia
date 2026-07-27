import { Controller, Get, HttpException, Query, UseGuards } from '@nestjs/common';
import { Prisma, tenantDb, type OrderStatus } from '@ventia/db';
import { DEPARTAMENTOS } from '@ventia/core';
import { PublicTenantGuard } from '../storefront/public-tenant.guard';
import { StorefrontTenantId } from '../storefront/storefront-tenant.decorator';

type JsonRecord = Record<string, unknown>;

// Same defensive-parse posture as checkout.controller.ts's own `asRecord` /
// checkout.service.ts's / settings.controller.ts's / shipping.service.ts's
// (this codebase's established per-module-copy convention for this exact
// 3-line helper): `shippingAddress` is a loosely-typed `Json` column, so this
// read narrows defensively rather than casting blindly.
function asRecord(value: Prisma.JsonValue | null | undefined): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {};
}

/** Broader than checkout.controller.ts's `OrderConfirmationDto` (a returning
 * shopper looking up their order by number + contact is explicitly asking to
 * see its lifecycle), but still deliberately narrow: no `email`/`phone`/full
 * `shippingAddress`, and `events` only exposes `type`/`createdAt` — NOT
 * `data`/`actor`, which are internal detail (see orders.service.ts's
 * OrderEventDTO for the full internal shape this is narrowed from). */
export interface OrderTrackingDto {
  orderNumber: number;
  status: OrderStatus;
  createdAt: string;
  items: Array<{ nameSnapshot: string; qty: number; priceCentsSnapshot: number }>;
  totalCents: number;
  shippingCiudad: string;
  shippingDepartamento: string;
  shipment: { carrier: string; trackingNumber: string } | null;
  events: Array<{ type: string; createdAt: string }>;
}

// A SEPARATE controller class (rather than a method on CheckoutController)
// purely because of the URL: the brief's spec is `GET
// /v1/storefront/orders/track`, which does NOT sit under
// `v1/storefront/checkout` — Nest has no way to make a method route "escape"
// its controller's own @Controller() prefix (a leading `/` in a @Get() path
// is not special-cased; Nest simply joins the two path segments), so reaching
// `v1/storefront/orders/track` from a controller prefixed
// `v1/storefront/checkout` is not possible. In its own file (rather than
// living inside checkout.controller.ts, where it was first written) since it
// serves a distinct URL namespace/resource (`orders`, not `checkout`) — this
// file's own local `asRecord`/DEPARTAMENTOS-lookup duplication is the cost of
// that separation, matching this codebase's established per-module-copy
// convention for such small helpers rather than sharing/exporting one copy.
// Registered in CheckoutModule's `controllers` array (see checkout.module.ts)
// since it has no dependencies of its own that would warrant its own module.
@Controller('v1/storefront/orders')
@UseGuards(PublicTenantGuard)
export class OrderTrackingController {
  // Same "no extra guard beyond PublicTenantGuard" reasoning as
  // CheckoutController.confirmation(): a plain lookup, no cart cookie
  // involved. The one difference from confirmation() is this route ALSO
  // requires a matching `contact` (email or phone) — order numbers alone are
  // shareable/guessable-by-increment, but this endpoint additionally
  // surfaces `status`/`events`/`shipment`, which together tell a caller "did
  // this order ship yet, and to where" — enough that it shouldn't be
  // enumerable by order number alone the way the narrower confirmation DTO
  // is. Hence the contact check below, and why wrong-contact and
  // nonexistent-order both collapse into the exact same 404 (see below).
  //
  // Inlined here rather than a new service, and reading straight off
  // tenantDb, for the same reasons as confirmation()'s doc comment: a single
  // non-transactional read plus DTO shaping, following this app's
  // storefront-controller convention (see storefront/categories.controller.ts,
  // storefront/content.controller.ts, settings.controller.ts) rather than
  // introducing a new service for what's ultimately two findFirst calls.
  @Get('track')
  async track(
    @StorefrontTenantId() tenantId: string,
    @Query('orderNumber') orderNumberParam: string | undefined,
    @Query('contact') contact: string | undefined,
  ): Promise<OrderTrackingDto> {
    // `contact` is the one genuinely caller-side validation failure in this
    // route ("you forgot a required param") — unlike the NaN/not-found cases
    // below, there's no order-existence question tied up in it, so it's a
    // real 400 rather than folded into the 404.
    if (typeof contact !== 'string' || contact.trim().length === 0) {
      throw new HttpException(
        { error: 'VALIDATION_FAILED', details: { contact: 'contact es requerido' } },
        400,
      );
    }

    // Same NaN gotcha as CheckoutController.confirmation() (see that route's
    // doc comment for the full Prisma-rejects-NaN explanation) — folded into
    // the same ORDER_NOT_FOUND 404 rather than a distinct 400 for the same
    // reason: from the shopper's perspective a malformed order number and a
    // genuinely nonexistent one are the same outcome.
    const orderNumber = parseInt(orderNumberParam ?? '', 10);
    if (!Number.isInteger(orderNumber)) {
      throw new HttpException({ error: 'ORDER_NOT_FOUND' }, 404);
    }

    // The `OR: [{email: contact}, {phone: contact}]` clause is folded into
    // this SAME query (rather than looking up the order first and checking
    // contact after) so that "order exists but wrong contact" and "order
    // doesn't exist" take the identical code path below — no separate
    // branch exists that could observably differ (timing, shape, or
    // otherwise) between the two cases, which matters because this is an
    // unauthenticated endpoint and an attacker enumerating order numbers
    // must not be able to tell "guessed a real number, wrong contact" apart
    // from "guessed wrong".
    const order = await tenantDb(tenantId).order.findFirst({
      where: { tenantId, number: orderNumber, OR: [{ email: contact }, { phone: contact }] },
      include: { items: true, events: { orderBy: { createdAt: 'asc' } } },
    });
    if (!order) {
      throw new HttpException({ error: 'ORDER_NOT_FOUND' }, 404);
    }

    // Shipment has no declared relation to Order in schema.prisma (confirmed
    // by reading it directly — just standalone tenantId/orderId/provider/
    // trackingNumber/status/raw fields, no `@relation`), so this is a
    // separate findFirst rather than an `include: {shipment: true}` — same
    // "no unique constraint on orderId" situation orders.service.ts's own
    // `shipped` transition already works around with its own
    // find-then-create-or-update.
    const shipment = await tenantDb(tenantId).shipment.findFirst({ where: { tenantId, orderId: order.id } });
    // `provider`/`trackingNumber` are both nullable in the schema. In the
    // normal flow OrdersService.transition's `shipped` action always sets
    // both together (see orders.service.ts), so a row existing with either
    // null shouldn't happen — but the DTO's `shipment` field is typed
    // non-null-when-present, so a half-populated row is defensively treated
    // as "not shipped yet" (null) rather than emitting null fields inside
    // that supposedly-non-null object type.
    const shipmentDto =
      shipment && shipment.provider && shipment.trackingNumber
        ? { carrier: shipment.provider, trackingNumber: shipment.trackingNumber }
        : null;

    const address = asRecord(order.shippingAddress);
    const departamentoCode = typeof address.departamentoCode === 'string' ? address.departamentoCode : '';
    const shippingCiudad = typeof address.municipioName === 'string' ? address.municipioName : '';
    const shippingDepartamento = DEPARTAMENTOS.find((d) => d.code === departamentoCode)?.name ?? departamentoCode;

    return {
      orderNumber: order.number,
      status: order.status,
      createdAt: order.createdAt.toISOString(),
      items: order.items.map((item) => ({
        nameSnapshot: item.nameSnapshot,
        qty: item.qty,
        priceCentsSnapshot: item.priceCentsSnapshot,
      })),
      totalCents: order.totalCents,
      shippingCiudad,
      shippingDepartamento,
      shipment: shipmentDto,
      events: order.events.map((event) => ({ type: event.type, createdAt: event.createdAt.toISOString() })),
    };
  }
}
