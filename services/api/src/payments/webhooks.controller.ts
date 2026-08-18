import { Controller, HttpCode, HttpException, Inject, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Prisma, platformDb, tenantDb } from '@ventia/db';
import { isOrderReference } from '@ventia/core';
import { WebhookVerificationUnavailableError } from '@ventia/payments';
import type { NormalizedPaymentEvent, PaymentProviderId, RawRequest } from '@ventia/payments';
import { ORDER_CURRENCY, PROVIDERS } from './provider-registry';
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
 * `@@unique([provider, tenantId, eventId])` constraint is the actual
 * idempotency mechanism — a genuine replay of an ALREADY-PROCESSED event hits
 * that constraint's conflict and returns 200 immediately, without ever
 * reaching `markPaid`/the order lookup below. This ordering
 * (insert-then-conflict, not "check then act") is what closes the race between
 * two near-simultaneous deliveries of the same event: both requests attempt
 * the same insert, at most one can win, and the loser is routed by Postgres
 * itself, not by an earlier read this handler did that could itself be racy.
 *
 * ## P3 wave-1 security fixes implemented here (read before editing)
 *
 * Three properties below are load-bearing and were each added in response to a
 * reproduced, working exploit. None of them is defensive decoration:
 *
 *  1. **The amount check (fix 1).** `event.amountCents` MUST equal the
 *     resolved order's `totalCents` before ANY settle, for ALL THREE
 *     providers, whatever the event's status. Every adapter had always
 *     computed `amountCents` and nothing had ever read it. This single check
 *     is what neutralizes both ePayco's unsigned `x_response`/`x_extra1`
 *     (its signature covers neither) and Wompi's undelimited checksum
 *     concatenation (adjacent numeric fields alias, so one genuine
 *     500.000-COP checksum also validates a re-split naming a different
 *     amount and a different order). Removing it silently re-opens both.
 *  2. **Tenant-scoped idempotency (fix 4).** The unique key includes
 *     `tenantId`, because two tenants sharing one gateway merchant account
 *     share its `eventsSecret` and `Order.number` is per-tenant, so ONE
 *     delivery legitimately verifies at both endpoints. Under the old global
 *     key, whichever tenant was hit second — INCLUDING the payment's real
 *     owner — had its delivery permanently swallowed.
 *  3. **The currency check (wave 3).** The amount check above compares a bare
 *     number, so a payment of the same number of minor units in another
 *     currency satisfied it exactly as well as the real one — reproduced live
 *     with a *signed* ePayco `x_currency_code: 'USD'` and a Wompi
 *     `data.currency: 'USD'`. `event.currency` must equal `ORDER_CURRENCY`
 *     before any settle, and a MISSING currency is a rejection, matching what
 *     `reconciliation.worker.ts`'s `checkOrderBinding` had already required on
 *     the other settle path since wave 2. The two paths now enforce one rule.
 *  4. **The `result` string tells the truth (wave 3).** `markPaid`/`markFailed`
 *     report whether they actually transitioned the order, and this handler
 *     records what happened rather than what it attempted. A valid `PAID`
 *     webhook landing on a `CANCELLED`/`EXPIRED` order used to be recorded as
 *     `'confirmed'` while nothing at all changed — a shopper charged, an order
 *     gone, and the one operator-facing audit string saying it went fine. It is
 *     now `'paid_order_not_settleable'` plus the loudest log line in this file.
 *  5. **`processedAt` is checked, not just written (fix 5).** A conflict
 *     short-circuits ONLY when the existing row was actually processed;
 *     otherwise this handler processes it, because the row is written before
 *     the settle and a settle that throws would otherwise leave a genuinely
 *     paid order stuck PENDING forever behind its own idempotency row.
 *
 * ## Known, recorded deviation from `docs/SPEC.md`
 *
 * SPEC.md's M5 bullet requires webhooks be processed "through a queue, never
 * inline"; this handler processes inline. That deviation is unmet, deliberate
 * for now, and recorded in SPEC.md's own bullet rather than left silent —
 * building the queue is out of this change's scope. What makes inline
 * processing survivable in the meantime is exactly fix 5 above: a delivery
 * whose processing throws is not durably marked processed, so the gateway's
 * own retry re-runs it.
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

    // getTenantProviderConfig resolves the tenant via tenantDb(tenantId)'s
    // findUniqueOrThrow — a malformed or genuinely nonexistent :tenantId
    // (garbage/scanner traffic hitting this public, unauthenticated,
    // internet-facing route, or a stale/mistyped webhook URL) throws
    // Prisma's NotFoundError there rather than returning null, which this
    // route must not let propagate as an uncaught 500: caught and folded
    // into the exact same WEBHOOK_INVALID_SIGNATURE 401 the !cfg branch
    // below already uses, for the identical reason that branch documents —
    // an external caller must not be able to distinguish "bad tenantId"
    // from "wrong signature" from "tenant has no provider config".
    let cfg: Awaited<ReturnType<PaymentsService['getTenantProviderConfig']>>;
    try {
      cfg = await this.paymentsService.getTenantProviderConfig(tenantId, providerId);
    } catch {
      cfg = null;
    }
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
      // Two different failures live here, and they must not get the same
      // answer.
      //
      // "I could not COMPLETE the check" — ePayco's verification calls the
      // gateway back mid-way (its confirmation signature covers neither the
      // status nor the reference, so both are re-read from ePayco's own
      // record), and a timeout or 5xx on that call says nothing whatsoever
      // about the signature. Answering it with 401 tells the gateway its
      // signature was wrong about a delivery that may be perfectly valid, and
      // a provider that sees an endpoint 401 repeatedly may DISABLE the
      // webhook — turning a transient network blip into silently unsettled
      // payments. 503 says the true thing: try again.
      //
      // Nothing is durably recorded on either path (the `WebhookEvent` insert
      // is below), so the gateway's retry reprocesses this delivery from
      // scratch, which is exactly what should happen for a transient failure.
      if (err instanceof WebhookVerificationUnavailableError) {
        console.error('[webhooks] could not complete verification — asking the gateway to retry', {
          provider: providerId,
          tenantId,
          error: err.message,
        });
        throw new HttpException({ error: 'WEBHOOK_VERIFICATION_UNAVAILABLE' }, 503);
      }

      // "The check FAILED" — a permanent verdict about the bytes sent. Per
      // spec's explicit AC: the raw payload is still logged even though it's
      // rejected. The order (if it were even resolvable from an
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
    // want it queryable. For Wompi/Mercado Pago, verifyAndParseWebhook above
    // already proved rawBody.toString('utf8') is valid JSON (each does its
    // own JSON.parse internally and throws first if that fails) — but
    // ePayco's real confirmation POST is application/x-www-form-urlencoded,
    // NOT JSON (see epayco.ts's own parseConfirmationBody and its module doc
    // comment's "content-type" finding), so a bare JSON.parse here throws on
    // every genuine ePayco webhook even after a fully valid signature check.
    // Found live during P3b Task 7's smoke test (every real ePayco
    // confirmation 500'd at this exact line) — no existing test caught this
    // because webhooks.test.ts (the only full-HTTP-path webhook controller
    // suite) never exercised ePayco, only Wompi/JSON payloads. Falls back to
    // parsing as a URL-encoded form when the body isn't valid JSON, mirroring
    // epayco.ts's own defensive parse — this is purely for the durable
    // WebhookEvent.payload audit record; verifyAndParseWebhook above has
    // already independently verified and parsed the real fields it needs.
    let parsedPayload: Prisma.InputJsonValue;
    try {
      parsedPayload = JSON.parse(rawBody.toString('utf8')) as Prisma.InputJsonValue;
    } catch {
      const formFields: Record<string, string> = {};
      for (const [key, value] of new URLSearchParams(rawBody.toString('utf8'))) {
        formFields[key] = value;
      }
      parsedPayload = formFields;
    }

    // The tenant-scoped idempotency key, used by every read/write of this
    // event's row below (see class doc comment, fix 4).
    const eventKey = {
      provider_tenantId_eventId: { provider: event.provider, tenantId, eventId: event.eventId },
    } as const;

    /** WHICH order this event turned out to be about, once resolved below.
     *
     * Stays null until the reference has been matched to a real order of this
     * tenant's, so the two branches that never get that far
     * (`invalid_reference`, `order_not_found`) record a null — which is the
     * true answer for them, not a missing one.
     *
     * A closure variable rather than a `markProcessed` parameter on purpose:
     * every terminal branch after the resolution below is about an order that
     * is already known, so threading it through ~6 call sites would add a way
     * to forget it (and a way to pass the wrong one) in exchange for nothing.
     */
    let resolvedOrderId: string | null = null;

    /** Stamps this event's row as processed with an outcome. Every terminal
     * branch below goes through this — including the branches that
     * deliberately do NOT touch the order — because `processedAt` is now a
     * READ value (fix 5): an event left unstamped is one the next gateway
     * retry will reprocess.
     *
     * Also persists the resolved order link. That link is what the admin
     * "pagos por revisar" page reads to tell a merchant WHICH order a
     * `paid_order_not_settleable` charge was about; before this column it had
     * to be re-derived from the stored payload per provider, which could not
     * resolve Mercado Pago at all. Written here, in the same UPDATE as the
     * outcome, so an event's disposition and the order it applied to can never
     * disagree. */
    const markProcessed = async (result: string): Promise<void> => {
      await platformDb.webhookEvent.update({
        where: eventKey,
        data: { processedAt: new Date(), result, orderId: resolvedOrderId },
      });
    };

    // ---- fix 6: validate the reference BEFORE the idempotency row exists.
    //
    // Per the reference-format contract on `NormalizedPaymentEvent.reference`
    // (packages/payments/src/index.ts), `reference` is the plain string form
    // of `Order.number` (e.g. `"42"`), never the `VNT-`-prefixed display
    // string. This used to be handed straight to `Number(...)` further down,
    // which turned a non-numeric reference into `NaN`, which made Prisma
    // throw, which 500'd the request — with the idempotency row ALREADY
    // written, so every subsequent gateway retry short-circuited to 200 and
    // the payment could never be credited. Both sibling routes in
    // `checkout.controller.ts` already guard this explicitly; this one did
    // not.
    //
    // The test is `/^\d+$/`, not `Number(...)`, on purpose: `Number()` maps
    // `" 4242 "`, `"4242.0"`, `"4.242e3"`, `"+4242"` and `"0x1092"` all onto
    // the same order, so a gateway (or an attacker) could name one order in
    // several spellings that this handler would treat as interchangeable
    // while the idempotency key saw them as different events.
    //
    // The upper bound is not decoration either: `Order.number` is a Postgres
    // `int4`, and Prisma rejects an out-of-range value for an Int filter by
    // THROWING — i.e. an all-digits-but-huge reference would 500 the request
    // in exactly the same place, and with exactly the same consequence, as
    // the `NaN` this guard was written for.
    //
    // ---- Two accepted reference forms, since per-order references landed.
    //
    // CURRENT: `Order.reference` — a `vr_`-prefixed random token, globally
    // unique, resolved below without consulting the URL's tenant at all (the
    // resolved order's OWN tenant is then checked against it).
    //
    // TRANSITIONAL: a bare order number, which is what sessions created before
    // that change sent. Those webhooks may still arrive after the deploy, and
    // rejecting them would strand exactly the shopper this codebase works
    // hardest to protect — mid-payment, charged, no order. Resolved the old
    // way (order number scoped to the URL tenant), with the old, weaker
    // guarantee. The window closes on its own: every such order is inside its
    // 15-minute stock hold, so nothing older can still be legitimately in
    // flight, and the two forms can never be confused because a current
    // reference is never all-digits.
    const referenceIsPlainOrderNumber =
      /^\d+$/.test(event.reference) && Number(event.reference) <= 2_147_483_647;
    if (!isOrderReference(event.reference) && !referenceIsPlainOrderNumber) {
      console.error('[webhooks] verified event carries a non-numeric reference — recorded, not processed', {
        provider: providerId,
        tenantId,
        reference: event.reference,
        eventId: event.eventId,
      });
      try {
        await platformDb.webhookEvent.create({
          data: {
            provider: event.provider,
            eventId: event.eventId,
            tenantId,
            payload: parsedPayload,
            // Stamped processed on insert: no retry can make an unparseable
            // reference parseable, so re-running this is pointless work.
            processedAt: new Date(),
            result: 'invalid_reference',
          },
        });
      } catch (err) {
        // A concurrent/duplicate delivery already recorded it — nothing more
        // to do, and certainly not a 500.
        if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
      }
      return { ok: true };
    }

    // WebhookEvent deliberately goes through platformDb, NOT tenantDb.
    //
    // The `ventia_app` role tenantDb switches to holds exactly SELECT on this
    // table, and NOTHING else — no INSERT, no UPDATE, no DELETE. It started
    // with ALL PRIVILEGES revoked
    // (20260723205801_revoke_ventia_app_system_tables); the read was granted
    // back, alone, by 20260815120000_webhook_event_tenant_read, which also
    // enabled a `FOR SELECT` RLS policy scoped to `app.tenant_id` so a tenant
    // sees only its own rows. That grant exists so merchants can be shown
    // their `paid_order_not_settleable` alerts (services/api/src/
    // payment-alerts/) — a read-only surface over what this handler records.
    //
    // So this create MUST stay on platformDb: it is a WRITE, and the write
    // privilege was deliberately not granted back. That asymmetry is the
    // point — this table is the system's own record of what a gateway told
    // us, and no tenant-scoped code can amend it. (AuditLog gets the stricter
    // original treatment, with no grant at all; see catalog/audit.ts's
    // identical platformDb-direct pattern.)
    //
    // `tenantId` on this model is optional precisely because some webhook
    // events are genuinely tenant-less. For THIS controller tenantId is always
    // known from the URL, so it's passed through explicitly on the create call
    // rather than relying on any RLS scoping tenantDb would otherwise add
    // (which doesn't apply to the owner connection anyway).
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
        // ---- fix 5: a conflict alone is NOT proof this event was handled.
        //
        // This row is written BEFORE the settle, so a settle that threw (DB
        // blip, lock timeout) leaves a row with `processedAt: null` behind. The
        // old code returned `{ok:true}` from here unconditionally, so every
        // gateway retry of a genuinely paid order was answered "already
        // handled" and the order stayed PENDING/PENDING forever —
        // `processedAt` was only ever written, never read.
        //
        // So: short-circuit ONLY on a row that really was processed.
        // Otherwise fall through and process it now. Reprocessing is safe —
        // both settle paths (`markPaid`/`markFailed`) run under their own
        // per-order advisory lock with a PENDING/PENDING precondition, so a
        // second pass over an already-settled order is a no-op, and the same
        // is what makes the concurrent-delivery case (the loser of the insert
        // race falling through while the winner is still working) safe.
        const existing = await platformDb.webhookEvent.findUnique({ where: eventKey });
        if (existing?.processedAt) {
          return { ok: true };
        }
        console.error('[webhooks] event was recorded but never processed — reprocessing this delivery', {
          provider: providerId,
          tenantId,
          eventId: event.eventId,
        });
      } else {
        throw err;
      }
    }

    // Resolve which order this event is about.
    //
    // ---- The current path: resolve GLOBALLY, then check the tenant.
    //
    // `Order.reference` is unique across the whole platform, so this lookup
    // does not need — and deliberately does not use — the tenant from the URL
    // to FIND the order. It then asserts the order it found belongs to that
    // tenant.
    //
    // That ordering is the entire fix. Two tenants may share one gateway
    // merchant account, so one signed delivery verifies at either tenant's
    // webhook URL, and `Order.number` is per-tenant. Resolving by number
    // WITHIN the URL's tenant meant a delivery about tenant B's order 1001,
    // POSTed to tenant A's URL, found A's order 1001 — with only the amount
    // check standing between that and settling A's order using B's shopper's
    // money, which stops standing the moment the two totals match. Resolving
    // globally finds B's order wherever the delivery lands, and the tenant
    // check then refuses it rather than settling the wrong one.
    //
    // Goes through `platformDb` precisely BECAUSE it must be able to see
    // another tenant's order — that is what makes the mismatch detectable at
    // all. `tenantDb` would simply return nothing, which looks identical to
    // "no such order" and would silently degrade this into the weaker check.
    let order: Awaited<ReturnType<ReturnType<typeof tenantDb>['order']['findFirst']>> = null;

    if (isOrderReference(event.reference)) {
      const globalMatch = await platformDb.order.findUnique({ where: { reference: event.reference } });
      if (globalMatch && globalMatch.tenantId !== tenantId) {
        // A real order, but not this endpoint's tenant's. Loud, because it is
        // either a misconfigured account-wide confirmation URL or someone
        // replaying another tenant's delivery — and both need a human.
        console.error('[webhooks] verified event names an order belonging to a DIFFERENT tenant — refusing', {
          provider: providerId,
          urlTenantId: tenantId,
          orderTenantId: globalMatch.tenantId,
          eventId: event.eventId,
        });
        await markProcessed('cross_tenant_reference');
        return { ok: true };
      }
      order = globalMatch;
    } else {
      // ---- The transitional path: a bare order number, scoped to the URL's
      // tenant, exactly as before. Proven above to be a plain, in-int4-range
      // integer string, so `Number(...)` can neither produce `NaN` nor a value
      // Prisma refuses for the `Order.number` column. Carries the OLD, weaker
      // guarantee (the amount check alone) and exists only so a session
      // created before per-order references still settles; see the reference
      // guard above for why that window closes on its own.
      order = await tenantDb(tenantId).order.findFirst({
        where: { tenantId, number: Number(event.reference) },
      });
    }

    // Every `markProcessed` call from here down records this link. Set once,
    // immediately after the lookup that establishes it, rather than at each
    // terminal branch — including the branches that go on to REJECT the event
    // (`amount_mismatch`, `currency_mismatch`). Recording the link there is
    // correct and deliberate: "this event named this order and was refused" is
    // a true, useful statement, and the `result` column is what carries the
    // disposition. The alerts page only ever reads rows whose result is
    // `paid_order_not_settleable`, so a rejected event's link is never
    // presented to a merchant as a charge to act on.
    resolvedOrderId = order?.id ?? null;

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
      await markProcessed('order_not_found');
      return { ok: true };
    }

    // ---- fix 1: settlement is bound to the order's own amount.
    //
    // UNCONDITIONAL, for all three providers, whatever the event's status,
    // and BEFORE any settle call. Two separate reproduced exploits collapse
    // into this one comparison:
    //
    //  * ePayco's documented confirmation signature covers only
    //    (x_ref_payco, x_transaction_id, x_amount, x_currency_code) — NOT
    //    `x_response` (the status) and NOT `x_extra1` (which order it is).
    //    Replaying one genuine signed 4-tuple with just those two unsigned
    //    fields rewritten settled a 999.999-COP order with a 100-COP payment.
    //    `epayco.ts` now re-verifies both against ePayco's own record of the
    //    signed transaction, but that lookup is unauthenticated and NOT
    //    merchant-scoped, so it cannot be the only line of defense.
    //  * Wompi's checksum concatenates its signed values with no delimiter,
    //    so `(…, 50000000, 1042)` and `(…, 5000000010, 42)` hash identically:
    //    a genuine 500.000-COP event's checksum also validates a forged
    //    re-split naming a different amount AND a different order. Wompi's
    //    formula is Wompi's, so the hash cannot be changed — this check is
    //    the fix.
    //
    // The amount is the one value every gateway signs (or, for Mercado Pago,
    // reports from its own authenticated payment lookup) and that an attacker
    // cannot vary independently of the money actually moved. An event naming
    // an amount that isn't this order's total is, by definition, not about
    // this order.
    //
    // RESPONSE CHOICE — 200 with a durable `amount_mismatch` record, not a
    // 4xx. Retrying cannot change the outcome: the amount is fixed in a
    // signed payload and the order's total is fixed in our DB, so every retry
    // would mismatch identically. A 4xx buys nothing and costs something —
    // gateways treat non-2xx as "delivery failed" and retry on a schedule
    // (Wompi/ePayco both do), and sustained failures can get an endpoint
    // disabled by the gateway, which would take down legitimate deliveries
    // for the whole tenant. So this mirrors the `order_not_found` branch
    // directly above, which is the same class of event (verified, recorded,
    // not actionable): acknowledge receipt, record the anomaly durably with
    // its own `result` string so it is greppable and auditable, log loudly,
    // and settle nothing.
    if (event.amountCents !== order.totalCents) {
      console.error('[webhooks] verified event amount does not match the order total — refusing to settle', {
        provider: providerId,
        tenantId,
        eventId: event.eventId,
        reference: event.reference,
        orderId: order.id,
        eventAmountCents: event.amountCents,
        orderTotalCents: order.totalCents,
        status: event.status,
      });
      await markProcessed('amount_mismatch');
      return { ok: true };
    }

    // ---- wave 3: the amount is only money once you know its CURRENCY.
    //
    // Wave 2 added a currency term to `TransactionStatusResult`/
    // `ReferenceSearchResult` — the RECONCILIATION path — and its commit
    // message said the currency "now rides on" the settle paths. It did not
    // ride on THIS one: `NormalizedPaymentEvent` had no currency field and the
    // check above compares a bare number, so a payment of the same NUMBER of
    // minor units in another currency satisfied it exactly as well as the real
    // one. Reproduced live on two providers: an ePayco confirmation with a
    // *signed* `x_currency_code: 'USD'` settled a COP order, as did a Wompi
    // event with `data.currency: 'USD'`.
    //
    // Practical exploitability is LOW — all three gateways are COP-only for a
    // Colombian merchant, so an attacker cannot readily produce a USD
    // transaction on the tenant's own account — but the two settle paths
    // disagreeing about what "the amount matches" means is exactly the sort of
    // gap that becomes real the moment one gateway adds multi-currency support.
    //
    // MISSING is a rejection, not a pass, matching `checkOrderBinding`'s rule
    // for the same term: an adapter emits `undefined` only when it genuinely
    // could not read a currency, and treating that as COP would be inventing
    // the very fact under test. It gets its own `result` string because the two
    // mean different things to an operator — `currency_mismatch` is (at worst)
    // an attack or a genuinely foreign payment, `currency_unknown` means a
    // gateway's payload shape changed under us and is a bug to chase.
    //
    // Per-adapter strength of this term is documented on
    // `NormalizedPaymentEvent.currency`: signed for ePayco, authenticated for
    // Mercado Pago, present-but-UNSIGNED for Wompi (its `signature.properties`
    // never covers `transaction.currency`). For Wompi this is therefore a
    // consistency check on honest traffic, not a forgery barrier — the amount
    // check above remains the load-bearing defence there.
    //
    // Response choice is `amount_mismatch`'s, for `amount_mismatch`'s reasons:
    // 200 + a durable, distinct `result` + a loud log, because no retry could
    // ever change the outcome and a 4xx only invites retry storms.
    if (event.currency !== ORDER_CURRENCY) {
      const result = event.currency === undefined ? 'currency_unknown' : 'currency_mismatch';
      console.error('[webhooks] verified event currency is not the order currency — refusing to settle', {
        provider: providerId,
        tenantId,
        eventId: event.eventId,
        reference: event.reference,
        orderId: order.id,
        eventCurrency: event.currency,
        orderCurrency: ORDER_CURRENCY,
        amountCents: event.amountCents,
        status: event.status,
        result,
      });
      await markProcessed(result);
      return { ok: true };
    }

    if (event.status === 'PAID') {
      // ---- wave 3: report what actually happened, not what was attempted.
      //
      // `markPaid` no-ops outside its `status === 'PENDING'` precondition, and
      // this branch used to record `'confirmed'` regardless. So a genuine,
      // fully-verified, amount-matching PAID webhook landing on an order the
      // 15-minute expiry worker had already CANCELLED/EXPIRED answered 200,
      // durably recorded `confirmed`, changed nothing and wrote zero
      // `OrderEvent`s. The shopper has been charged and has no order, and the
      // one operator-facing string in the system said it was confirmed —
      // defeating the entire purpose of this column, and hiding precisely the
      // failure the declined-then-retry work exists to make visible.
      const settled = await this.paymentsService.markPaid(
        tenantId,
        order.id,
        providerId,
        event.providerRef,
      );
      if (!settled) {
        // Deliberately the loudest log in this file. This is not an anomaly to
        // count — it is money taken from a shopper who has nothing to show for
        // it, and it needs a human. Greppable two ways: this message, and
        // `SELECT * FROM "WebhookEvent" WHERE result = 'paid_order_not_settleable'`.
        console.error(
          '[webhooks] PAID EVENT COULD NOT BE APPLIED — the shopper was charged but the order is no longer settleable; needs manual review',
          {
            provider: providerId,
            tenantId,
            eventId: event.eventId,
            reference: event.reference,
            orderId: order.id,
            orderStatus: order.status,
            orderPaymentStatus: order.paymentStatus,
            amountCents: event.amountCents,
            providerRef: event.providerRef,
          },
        );
      }
      await markProcessed(settled ? 'confirmed' : 'paid_order_not_settleable');
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
      const applied = await this.paymentsService.markFailed(
        tenantId,
        order.id,
        providerId,
        event.providerRef,
      );
      if (!applied) {
        // The benign half of the same honesty fix: a late FAILED event for an
        // earlier attempt on an order a later attempt already settled (or on a
        // cancelled one) costs nobody money — `markFailed`'s precondition
        // refusing it is the CORRECT outcome, and deliberately not widened.
        // Only the record changes: `'failed'` claimed a transition that never
        // happened. Logged at a normal level, not the alarm above.
        console.error('[webhooks] FAILED event applied nothing — the order was no longer in a failable state', {
          provider: providerId,
          tenantId,
          eventId: event.eventId,
          orderId: order.id,
          orderStatus: order.status,
          orderPaymentStatus: order.paymentStatus,
        });
      }
      await markProcessed(applied ? 'failed' : 'failed_not_applied');
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
      await markProcessed(`noop_${event.status.toLowerCase()}`);
    }

    return { ok: true };
  }
}
