import { Controller, Get, Inject, Query, UseGuards } from '@nestjs/common';
import { AdminSessionGuard } from '../admin/admin-session.guard';
import { AdminSession, type AdminSessionContext } from '../admin/roles.decorator';
import { PaymentAlertsService, type PaymentAlertListQuery } from './payment-alerts.service';

/**
 * The merchant-facing surface for payments that arrived but could not be
 * applied to their order (`WebhookEvent.result = 'paid_order_not_settleable'`).
 * Read-only: this controller lists what the settle path already recorded and
 * has no write route at all.
 *
 * ## Guards
 *
 * `AdminSessionGuard` with NO `@Roles()`, i.e. owner AND staff — the same
 * gate `orders.controller.ts` uses, and for the same reason: this is
 * operational fulfilment work ("a customer paid and has no order — call them,
 * refund them"), exactly the kind of thing a shop's staff handle, not
 * owner-only account administration like `staff.controller.ts` /
 * `settings.controller.ts`. Gating it to owners would mean the person
 * actually answering the customer's WhatsApp cannot see why the customer is
 * angry. The guard rejects any session without a tenantId before a handler
 * runs, so `session.tenantId` is non-null throughout.
 *
 * ## Why there is no `POST .../:id/dismiss`
 *
 * Deliberate, and argued rather than forgotten. `WebhookEvent` is the
 * system's own immutable record of what a gateway told us; `ventia_app` holds
 * SELECT on it and nothing else (migration 20260815120000). A one-click
 * "dismiss" on a row that means "a shopper was charged and has no order"
 * would let anyone with an admin session make a real financial discrepancy
 * disappear, with no actor, no reason and no trail — which is a worse failure
 * than the nag it removes. If an acknowledgement is added later it should be
 * an append-only, tenant-owned `WebhookEventReview` row recording WHO
 * reviewed it and WHAT they did (refunded / order recreated), and reviewed
 * items should move to a "Revisados" section of the same page rather than
 * vanish. See the change's report for the full argument on both sides.
 */
@Controller('v1/admin/payment-alerts')
@UseGuards(AdminSessionGuard)
export class PaymentAlertsController {
  // Explicit @Inject: esbuild (vitest's default TS transform) does not emit
  // TypeScript's `design:paramtypes` decorator metadata, so Nest's implicit
  // constructor-injection cannot resolve PaymentAlertsService by type alone —
  // same caution as every other controller in this codebase.
  constructor(@Inject(PaymentAlertsService) private readonly alerts: PaymentAlertsService) {}

  @Get()
  async list(@AdminSession() session: AdminSessionContext, @Query() query: PaymentAlertListQuery) {
    return this.alerts.list(session.tenantId, query);
  }
}
