import { Body, Controller, Get, HttpException, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import type { WebhookEventReviewAction } from '@ventia/db';
import { AdminSessionGuard } from '../admin/admin-session.guard';
import { AdminSession, type AdminSessionContext } from '../admin/roles.decorator';
import { assertUuidOr404 } from '../catalog/uuid';
import { PaymentAlertsService, type PaymentAlertListQuery } from './payment-alerts.service';

/** Every action a merchant may record, mirroring the
 * `WebhookEventReviewAction` enum in schema.prisma. Listed explicitly rather
 * than derived, so adding a value to the database enum is a deliberate choice
 * about what the API accepts too. */
const REVIEW_ACTIONS: readonly WebhookEventReviewAction[] = [
  'refunded',
  'order_taken_again',
  'no_action_needed',
  'other',
  'reopened',
];

/** Bounds the optional free-text note. Long enough for a refund receipt id
 * and a sentence of context; short enough that this append-only, never-
 * prunable table cannot be used as storage. */
const MAX_NOTE_LENGTH = 500;

/** Hand-rolled, same convention as orders.controller.ts's parseShippedBody
 * (no direct `zod` import in @ventia/api — see catalog/parse.ts for why). */
function parseReviewBody(body: unknown): { action: WebhookEventReviewAction; note: string | null } {
  const b = (body ?? {}) as Record<string, unknown>;

  if (typeof b.action !== 'string' || !REVIEW_ACTIONS.includes(b.action as WebhookEventReviewAction)) {
    throw new HttpException(
      {
        error: 'VALIDATION_FAILED',
        details: { action: `action debe ser uno de: ${REVIEW_ACTIONS.join(', ')}` },
      },
      400,
    );
  }

  if (b.note !== undefined && b.note !== null && typeof b.note !== 'string') {
    throw new HttpException({ error: 'VALIDATION_FAILED', details: { note: 'note debe ser texto' } }, 400);
  }
  const note = typeof b.note === 'string' ? b.note.trim() : '';
  if (note.length > MAX_NOTE_LENGTH) {
    throw new HttpException(
      { error: 'VALIDATION_FAILED', details: { note: `note no puede superar ${MAX_NOTE_LENGTH} caracteres` } },
      400,
    );
  }

  return { action: b.action as WebhookEventReviewAction, note: note.length > 0 ? note : null };
}

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
 * ## `POST :id/review` is a review, NOT a dismiss
 *
 * The original build shipped no acknowledgement at all, on two arguments. One
 * of them was wrong: "these events are rare". ePayco supports PSE, whose
 * `Pendiente` -> `Aceptada` progression is asynchronous by design
 * (packages/payments/src/epayco.ts), and the stock reservation TTL is 15
 * minutes — a bank transfer outrunning a 15-minute hold is structurally
 * expected. A merchant with steady PSE volume accumulates a monotonically
 * growing list and a permanent banner, which trains precisely the
 * skip-that-region habit that defeats the alarm on the day a real one lands.
 *
 * The other argument was right, and is what this endpoint is shaped around: a
 * one-click hide on a real financial discrepancy, with no actor and no reason,
 * is a worse failure than the nag. So this route does not hide anything. It
 * APPENDS a `WebhookEventReview` row recording who acted and what they did,
 * the alert moves to the page's "Revisados" section instead of vanishing, and
 * `WebhookEvent` itself is not touched — it stays SELECT-only for tenants
 * (migration 20260815120000), still the system's own immutable statement.
 *
 * There is no `DELETE` and no `PATCH` counterpart, and there cannot be one:
 * `ventia_app` has UPDATE/DELETE revoked on `WebhookEventReview` and its RLS
 * policies are SELECT/INSERT only (migration 20260815140000). A review filed
 * against the wrong row is corrected by posting `action: 'reopened'`, which
 * appends an undo and returns the alert to the banner — the mistake and its
 * correction both stay on the record.
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
    try {
      return await this.alerts.list(session.tenantId, query);
    } catch (err) {
      // Logged HERE, loudly, rather than left to Nest's default handler.
      //
      // The admin shell's banner is the only unmissable surface this feature
      // has, and it deliberately renders nothing when it cannot load — so a
      // persistent failure of this endpoint (the SELECT grant missing because
      // migration 20260815120000 was never applied in an environment, say)
      // makes the alarm silently disappear while the rest of the app looks
      // completely healthy. The client-side half of that gap is fixed in the
      // banner (it surfaces a quiet notice on a non-network status); this half
      // makes sure the cause is greppable server-side, with the tenant, rather
      // than only inferable from a 500 count.
      console.error('[payment-alerts] failed to list payment alerts', {
        tenantId: session.tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  /**
   * Records what this merchant did about one alert. Append-only — see the
   * class doc comment. Returns the review that was just filed and whether the
   * alert is now pending again (`action: 'reopened'`).
   */
  @Post(':id/review')
  async review(
    @AdminSession() session: AdminSessionContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    // A non-uuid id is a 404, not a 500 from Postgres refusing the cast —
    // same helper every other :id route in this codebase uses.
    assertUuidOr404(id);
    const input = parseReviewBody(body);
    return this.alerts.review(
      { tenantId: session.tenantId, userId: session.userId, email: session.email },
      id,
      input,
    );
  }
}
