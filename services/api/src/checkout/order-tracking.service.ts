import { Injectable } from '@nestjs/common';
import { Prisma, tenantDb, type OrderStatus } from '@ventia/db';
import { DEPARTAMENTOS } from '@ventia/core';

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

/**
 * The one implementation of "look up an order by number AND a matching
 * contact", shared by the public tracking endpoint
 * (`GET /v1/storefront/orders/track`) and the AI agent's `get_order_status`
 * tool.
 *
 * ## Why this is a service rather than two copies
 *
 * It was inlined in the controller, correctly, while it had one caller. It now
 * has two, and what it encodes is a security rule rather than a query: the
 * double factor, and — just as load-bearing — the fact that "no such order"
 * and "real order, wrong contact" must be indistinguishable to the caller.
 * Two copies of a rule like that is how one of them quietly stops matching the
 * other. The agent surface makes this sharper, not softer: the tool is driven
 * by whatever a shopper typed into a chat box, so it is at least as exposed as
 * the HTTP route.
 *
 * Returns `null` rather than throwing. The controller maps that to its 404;
 * the agent tool turns it into a sentence the model can say. Throwing an HTTP
 * exception here would force the agent path to catch and translate a transport
 * concern it has nothing to do with.
 */
@Injectable()
export class OrderTrackingService {
  async track(tenantId: string, orderNumberRaw: string, contact: string): Promise<OrderTrackingDto | null> {
    const trimmedContact = contact.trim();
    if (trimmedContact.length === 0) return null;

    // Prisma REJECTS a NaN Int filter by throwing, so a non-numeric order
    // number has to be caught here rather than handed to the query. Folded
    // into the same null (→ not found) outcome rather than a distinct error:
    // from the caller's perspective a malformed order number and a genuinely
    // nonexistent one are the same answer, and keeping them identical is part
    // of the indistinguishability property below.
    const orderNumber = parseInt(orderNumberRaw, 10);
    if (!Number.isInteger(orderNumber)) return null;

    // The `OR: [{email}, {phone}]` clause is folded into this SAME query
    // (rather than looking the order up first and checking contact after) so
    // that "order exists but wrong contact" and "order doesn't exist" take the
    // identical code path — no separate branch exists that could observably
    // differ (timing, shape, or otherwise) between the two. That matters
    // because both callers are unauthenticated: an attacker enumerating order
    // numbers must not be able to tell "guessed a real number, wrong contact"
    // apart from "guessed wrong".
    const order = await tenantDb(tenantId).order.findFirst({
      where: { tenantId, number: orderNumber, OR: [{ email: trimmedContact }, { phone: trimmedContact }] },
      include: { items: true, events: { orderBy: { createdAt: 'asc' } } },
    });
    if (!order) return null;

    // Shipment has no declared relation to Order in schema.prisma, so this is
    // a separate findFirst rather than an `include` — same "no unique
    // constraint on orderId" situation orders.service.ts's own `shipped`
    // transition already works around.
    const shipment = await tenantDb(tenantId).shipment.findFirst({ where: { tenantId, orderId: order.id } });
    // `provider`/`trackingNumber` are both nullable. In the normal flow
    // OrdersService.transition's `shipped` action always sets both together,
    // so a row with either null shouldn't happen — but the DTO types this
    // object non-null-when-present, so a half-populated row is defensively
    // treated as "not shipped yet".
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
