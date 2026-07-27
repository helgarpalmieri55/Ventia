import { Body, Controller, Get, HttpException, Inject, Param, Patch, Query, UseGuards } from '@nestjs/common';
import { AdminSessionGuard } from '../admin/admin-session.guard';
import { AdminSession, type AdminSessionContext } from '../admin/roles.decorator';
import { assertUuidOr404 } from '../catalog/uuid';
import {
  OrdersService,
  type CancelPayload,
  type OrderListQuery,
  type ShippedPayload,
} from './orders.service';

// Small hand-rolled validators for these two action bodies, same convention
// as cart.controller.ts's parseAddItemBody (no direct `zod` import in
// @ventia/api — see that file's doc comment for why): confirm/preparing/
// delivered take no body at all, so only `shipped` and `cancel` need one.
function parseShippedBody(body: unknown): ShippedPayload {
  const b = (body ?? {}) as Record<string, unknown>;
  const details: Record<string, string> = {};
  if (typeof b.carrier !== 'string' || b.carrier.trim().length === 0) {
    details.carrier = 'carrier es requerido';
  }
  if (typeof b.trackingNumber !== 'string' || b.trackingNumber.trim().length === 0) {
    details.trackingNumber = 'trackingNumber es requerido';
  }
  if (Object.keys(details).length > 0) {
    throw new HttpException({ error: 'VALIDATION_FAILED', details }, 400);
  }
  return { carrier: b.carrier as string, trackingNumber: b.trackingNumber as string };
}

function parseCancelBody(body: unknown): CancelPayload {
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.reason !== 'string' || b.reason.trim().length === 0) {
    throw new HttpException({ error: 'VALIDATION_FAILED', details: { reason: 'reason es requerido' } }, 400);
  }
  return { reason: b.reason };
}

// AdminSessionGuard rejects any session without a tenantId before a request
// reaches here (see admin-session.guard.ts), so tenantId is guaranteed
// non-null in every handler below. No @Roles() is set on this controller:
// order fulfillment (confirm/preparing/shipped/delivered/cancel) is
// operational work shared by both 'owner' and 'staff' — see the design
// doc's decision #1 — matching products.controller.ts's same convention
// rather than staff.controller.ts's/settings.controller.ts's owner-only gate.
//
// One route per action (confirm/preparing/shipped/delivered/cancel) rather
// than a generic `PATCH :id/status` with an action field, matching
// staff.controller.ts's existing invite/revoke-by-route convention.
@Controller('v1/admin/orders')
@UseGuards(AdminSessionGuard)
export class OrdersController {
  // Explicit @Inject: esbuild (vitest's default TS transform) does not emit
  // TypeScript's `design:paramtypes` decorator metadata, so Nest's implicit
  // constructor-injection cannot resolve OrdersService by type alone (same
  // caution as every other controller in this codebase).
  constructor(@Inject(OrdersService) private readonly orders: OrdersService) {}

  @Get()
  async list(@AdminSession() session: AdminSessionContext, @Query() query: OrderListQuery) {
    return this.orders.list(session.tenantId, query);
  }

  @Get(':id')
  async findOne(@AdminSession() session: AdminSessionContext, @Param('id') id: string) {
    assertUuidOr404(id);
    return this.orders.findOne(session.tenantId, id);
  }

  @Patch(':id/confirm')
  async confirm(@AdminSession() session: AdminSessionContext, @Param('id') id: string) {
    assertUuidOr404(id);
    return this.orders.transition(session.tenantId, id, 'confirm', undefined, session.userId);
  }

  @Patch(':id/preparing')
  async preparing(@AdminSession() session: AdminSessionContext, @Param('id') id: string) {
    assertUuidOr404(id);
    return this.orders.transition(session.tenantId, id, 'preparing', undefined, session.userId);
  }

  @Patch(':id/shipped')
  async shipped(
    @AdminSession() session: AdminSessionContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    assertUuidOr404(id);
    const input = parseShippedBody(body);
    return this.orders.transition(session.tenantId, id, 'shipped', input, session.userId);
  }

  @Patch(':id/delivered')
  async delivered(@AdminSession() session: AdminSessionContext, @Param('id') id: string) {
    assertUuidOr404(id);
    return this.orders.transition(session.tenantId, id, 'delivered', undefined, session.userId);
  }

  @Patch(':id/cancel')
  async cancel(
    @AdminSession() session: AdminSessionContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    assertUuidOr404(id);
    const input = parseCancelBody(body);
    return this.orders.transition(session.tenantId, id, 'cancel', input, session.userId);
  }
}
