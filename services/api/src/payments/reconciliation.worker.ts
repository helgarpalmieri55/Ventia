import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import Redis from 'ioredis';
import { platformDb } from '@ventia/db';
import type {
  PaymentProvider,
  PaymentProviderId,
  TenantProviderConfig,
  TransactionStatusResult,
} from '@ventia/payments';
import { PaymentsService } from './payments.service';
import { ORDER_CURRENCY, getProvider } from './provider-registry';

/** How long an online-payment order must have existed before reconciliation
 * will look at it (design decision 4). DELIBERATELY shorter than the existing
 * 15-minute stock-reservation TTL (`checkout.service.ts` sets
 * `stockReservedUntil = now + 15min`; `stock-reservation.worker.ts` expires it)
 * and NOT the spec's rough draft-time "30 min" figure.
 *
 * The ordering is the whole point and must not be changed without re-reading
 * design decision 4: at 30 minutes the already-shipped expiry worker would have
 * fired first (at 15 min), restocking the product, cancelling the order and
 * setting `paymentStatus: EXPIRED` — so a later reconciliation pass would
 * either find nothing (a cancelled order no longer matches) or would have to
 * UN-cancel an order and RE-decrement stock that may already have been sold to
 * someone else. A 5-minute floor with a 2-minute cadence instead gives every
 * order roughly five reconciliation attempts BEFORE the expiry worker would
 * ever consider it. */
const RECONCILE_MIN_AGE_MS = 5 * 60_000;

/** Repeat cadence (design decision 4) — five attempts inside the window
 * between the 5-minute floor and the 15-minute stock release. */
const SWEEP_INTERVAL_MS = 2 * 60_000;

/** Hard ceiling on how many orders ONE sweep will look at (P3c review
 * follow-up). Exported so the test asserts the real, shared value rather than
 * a copy of it.
 *
 * Why bound it at all: each candidate costs ONE SEQUENTIAL outbound gateway
 * call, and there is no per-order timeout. An unbounded `findMany` therefore
 * means a platform-wide gateway outage turns one sweep into N sequential
 * hanging HTTP calls — while the 2-minute repeat keeps firing more sweeps on
 * top of it.
 *
 * Why 250 specifically:
 *  - The candidate set is bounded in PRACTICE, not just in theory: an order
 *    only qualifies between the 5-minute floor and the moment the (unmodified)
 *    15-minute stock-reservation expiry worker takes it out of
 *    `PENDING`/`stockReservedUntil IS NOT NULL`. So the steady-state backlog is
 *    roughly "unpaid online orders created platform-wide in a ~10-minute
 *    window" — 250 is comfortably above that for this system's size, meaning
 *    the limit is inert in normal operation and only bites during a genuine
 *    pile-up.
 *  - It also keeps the worst case inside the cadence: 250 sequential calls at a
 *    typical few-hundred-ms gateway latency stays under the 2-minute
 *    `SWEEP_INTERVAL_MS`, so sweeps don't routinely overlap themselves.
 *
 * Truncation is safe, not lossy: the query is ordered OLDEST-FIRST, so each
 * run drains the front of the backlog and whatever it didn't reach is simply
 * picked up by the next run 2 minutes later (and, failing that, still falls
 * through to the 15-minute expiry worker exactly as an unreconcilable order
 * already does). A bounded query with a NON-deterministic order would be the
 * dangerous version — it could re-read the same arbitrary page forever and
 * starve the rest. */
export const RECONCILE_BATCH_LIMIT = 250;

const QUEUE_NAME = 'payment-reconciliation';
const JOB_NAME = 'sweep';
/** Fixed, stable id for the REPEATABLE JOB REGISTRATION (not a per-run job id
 * — BullMQ generates those), for the same reason
 * `stock-reservation.worker.ts` uses one: calling `start()` again after a
 * process restart re-registers the SAME schedule instead of accumulating a
 * second one that would double the sweep frequency. */
const REPEAT_JOB_ID = 'payment-reconciliation-sweep';

/** The subset of `PaymentsService` this sweep uses. Narrow on purpose: this job
 * may ONLY settle orders through the two already-built, already-reviewed
 * transitions — it never writes to `Order` itself, and in particular never
 * expires/cancels/restocks anything (design decision 7; the unmodified
 * stock-reservation expiry worker remains the only thing that ever does that). */
type SettleService = Pick<PaymentsService, 'getTenantProviderConfig' | 'markPaid' | 'markFailed'>;

/** Injection seam for the provider registry, defaulting to the real one — lets
 * `test/reconciliation-worker.test.ts` script gateway responses without any
 * outbound HTTP, exactly as `webhooks.test.ts`/`payments-service.test.ts`
 * already fake only the gateway edge while running real Postgres, real
 * encryption and real advisory locks. */
export type ProviderResolver = (id: PaymentProviderId) => PaymentProvider;

const PAYMENT_PROVIDER_IDS: readonly PaymentProviderId[] = ['wompi', 'mercadopago', 'epayco'];

/** `Order.paymentProvider` is a plain nullable `String` column, so a value read
 * from it is not automatically a `PaymentProviderId`. Returns `null` for
 * anything unrecognized (including `'cod'`) rather than casting. */
function asPaymentProviderId(value: string | null): PaymentProviderId | null {
  return value !== null && (PAYMENT_PROVIDER_IDS as readonly string[]).includes(value)
    ? (value as PaymentProviderId)
    : null;
}

interface CandidateOrder {
  id: string;
  tenantId: string;
  number: number;
  totalCents: number;
  paymentProvider: string | null;
  providerRef: string | null;
  providerRefSource: string | null;
}

// `ORDER_CURRENCY` (the ISO-4217 code every order here is priced in) used to be
// declared locally in this file. It moved to `provider-registry.ts` when the
// WEBHOOK settle path started enforcing the same rule (wave 3): the two paths
// were found disagreeing about what "the amount matches" means, and two copies
// of the constant is exactly how they would drift again.

/**
 * The providers whose transaction-status lookup is bound to the CALLING
 * MERCHANT'S OWN ACCOUNT, and therefore whose "this transaction is PAID"
 * answer says something about money that reached THIS tenant.
 *
 * ## What was actually established (P3 wave-2 FIX 3), per provider
 *
 * - **`mercadopago` — account-scoped. IN.** `getTransactionStatus` /
 *   `searchByReference` authenticate with `cfg.privateKey`, MP's private
 *   ACCESS TOKEN. A payment resource is readable only by the account that
 *   owns it, so a truthful `approved` from that call is necessarily about a
 *   payment into this tenant's own MP account.
 *
 * - **`epayco` — NOT account-scoped. OUT.** `EpaycoProvider.getTransactionStatus`
 *   ignores its `cfg` entirely (`_cfg`), because the endpoint it calls
 *   (`GET secure.epayco.co/validation/v1/reference/{ref_payco}`) takes no
 *   credential at all — any `ref_payco` resolves globally. This is stated in
 *   that adapter's own doc comment and was already flagged in wave 1's
 *   webhook fix as "ACCOUNT-SCOPING FOR EPAYCO REMAINS UNSOLVED".
 *
 * - **`wompi` — assumed NOT account-scoped. OUT.** Its lookup sends
 *   `Authorization: Bearer <cfg.publicKey>`.
 *
 *   ⚠️ CORRECTION (wave 3). Wave 2's version of this comment said the endpoint
 *   "answered `404 NOT_FOUND` — never `401`/`403`". **That sentence was
 *   false**, and anyone re-running the probe will see a `401` and reasonably
 *   conclude this whole paragraph is unreliable. It is not — the real probe
 *   matrix supports the same conclusion MORE strongly. `GET
 *   {sandbox,production}.wompi.co/v1/transactions/{id}`:
 *
 *   | environment          | Authorization header  | result                     |
 *   |----------------------|-----------------------|----------------------------|
 *   | sandbox & production | *(none at all)*       | `404 NOT_FOUND_ERROR`      |
 *   | sandbox              | `Bearer pub_test_BOGUS` | `404`                    |
 *   | production           | `Bearer pub_prod_BOGUS` | `404`                    |
 *   | production           | `Bearer pub_test_BOGUS` | **`401 INVALID_ACCESS_TOKEN`** |
 *   | sandbox              | `Bearer pub_prod_BOGUS` | **`401`**                |
 *   | either               | `Bearer garbage`        | **`401`**                |
 *
 *   The `401`s are an ENVIRONMENT/KEY-PREFIX check, not an authorization
 *   decision — Wompi's own reason string is *"La llave proporcionada no
 *   corresponde a este ambiente"* ("the key provided does not correspond to
 *   this environment"). Within the correct environment, a bogus key and NO
 *   HEADER AT ALL both answer `404`, identically. An endpoint that serves a
 *   request carrying no credential whatsoever cannot be scoping its answer to
 *   the caller's merchant account.
 *
 *   Two independent corroborations, neither of which depends on the probe:
 *     1. Wompi's docs describe the public key as the BROWSER-SIDE credential,
 *        explicitly contrasted with the private key, which "must be used from
 *        your backend". A credential meant to ship inside a web page is not a
 *        credential an API scopes confidential data by.
 *     2. Wompi operates a PUBLIC, UNAUTHENTICATED transaction finder at
 *        `wompi.com/es/co/transacciones`: any shopper looks a transaction up
 *        with email + date + amount, no login. Wompi plainly does not treat
 *        transaction visibility as merchant-confidential.
 *
 *   Still NOT conclusive, for the one reason it never was: the decisive test —
 *   reading a REAL transaction belonging to a DIFFERENT merchant — needs a
 *   Wompi sandbox account, which nobody working on this has had. Everything
 *   above is about how the endpoint treats an id that resolves to nothing. So
 *   the conservative reading stands, on better evidence than before.
 *
 * ## What being OUT costs, and why it is still right
 *
 * The concrete attack it stops (verified against ePayco's semantics, assumed
 * for Wompi's): an attacker with their own merchant account on the same
 * gateway creates a transaction whose reference is the VICTIM'S order number
 * and whose amount is the victim's total, pays it **into their own account**,
 * plants that transaction id via the unauthenticated hint endpoint, and the
 * binding check passes *truthfully* — reference matches, amount matches,
 * currency matches — because every one of those values is chosen by the
 * payer. `markPaid` then fires and the merchant ships goods for money they
 * never received.
 *
 * The cost is that Wompi's redirect-return capture (`/pago/wompi-retorno`,
 * P3c Task 2) no longer settles anything by itself: the hint is still stored
 * (and is still useful for support/audit), but reconciliation will not act on
 * it. Wompi's signature-verified WEBHOOK path is unaffected and remains the
 * authoritative settle path, and a webhook-stamped `providerRef` reconciles
 * for all three providers exactly as before.
 *
 * The line to revisit first if this is ever relaxed: a merchant identifier on
 * the gateway's own lookup response that can be compared against
 * `cfg.publicKey`/`cfg.epaycoCustomerId`. Wompi's docs show a `merchant`
 * object (and a `merchant_public_key` field) on SOME transaction payloads,
 * but its presence on the by-id GET response could not be confirmed without
 * an account, so nothing here reads it — a binding check against a field
 * that turns out to be absent silently degrades to no check at all, which is
 * worse than the honest refusal below.
 *
 * And if someone DOES establish, with a real sandbox account, that Wompi's
 * by-id lookup only answers for the calling merchant's own transactions, the
 * change is one line: add `'wompi'` to the Set below. Nothing else in this
 * file, or in the hint endpoint, needs to move.
 */
const ACCOUNT_SCOPED_LOOKUP_PROVIDERS: ReadonlySet<PaymentProviderId> = new Set<PaymentProviderId>([
  'mercadopago',
]);

/** `Order.providerRefSource` is a plain nullable String (schema.prisma). Only
 * `'verified'` means "the gateway itself vouched for this ref" — `'hint'` and
 * NULL (pre-migration rows, or any writer that didn't say) are both treated as
 * attacker-controlled. Fail closed. */
function isGatewayVerifiedRef(source: string | null): boolean {
  return source === 'verified';
}

/**
 * ⚠️ THE SAFETY CHECK THIS ENTIRE WORKER DEPENDS ON — DO NOT "SIMPLIFY" IT AWAY.
 *
 * Answers one question: is the transaction the gateway just told us about
 * actually ABOUT THIS ORDER? Returns `null` when it is bound, or a
 * human-readable reason when it is not.
 *
 * ## Why this is non-negotiable
 *
 * `Order.providerRef` is settable through the deliberately UNAUTHENTICATED
 * provider-ref-hint endpoint (`PATCH
 * /v1/storefront/checkout/:orderNumber/provider-ref-hint`, P3c Task 2). Without
 * this check, a shopper holding ONE real, genuinely-PAID transaction id — their
 * own past purchase — could `PATCH` it onto a DIFFERENT, still-`PENDING` order;
 * this worker would then ask the gateway "is transaction X paid?", get a
 * perfectly truthful **"yes"**, and call `markPaid` on the WRONG order. That is
 * free-order fraud with no guessing required, and `markPaid`'s own advisory
 * lock and `PENDING/PENDING` precondition do NOT catch it — they guard against
 * races and replays, not against a truthful answer about the wrong transaction.
 *
 * The already-shipped webhook path (`webhooks.controller.ts`) is immune for a
 * reason that does not carry over here: a gateway signature cryptographically
 * binds reference + amount + status together in one verified payload, and the
 * order is looked up BY that verified reference. The by-id status lookup has no
 * such binding on its own. `TransactionStatusResult`
 * (`packages/payments/src/index.ts`) exists ONLY to supply the equivalent
 * binding for this path, and it is worthless if this function stops being
 * called before every settle.
 *
 * ## What counts as bound
 *
 * - `reference` must equal `String(order.number)` — the PLAIN Int-as-string
 *   form of the `Order.number` column (e.g. `"42"`), NEVER the `VNT-`-prefixed
 *   display string used in emails/UI, matching
 *   `NormalizedPaymentEvent.reference`'s existing documented contract.
 * - A MISSING `reference` (`undefined`) is NOT a pass. Every adapter emits
 *   `undefined` rather than fabricating a value it could not read from the
 *   gateway, precisely so this function can treat it as "cannot verify".
 * - `amountCents`, WHERE THE PROVIDER SUPPLIES IT, must equal
 *   `order.totalCents`. It is optional per provider/response, so it can only
 *   ever add confidence — a missing amount is not by itself a failure, but a
 *   present, mismatched one is.
 * - `currency` (P3 wave-2 FIX 3) must be present AND equal `'COP'` WHENEVER
 *   an `amountCents` is being compared. There was previously no currency term
 *   anywhere in this system: `TransactionStatusResult`/`ReferenceSearchResult`
 *   carried none, and all three adapters hardcoded `CHECKOUT_CURRENCY = 'COP'`
 *   OUTBOUND only — so a payment of the same NUMBER of units in a different
 *   currency satisfied the amount check exactly as well as the real one. An
 *   amount is not a quantity of money until you know what it is denominated
 *   in, so a present amount with a missing/other currency is a REJECTION, not
 *   a partial pass. (A result with no amount at all is unchanged: it already
 *   binds on `reference` alone, and there is no amount for a currency to
 *   qualify.)
 *
 * ## What "not bound" means
 *
 * Settle NOTHING, in EITHER direction — not `markPaid`, not `markFailed`. Log
 * it and leave the order completely alone. It then falls through to the
 * existing, unmodified 15-minute stock-reservation expiry worker exactly as an
 * order with no `providerRef` at all already does. Treating an unverifiable
 * result as `FAILED` would be just as wrong as treating it as `PAID`: both are
 * acting on a gateway answer we have not established is about this order.
 */
function checkOrderBinding(result: TransactionStatusResult, order: CandidateOrder): string | null {
  const expectedReference = String(order.number);
  if (result.reference === undefined) {
    return 'gateway response carries no reference — cannot verify the transaction belongs to this order';
  }
  if (result.reference !== expectedReference) {
    return `gateway reference ${JSON.stringify(result.reference)} does not match this order's reference ${JSON.stringify(expectedReference)}`;
  }
  if (result.amountCents !== undefined) {
    if (result.amountCents !== order.totalCents) {
      return `gateway amount ${result.amountCents} does not match this order's total ${order.totalCents}`;
    }
    // Checked only alongside a present amount, on purpose: the currency
    // qualifies the amount, and a result carrying no amount at all is bound
    // by `reference` alone (unchanged behavior — see this function's doc
    // comment). Every one of the three adapters DOES report a currency
    // alongside an amount (`data.currency`, `currency_id`,
    // `x_currency_code`), so a result with an amount but no currency means
    // the response was not the shape we expect and is treated as
    // unverifiable rather than waved through.
    if (result.currency !== ORDER_CURRENCY) {
      return `gateway currency ${JSON.stringify(result.currency)} is not ${ORDER_CURRENCY} — its amount ${result.amountCents} is not comparable to this order's total ${order.totalCents}`;
    }
  }
  return null;
}

/**
 * The testable sweep (design decision 4 / P3c Task 4): finds every tenant's
 * online-payment orders whose payment webhook should have arrived by now,
 * re-checks each one against its gateway's OWN authenticated status API, and
 * settles it through the existing `markPaid`/`markFailed` when — and only when
 * — that response both resolves the payment AND is provably about that order.
 *
 * Exported as a plain function, deliberately NOT a method that also starts
 * BullMQ, so tests call it directly without ever constructing a real
 * `Queue`/`Worker` — same split `stock-reservation.worker.ts` uses (see
 * `ReconciliationWorker` below, the only thing in this file that touches
 * BullMQ).
 *
 * ## Cross-tenant read: why `platformDb` with no `SET LOCAL ROLE`
 *
 * Identical reasoning to `expireReservations()`'s own doc comment, which
 * investigated this rather than assuming it: a BullMQ job has no per-request
 * tenant context, and the whole point of the sweep is to cover every tenant in
 * one pass, so switching to `ventia_app` + a single `app.tenant_id` would scope
 * the read to ONE tenant — the opposite of what is needed. `platformDb` is
 * documented (and empirically confirmed in `packages/db/src/index.ts`) as the
 * RLS-bypassing owner connection. The per-order WRITES are not done here at
 * all: they go through `markPaid`/`markFailed`, which already run their own
 * `SET LOCAL ROLE ventia_app` + `set_config('app.tenant_id', ...)` +
 * `pg_advisory_xact_lock(hashtext(orderId))` transaction — the same lock key
 * `transition()` and the stock-expiry worker use, so a webhook, an admin
 * action, the expiry sweep and this sweep all serialize against each other on
 * the same order.
 *
 * Returns the number of orders this sweep actually TRANSITIONED, for logging.
 * P3 wave-3: this used to count every order a settle path was CALLED for, which
 * is not the same thing — both settle paths no-op outside their preconditions
 * (an already-FAILED order the gateway still reports FAILED is a candidate on
 * every single 2-minute pass and transitions nothing), so
 * `[reconciliation-worker] reconciled N order(s)` could report orders nothing
 * happened to.
 */
export async function reconcilePendingPayments(
  paymentsService: SettleService,
  resolveProvider: ProviderResolver = getProvider,
): Promise<number> {
  const cutoff = new Date(Date.now() - RECONCILE_MIN_AGE_MS);

  const candidates = await platformDb.order.findMany({
    where: {
      // P3 wave-2 FIX 2: an order whose `status` has already moved on is NOT
      // a reconciliation candidate, whatever its `paymentStatus` says. This
      // one line kills a reproduced permanent zombie: a merchant pressing
      // "Confirmar pedido" on an online-payment order left it
      // CONFIRMED/PENDING with `stockReservedUntil` still set, which matched
      // this query forever — one outbound gateway call and one settle attempt
      // on EVERY 2-minute sweep, for the rest of that order's life, while
      // `expireReservations()` (which filters `status: 'PENDING'`) could
      // never release it. Because this query is `orderBy createdAt asc` with
      // `take: RECONCILE_BATCH_LIMIT`, such orders accumulate at the FRONT of
      // the queue and eventually starve every real candidate platform-wide —
      // falsifying the "bounded in practice" premise in RECONCILE_BATCH_LIMIT's
      // own doc comment. The `confirm` guard in orders.service.ts stops new
      // zombies being created; this stops the ones that already exist (and
      // any future way of reaching the same state) from sweeping forever.
      status: 'PENDING',
      // P3 wave-2 FIX 1: `FAILED` belongs here alongside `PENDING`. A declined
      // attempt sets `paymentStatus: 'FAILED'` while deliberately leaving the
      // order PENDING and its stock reserved *because the shopper may retry*
      // (see markFailed's doc comment). Filtering on `PENDING` alone meant
      // that the moment one attempt was declined, the order dropped out of
      // reconciliation entirely — so if the SUCCESSFUL retry's webhook was
      // ever lost, nothing was left to recover it and the 15-minute expiry
      // worker cancelled and restocked an order the shopper had paid for.
      // `markPaid` accepts `PENDING`->`FAILED`->PAID for exactly this reason;
      // this is the half that makes it reachable without a webhook.
      paymentStatus: { in: ['PENDING', 'FAILED'] },
      stockReservedUntil: { not: null },
      createdAt: { lt: cutoff },
      // Online-payment orders only. COD orders never reach here anyway
      // (checkout writes `paymentStatus: 'COD'` and leaves `paymentProvider`
      // null for them), but both halves of design decision 4's predicate are
      // stated explicitly rather than relying on that coupling. Split into an
      // AND of two separate conditions because Prisma's `not` on a NULLABLE
      // column has null-handling subtleties — `{not: null}` and `{not: 'cod'}`
      // as two independent filters is unambiguous.
      AND: [{ paymentProvider: { not: null } }, { paymentProvider: { not: 'cod' } }],
    },
    select: {
      id: true,
      tenantId: true,
      number: true,
      totalCents: true,
      paymentProvider: true,
      providerRef: true,
      providerRefSource: true,
    },
    // Oldest first, so a truncated sweep always drains the FRONT of the
    // backlog instead of re-reading an arbitrary page and starving the same
    // orders forever. Anything past the limit is picked up on the next
    // 2-minute run — no order is dropped, only deferred.
    orderBy: { createdAt: 'asc' },
    // See RECONCILE_BATCH_LIMIT's doc comment for why this bound exists and
    // why 250.
    take: RECONCILE_BATCH_LIMIT,
  });

  let settledCount = 0;
  for (const order of candidates) {
    // ONE try/catch PER ORDER, never one around the whole loop: a single bad
    // order (gateway 500, malformed response, transient DB error) must never
    // abort the rest of the batch — every other tenant's legitimate
    // reconciliation would be collateral damage. Same posture, and same
    // reasoning, as `expireReservations()`'s per-order catch.
    try {
      const settled = await reconcileOneOrder(order, paymentsService, resolveProvider);
      if (settled) settledCount++;
    } catch (err) {
      // Design decision 6: a failed reconciliation ATTEMPT is never a FAILED
      // PAYMENT. Log and try again on the next 2-minute run. The alternative
      // (treating an unreachable gateway as "must have failed") would settle —
      // and eventually restock — an order that may genuinely have been paid,
      // purely because OUR call had a transient failure.
      console.error('[reconciliation-worker] failed to reconcile order, continuing sweep', {
        orderId: order.id,
        tenantId: order.tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return settledCount;
}

/** Resolves and (if resolvable AND bound) settles ONE order. Returns `true`
 * only if a settle path actually TRANSITIONED the order — not merely that one
 * was called (P3 wave-3; see the settle branches at the bottom of this
 * function). Every "can't resolve" path returns `false` after logging, leaving
 * the order untouched for the next run — or, ultimately, for the existing
 * 15-minute expiry worker. */
async function reconcileOneOrder(
  order: CandidateOrder,
  paymentsService: SettleService,
  resolveProvider: ProviderResolver,
): Promise<boolean> {
  const providerId = asPaymentProviderId(order.paymentProvider);
  if (!providerId) {
    // An unrecognized `paymentProvider` string — shouldn't be reachable via the
    // query above, but never cast a DB string into a union on faith.
    console.error('[reconciliation-worker] order has an unrecognized paymentProvider, skipping', {
      orderId: order.id,
      paymentProvider: order.paymentProvider,
    });
    return false;
  }

  const cfg: TenantProviderConfig | null = await paymentsService.getTenantProviderConfig(
    order.tenantId,
    providerId,
  );
  if (!cfg) {
    // The tenant has no (or no longer valid) stored credentials for this
    // provider — there is nothing to authenticate a gateway call with. Skip;
    // this is a merchant-configuration condition, not a payment outcome.
    console.error('[reconciliation-worker] tenant has no provider config, skipping order', {
      orderId: order.id,
      tenantId: order.tenantId,
      provider: providerId,
    });
    return false;
  }

  const provider = resolveProvider(providerId);

  // The resolved gateway answer + the transaction id we would settle with.
  // Null until a lookup produces a result that PASSED `checkOrderBinding`;
  // nothing below this point may settle from an unbound one.
  let result: TransactionStatusResult | null = null;
  let providerRef: string | null = null;

  // ⚠️ MANDATORY on EVERY path — see `checkOrderBinding`'s doc comment before
  // touching this. Nothing may settle from a result we cannot prove is about
  // THIS order. Applied per-lookup (rather than once at the end) so that a
  // result which fails to bind can fall through to the NEXT lookup instead of
  // ending the whole attempt — see the `searchByReference` fallback below.
  // Returns the candidate when it binds, `null` when it does not.
  const boundOrNull = (candidate: TransactionStatusResult, via: string): TransactionStatusResult | null => {
    const notBoundReason = checkOrderBinding(candidate, order);
    if (!notBoundReason) return candidate;
    console.error('[reconciliation-worker] gateway result is not bound to this order — settling nothing', {
      orderId: order.id,
      tenantId: order.tenantId,
      provider: providerId,
      via,
      orderReference: String(order.number),
      gatewayReference: candidate.reference,
      gatewayStatus: candidate.status,
      reason: notBoundReason,
    });
    return null;
  };

  // Step 1 — we have a transaction id, either stamped by a signature-verified
  // webhook (`providerRefSource === 'verified'`) or planted through the
  // deliberately-unauthenticated hint endpoint.
  if (order.providerRef) {
    if (!isGatewayVerifiedRef(order.providerRefSource) && !ACCOUNT_SCOPED_LOOKUP_PROVIDERS.has(providerId)) {
      // P3 wave-2 FIX 3. An unverified ref is a value the PAYER chose, and so
      // are the `reference`/`amountCents`/`currency` the gateway will report
      // back for it — every term `checkOrderBinding` compares. For a provider
      // whose lookup is not bound to THIS tenant's merchant account, all four
      // can be satisfied truthfully by a transaction paid into SOMEONE ELSE'S
      // account. So this doesn't even make the call: there is no answer it
      // could give that would establish what we need. See
      // `ACCOUNT_SCOPED_LOOKUP_PROVIDERS` for the per-provider evidence and
      // for exactly what functionality this costs.
      console.error(
        '[reconciliation-worker] refusing a by-id lookup: unverified providerRef on a provider whose lookup is not account-scoped',
        {
          orderId: order.id,
          tenantId: order.tenantId,
          provider: providerId,
          providerRefSource: order.providerRefSource,
        },
      );
    } else {
      result = boundOrNull(await provider.getTransactionStatus(order.providerRef, cfg), 'by-id');
      if (result) providerRef = order.providerRef;
    }
  }

  // Step 2 — look one up BY OUR OWN reference. Today that is Mercado Pago and
  // only Mercado Pago (design decision 5); this branches on the CAPABILITY
  // rather than on `providerId === 'mercadopago'` because that is what the
  // optional interface method means — a future provider that implements it
  // gets this path without editing this line.
  //
  // P3 wave-2 FIX 4: this now also runs when step 1 was SKIPPED or FAILED TO
  // BIND, not only when the order had no `providerRef` at all. Preferring a
  // by-id lookup unconditionally handed an attacker a way to turn a
  // RECOVERABLE order into a LOST one: an MP order with no ref self-heals to
  // CONFIRMED/PAID off this very search, but the same order with a bogus ref
  // planted through the hint endpoint stopped at the failed by-id lookup and
  // was left to be cancelled and restocked with the shopper's money already
  // taken. A denial-of-settlement that costs the attacker nothing. The
  // gateway's own by-OUR-reference answer doesn't care what was planted, so
  // falling back to it removes the leverage entirely.
  if (!result && provider.searchByReference) {
    const found = await provider.searchByReference(String(order.number), cfg);
    if (found) {
      result = boundOrNull(
        {
          status: found.status,
          // The GATEWAY's own assertions about the chosen transaction, passed
          // through verbatim — never this call's own query key restated. That
          // earlier shortcut made the binding check a TAUTOLOGY on this path
          // (it compared `String(order.number)` to itself) and left the amount
          // unchecked entirely, so the whole guarantee rested on the gateway's
          // server-side reference filter being exact-match: documented, but
          // never verified by us at runtime, and a query-construction bug or a
          // gateway moving to prefix/fuzzy matching (a search for order `14`
          // returning a payment for `142`) would have defeated it silently.
          // `undefined` in any field stays `undefined` — `checkOrderBinding`
          // rejects a missing reference, which is the correct outcome for a
          // result we cannot verify.
          reference: found.reference,
          amountCents: found.amountCents,
          currency: found.currency,
        },
        'search-by-reference',
      );
      if (result) providerRef = found.providerRef;
    }
    // `found === null` — no payment attempt exists for this reference.
    // Nothing to reconcile; falls through to the return below.
  }

  // Nothing resolved and bound: Wompi/ePayco with no usable `providerRef` (no
  // by-our-reference API path exists for either — design decision 3, confirmed
  // by that phase's own research), a lookup that didn't bind, or a search that
  // found nothing. Leave the order completely alone; it falls through to the
  // existing 15-minute stock-reservation expiry worker exactly as an
  // unreconcilable order already does. This remains the phase's biggest
  // disclosed coverage gap, and it is deliberate.
  if (!result || !providerRef) {
    return false;
  }

  if (result.status === 'PAID') {
    // The RETURNED BOOLEAN, not the fact that the call happened (P3 wave-3).
    // `markPaid`/`markFailed` no-op outside their own preconditions, so an
    // order that was a candidate when the query ran but had already been
    // settled/cancelled by a racing webhook or admin action produced no
    // transition at all — and this function reported `true` for it anyway,
    // which is what made the sweep's `reconciled N order(s)` log capable of
    // naming orders nothing happened to.
    return paymentsService.markPaid(order.tenantId, order.id, providerId, providerRef);
  }

  if (result.status === 'FAILED' || result.status === 'EXPIRED') {
    // `markFailed` deliberately touches ONLY `paymentStatus` — it does not
    // cancel the order or release its stock hold (the shopper may retry). This
    // job never expires or restocks anything itself (design decision 7).
    //
    // `result.status` is passed through as the audit-only `gatewayStatus`
    // because BOTH terminal non-PAID statuses land here and both become
    // `paymentStatus: 'FAILED'`: Mercado Pago maps `refunded`/`charged_back`
    // to `EXPIRED`, so without this a reversed payment would be
    // indistinguishable from a declined card afterwards. It changes nothing
    // about the transition itself — see `markFailed`'s own doc comment.
    // Same "count the transition, not the call" rule as the PAID branch above.
    // This side has a routine, entirely expected no-op case: an order already
    // in PENDING/FAILED whose gateway answer is still FAILED is a candidate
    // (wave-2 FIX 1 put FAILED back in the candidate set so a lost retry
    // webhook can still be recovered), gets asked every sweep, and correctly
    // transitions nothing — it must not be counted as a reconciliation on
    // every single 2-minute pass.
    return paymentsService.markFailed(order.tenantId, order.id, providerId, providerRef, result.status);
  }

  // Still genuinely PENDING per the gateway itself: no action this run, try
  // again in 2 minutes. If the shopper never completes payment, the existing
  // expiry worker eventually releases the reservation — this job never does.
  return false;
}

/**
 * Thin BullMQ wrapper around `reconcilePendingPayments()` — registered as an
 * ordinary provider in `payments.module.ts`, but its `start()` method is called
 * from EXACTLY ONE place: `main.ts`'s `if (require.main === module)` real-boot
 * block, AFTER `createApp()` + `app.listen(...)`.
 *
 * ## Why this must not implement `OnModuleInit`
 *
 * Identical to `StockReservationWorker`'s reasoning — read that class's doc
 * comment in `stock-reservation.worker.ts` for the full version. In short:
 * `createApp()` is the same factory every test file in this repo calls in its
 * `beforeAll` (`await createApp(); await app.init();`), and `app.init()` runs
 * `onModuleInit`/`onApplicationBootstrap` on every provider in the module
 * graph. A lifecycle hook here would silently start a real repeatable job and a
 * real `Worker` polling each test's own ephemeral Testcontainers Redis, on
 * every test run in the repo — sweeping other suites' test data in the
 * background and leaking connections `app.close()` may not wait for.
 *
 * So this class implements NEITHER `OnModuleInit` nor
 * `OnApplicationBootstrap`; there is no hook for Nest to call. `start()` is an
 * ordinary public method nothing but main.ts's real-boot branch invokes (no
 * test's import graph reaches that branch, since it only runs when main.ts is
 * the process entry point). `OnModuleDestroy` IS implemented and is a safe
 * no-op when `start()` was never called.
 */
@Injectable()
export class ReconciliationWorker implements OnModuleDestroy {
  private connection: Redis | null = null;
  private queue: Queue | null = null;
  private worker: Worker | null = null;

  // Explicit @Inject: esbuild (vitest's TS transform) doesn't emit
  // `design:paramtypes`, so Nest's implicit constructor injection by type
  // alone can't resolve PaymentsService here — same caution every other
  // constructor-injecting class in this codebase uses.
  constructor(@Inject(PaymentsService) private readonly paymentsService: PaymentsService) {}

  /**
   * Starts the repeatable job registration + the `Worker` that processes it.
   * The repeatable job uses a fixed `jobId` (`REPEAT_JOB_ID`), so
   * re-registering the same repeat options on the same queue name is
   * idempotent from BullMQ/Redis's side even across process restarts.
   */
  async start(): Promise<void> {
    // A DEDICATED ioredis connection with `maxRetriesPerRequest: null`, NOT a
    // reuse of app.module.ts's `REDIS_CLIENT` — same requirement and same
    // reasoning as StockReservationWorker.start()'s own comment (BullMQ's
    // documented connection requirement; `REDIS_CLIENT` is tuned for
    // DomainResolver's simple GET/SET cache and shouldn't be re-tuned for a
    // consumer it knows nothing about). A separate Queue/Worker pair here also
    // keeps this sweep's failures isolated from the stock-expiry sweep's.
    const connectionOptions: ConnectionOptions = { maxRetriesPerRequest: null };
    this.connection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', connectionOptions);
    this.connection.on('error', (err) => console.error('[reconciliation-worker] redis error', err.message));

    this.queue = new Queue(QUEUE_NAME, { connection: this.connection });
    await this.queue.add(
      JOB_NAME,
      {},
      {
        repeat: { every: SWEEP_INTERVAL_MS },
        jobId: REPEAT_JOB_ID,
      },
    );

    this.worker = new Worker(
      QUEUE_NAME,
      async () => {
        const count = await reconcilePendingPayments(this.paymentsService);
        if (count > 0) {
          console.log(`[reconciliation-worker] reconciled ${count} order(s)`);
        }
      },
      { connection: this.connection },
    );
    this.worker.on('failed', (job, err) => {
      console.error('[reconciliation-worker] sweep job failed', { jobId: job?.id, error: err.message });
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
    if (this.connection) {
      try {
        await this.connection.quit();
      } catch {
        this.connection.disconnect();
      }
    }
  }
}
