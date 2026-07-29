import { Controller, HttpCode, HttpException, Inject, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Prisma, platformDb, tenantDb } from '@ventia/db';
import type { NormalizedPaymentEvent, PaymentProviderId, RawRequest } from '@ventia/payments';
import { PROVIDERS } from './provider-registry';
import { PaymentsService } from './payments.service';

/**
 * Machine-to-machine payment-gateway webhook receiver.
 * `POST /webhooks/payments/:provider/:tenantId`.
 *
 * Deliberately NO `AdminSessionGuard`/`PublicTenantGuard` — this is never a
 * browser request, so there's no session cookie or `Host`/`x-tenant-domain`
 * header to resolve a tenant from. The tenant comes straight from the URL
 * path segment, which the gateway was configured (at credential-save time,
 * out of band) to POST to.
 *
 * Relies on `services/api/src/main.ts`'s path-scoped `express.raw()`
 * middleware for `/webhooks/*`, mounted BEFORE the global `express.json()` —
 * `req.body` on this route is therefore the exact, unparsed request-body
 * `Buffer`, which `WompiProvider.verifyAndParseWebhook`'s checksum
 * verification needs byte-for-byte (see main.ts's comment for why a
 * JSON-parsed-then-reserialized body would break the checksum even for a
 * genuinely untampered payload).
 *
 * Idempotency (design decision 9 / spec AC "replaying the same webhook 10x
 * results in exactly one state transition"): a `WebhookEvent` row is
 * inserted FIRST, before any `Order` mutation. `WebhookEvent`'s
 * `@@unique([provider, eventId])` constraint is the actual idempotency
 * mechanism — a genuine replay hits that constraint's conflict and returns
 * 200 immediately, without ever reaching `markPaid`/the order lookup below.
 * This ordering (insert-then-conflict, not "check then act") is what closes
 * the race between two near-simultaneous deliveries of the same event: both
 * requests attempt the same insert, at most one can win, and the loser is
 * routed to the idempotent-no-op branch by Postgres itself, not by an
 * earlier read this handler did that could itself be racy.
 */
@Controller('webhooks/payments')
export class WebhooksController {
  // Explicit @Inject: esbuild (vitest's TS transform) doesn't emit
  // `design:paramtypes` metadata, so Nest's implicit constructor-injection
  // by type alone can't resolve PaymentsService here — same caution as
  // every other controller in this codebase (see settings.controller.ts).
  constructor(@Inject(PaymentsService) private readonly paymentsService: PaymentsService) {}

  @Post(':provider/:tenantId')
  @HttpCode(200)
  async handle(
    @Param('provider') providerParam: string,
    @Param('tenantId') tenantId: string,
    @Req() req: Request,
  ): Promise<{ ok: true }> {
    // `:provider` not a recognized PaymentProviderId at all — TypeScript
    // can't narrow a route param automatically, so this is a plain runtime
    // membership check against the same PROVIDERS map provider-registry.ts's
    // getProvider() uses. Deliberately NOT calling getProvider() itself for
    // this check: getProvider() throws 400 PAYMENT_PROVIDER_NOT_CONFIGURED
    // for "valid id, not implemented yet" (a merchant-facing condition, used
    // by checkout/test-connection) — a fundamentally different situation
    // from "this URL path segment isn't even a real provider id" (an
    // external, potentially malicious/malformed webhook URL), which is what
    // this route needs: 404 WEBHOOK_UNKNOWN_PROVIDER.
    const provider = PROVIDERS[providerParam as PaymentProviderId];
    if (!provider) {
      throw new HttpException({ error: 'WEBHOOK_UNKNOWN_PROVIDER' }, 404);
    }
    const providerId = providerParam as PaymentProviderId;

    // req.body is a raw Buffer here (see class doc comment) — never a
    // parsed object, thanks to main.ts's path-scoped express.raw() for
    // /webhooks/*. Defensive Buffer.isBuffer check + fallback exists only so
    // a misconfigured middleware ordering fails loudly (JSON.parse below
    // throws, verifyAndParseWebhook rejects, 401) rather than crashing this
    // handler with a TypeError.
    const rawBody = Buffer.isBuffer(req.body)
      ? req.body
      : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {}), 'utf8');

    const cfg = await this.paymentsService.getTenantProviderConfig(tenantId, providerId);
    if (!cfg) {
      // A webhook arriving for a provider this tenant never configured
      // credentials for is a genuinely anomalous/suspicious event — there is
      // no config to even attempt verification against, so this is treated
      // identically to a signature failure (401 WEBHOOK_INVALID_SIGNATURE),
      // NOT a distinct error code/status. A different response here would
      // let an external caller distinguish "wrong signature" from "this
      // tenant doesn't use this provider" — a real information leak about a
      // merchant's payment setup that this endpoint must not expose.
      console.error('[webhooks] rejected: tenant has no provider config for this provider', {
        provider: providerId,
        tenantId,
      });
      throw new HttpException({ error: 'WEBHOOK_INVALID_SIGNATURE' }, 401);
    }

    const rawRequest: RawRequest = {
      headers: req.headers as Record<string, string | string[] | undefined>,
      rawBody,
    };

    let event: NormalizedPaymentEvent;
    try {
      event = await provider.verifyAndParseWebhook(rawRequest, cfg);
    } catch (err) {
      // Per spec's explicit AC: the raw payload is still logged even though
      // it's rejected. The order (if it were even resolvable from an
      // unverified/tampered payload) is NOT touched — no attempt is made to
      // parse a `reference` out of this payload for any side effect; the
      // only thing that happens here is a log line and a 401.
      console.error('[webhooks] signature verification failed', {
        provider: providerId,
        tenantId,
        rawBody: rawBody.toString('utf8'),
        error: err instanceof Error ? err.message : String(err),
      });
      throw new HttpException({ error: 'WEBHOOK_INVALID_SIGNATURE' }, 401);
    }

    // Re-parse the SAME bytes verifyAndParseWebhook just verified, purely to
    // get a JSON-serializable value for the Json column below — Prisma's
    // Json column can't take a raw Buffer/string-of-JSON directly the way we
    // want it queryable. This can't itself throw: verifyAndParseWebhook
    // above already proved rawBody.toString('utf8') is valid JSON (it does
    // its own JSON.parse internally and throws first if that fails).
    const parsedPayload = JSON.parse(rawBody.toString('utf8')) as Prisma.InputJsonValue;

    // WebhookEvent deliberately goes through platformDb, NOT tenantDb.
    // WebhookEvent has no RLS policy at all — the `ventia_app` role tenantDb
    // switches to has ALL PRIVILEGES explicitly REVOKED on this table
    // (packages/db/prisma/migrations/20260723205801_revoke_ventia_app_system_tables),
    // the same treatment AuditLog gets (see catalog/audit.ts's identical
    // platformDb-direct pattern) — both are the system's own record of
    // events, not a tenant-owned catalog/order row, and `tenantId` on this
    // model is optional precisely because some webhook events are
    // genuinely tenant-less. For THIS controller tenantId is always known
    // from the URL, so it's passed through explicitly on the create call
    // rather than relying on any RLS scoping tenantDb would otherwise add
    // (which isn't available here anyway).
    try {
      await platformDb.webhookEvent.create({
        data: {
          provider: event.provider,
          eventId: event.eventId,
          tenantId,
          payload: parsedPayload,
          processedAt: null,
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        // The single most important correctness property in this task: a
        // genuine replay of an event already durably recorded (either fully
        // processed already, or a near-simultaneous concurrent delivery
        // currently being processed) hits this unique-constraint conflict
        // and returns 200 immediately — WITHOUT calling markPaid, WITHOUT
        // touching the order, WITHOUT writing a second WebhookEvent row.
        // This insert happened BEFORE any order mutation below, so this
        // catch block is reached before any of that could have run twice.
        return { ok: true };
      }
      throw err;
    }

    // From here on this is a genuinely NEW event (the insert above
    // succeeded) — resolve which of this tenant's orders it's about.
    // Per the reference-format contract established on
    // NormalizedPaymentEvent.reference (packages/payments/src/index.ts):
    // `reference` is the plain string form of `Order.number` (e.g.
    // `String(order.number)`), NOT the `VNT-`-prefixed display string used
    // in emails/UI — so this parses it back with a plain `Number(...)`, not
    // any prefix-stripping logic.
    const order = await tenantDb(tenantId).order.findFirst({
      where: { tenantId, number: Number(event.reference) },
    });

    if (!order) {
      // A validly-authenticated event whose reference doesn't match any of
      // this tenant's orders is an anomalous state, but NOT a signature
      // failure — the event WAS durably recorded above, there's just
      // nothing to act on. Still 200: this endpoint's contract with the
      // gateway is "I received and durably recorded this", not "I found
      // something to do with it".
      console.error('[webhooks] verified event references no known order for this tenant', {
        provider: providerId,
        tenantId,
        reference: event.reference,
        eventId: event.eventId,
      });
      await platformDb.webhookEvent.update({
        where: { provider_eventId: { provider: event.provider, eventId: event.eventId } },
        data: { processedAt: new Date(), result: 'order_not_found' },
      });
      return { ok: true };
    }

    if (event.status === 'PAID') {
      await this.paymentsService.markPaid(tenantId, order.id, providerId, event.providerRef);
      await platformDb.webhookEvent.update({
        where: { provider_eventId: { provider: event.provider, eventId: event.eventId } },
        data: { processedAt: new Date(), result: 'confirmed' },
      });
    } else if (event.status === 'FAILED') {
      // Design decision (spec + design doc decision 3's neighboring intent):
      // a failed payment ATTEMPT does not cancel the order or touch stock —
      // the shopper may retry a different payment method, or retry Wompi's
      // checkout again for the same order. Routed through
      // PaymentsService.markFailed (same advisory-lock-per-order + PENDING/
      // PENDING precondition guard as markPaid), NOT a bare tenantDb update:
      // review found the original bare-update version here could silently
      // overwrite an already-CONFIRMED/PAID order's paymentStatus back to
      // FAILED if a late-arriving webhook for an earlier failed attempt on
      // the same order (a shopper retry) was processed after a later
      // attempt's PAID webhook already confirmed it — markFailed's
      // precondition makes that a safe no-op instead.
      await this.paymentsService.markFailed(tenantId, order.id, providerId, event.providerRef);
      await platformDb.webhookEvent.update({
        where: { provider_eventId: { provider: event.provider, eventId: event.eventId } },
        data: { processedAt: new Date(), result: 'failed' },
      });
    } else {
      // PENDING / EXPIRED: the other two NormalizedStatus values. Wompi's
      // own real transaction vocabulary never actually produces EXPIRED
      // (see wompi.ts's mapStatus doc comment) and PENDING is Wompi's
      // initial, non-final transaction state — a webhook notifying us that a
      // transaction is merely still pending carries no new information this
      // system should act on (the order is already PENDING/PENDING from
      // checkout). Rather than let an unhandled status value silently no-op
      // without being recorded, this still durably records the event with a
      // matching `result` string and logs it — safe default: no order
      // mutation, but nothing about receiving it is lost.
      console.error('[webhooks] verified event has a non-actionable status — recorded, no order mutation', {
        provider: providerId,
        tenantId,
        status: event.status,
        eventId: event.eventId,
      });
      await platformDb.webhookEvent.update({
        where: { provider_eventId: { provider: event.provider, eventId: event.eventId } },
        data: { processedAt: new Date(), result: `noop_${event.status.toLowerCase()}` },
      });
    }

    return { ok: true };
  }
}
