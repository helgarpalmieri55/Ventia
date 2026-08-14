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
import { getProvider } from './provider-registry';

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
  if (result.amountCents !== undefined && result.amountCents !== order.totalCents) {
    return `gateway amount ${result.amountCents} does not match this order's total ${order.totalCents}`;
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
 * Returns the number of orders actually settled (`markPaid`/`markFailed`
 * called), for logging.
 */
export async function reconcilePendingPayments(
  paymentsService: SettleService,
  resolveProvider: ProviderResolver = getProvider,
): Promise<number> {
  const cutoff = new Date(Date.now() - RECONCILE_MIN_AGE_MS);

  const candidates = await platformDb.order.findMany({
    where: {
      paymentStatus: 'PENDING',
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
    select: { id: true, tenantId: true, number: true, totalCents: true, paymentProvider: true, providerRef: true },
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
 * only if `markPaid`/`markFailed` was actually called. Every "can't resolve"
 * path returns `false` after logging, leaving the order untouched for the next
 * run — or, ultimately, for the existing 15-minute expiry worker. */
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
  let result: TransactionStatusResult;
  let providerRef: string;

  if (order.providerRef) {
    // Step 1 — we have a transaction id (from a real webhook's `markPaid`/
    // `markFailed` stamp, or from Wompi's redirect-return hint). Ask the
    // gateway about it directly. NOTE the hint source is unauthenticated, which
    // is exactly why `checkOrderBinding` below is mandatory.
    providerRef = order.providerRef;
    result = await provider.getTransactionStatus(order.providerRef, cfg);
  } else if (provider.searchByReference) {
    // Step 2 — no transaction id at all, but this provider can look one up BY
    // OUR OWN reference. Today that is Mercado Pago and only Mercado Pago
    // (design decision 5); this branches on the CAPABILITY rather than on
    // `providerId === 'mercadopago'` because that is what the optional
    // interface method means — a future provider that implements it should get
    // this path without editing this line, and Wompi/ePayco, for which the
    // method is genuinely undefined, still fall through to step 3.
    const found = await provider.searchByReference(String(order.number), cfg);
    if (!found) {
      // No payment attempt exists for this reference — nothing to reconcile.
      return false;
    }
    providerRef = found.providerRef;
    result = {
      status: found.status,
      // `searchByReference` is bound BY CONSTRUCTION: the gateway was asked for
      // payments whose OWN `external_reference` equals this exact string, and
      // returned this one. Restating that query key here is therefore reading
      // back a fact the gateway asserted, not fabricating a binding — and it
      // keeps the check below UNIFORM across every path, so no future reader
      // has to work out which paths are exempt from it. (`amountCents` stays
      // undefined: the search result genuinely doesn't carry an amount, and
      // inventing one would be exactly the fabrication this design forbids.)
      reference: String(order.number),
    };
  } else {
    // Step 3 — Wompi/ePayco with no `providerRef` at all: no API path exists
    // (design decision 3, confirmed by this phase's own research, not assumed).
    // Skip entirely; this order can only ever fall through to the existing
    // 15-minute stock-reservation expiry worker. This is the phase's biggest
    // disclosed coverage gap, and it is deliberate.
    return false;
  }

  // ⚠️ MANDATORY — see `checkOrderBinding`'s doc comment before touching this.
  // Nothing below may run for a result we cannot prove is about THIS order.
  const notBoundReason = checkOrderBinding(result, order);
  if (notBoundReason) {
    console.error('[reconciliation-worker] gateway result is not bound to this order — settling nothing', {
      orderId: order.id,
      tenantId: order.tenantId,
      provider: providerId,
      orderReference: String(order.number),
      gatewayReference: result.reference,
      gatewayStatus: result.status,
      reason: notBoundReason,
    });
    return false;
  }

  if (result.status === 'PAID') {
    await paymentsService.markPaid(order.tenantId, order.id, providerId, providerRef);
    return true;
  }

  if (result.status === 'FAILED' || result.status === 'EXPIRED') {
    // `markFailed` deliberately touches ONLY `paymentStatus` — it does not
    // cancel the order or release its stock hold (the shopper may retry). This
    // job never expires or restocks anything itself (design decision 7).
    await paymentsService.markFailed(order.tenantId, order.id, providerId, providerRef);
    return true;
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
