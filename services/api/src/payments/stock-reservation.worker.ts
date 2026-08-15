import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import Redis from 'ioredis';
import { Prisma, platformDb } from '@ventia/db';
import { adjustStockLine } from '../orders/orders.service';

// "Every minute" (design doc decision 5) == every 60s — no actual conflict
// with the brief's "60s" language, just two ways of saying the same
// interval.
const SWEEP_INTERVAL_MS = 60_000;

const QUEUE_NAME = 'stock-reservation-expiry';
const JOB_NAME = 'sweep';
// A fixed, stable job id for the repeatable job registration itself (NOT a
// per-run job id — BullMQ generates those). Passing a stable `jobId` here
// means calling `start()` again (e.g. a process restart) re-registers the
// SAME repeatable job rather than accumulating a second, independent
// schedule that would double the sweep frequency.
const REPEAT_JOB_ID = 'stock-reservation-sweep';

/**
 * The testable sweep logic (P3a design decision 5 / task 6): finds every
 * tenant's `Order` whose 15-minute stock reservation (Task 5,
 * checkout.service.ts's `wompi` branch) has lapsed without a payment webhook
 * ever confirming it, restocks it, and cancels it.
 *
 * Exported as a plain function — deliberately NOT a method that also starts
 * the BullMQ scheduling machinery — so tests call it directly (see
 * test/stock-reservation-worker.test.ts) without ever constructing a real
 * `Queue`/`Worker` against a Redis connection. This mirrors this file's own
 * `StockReservationWorker` class below, which is the ONLY thing that touches
 * BullMQ, and is never auto-started by Nest's module lifecycle (see that
 * class's doc comment).
 *
 * ## Cross-tenant read: why no `SET LOCAL ROLE` here
 *
 * Every other multi-write flow in this codebase that spans tenant-scoped
 * tables (`orders.service.ts`'s `transition()`, `payments.service.ts`'s
 * `markPaid`/`markFailed`) runs its whole transaction under `SET LOCAL ROLE
 * ventia_app` + `set_config('app.tenant_id', ...)` — the RLS-enforcing,
 * NOLOGIN role every tenant-scoped query is meant to run as. That pattern is
 * inapplicable to THIS read: it is genuinely, deliberately cross-tenant (a
 * BullMQ job has no per-request tenant context, and the whole point of this
 * sweep is to find expired reservations across every tenant in one pass —
 * design decision 5 explicitly calls this out). Switching to `ventia_app`
 * and setting a single `app.tenant_id` would scope the read to ONE tenant,
 * which is the opposite of what's needed.
 *
 * Investigated instead of assumed: `packages/db/src/index.ts` documents
 * `platformDb` itself as "Owner connection — bypasses RLS. Platform-admin/
 * system use only" — confirmed empirically against the actual running
 * Postgres role (`\du` shows the `ventia` role, `platformDb`'s default
 * connection identity before any `SET LOCAL ROLE`, carries the `Bypass RLS`
 * attribute, being the table owner/superuser in both the dev compose stack
 * and Testcontainers' default Postgres user). The RLS policies
 * (`packages/db/prisma/migrations/20260723182728_rls/migration.sql`) are
 * `CREATE POLICY ... USING (...)` without `FORCE ROW LEVEL SECURITY`, which
 * Postgres documents as never applying to a table's owner regardless.
 * Concretely: this initial `platformDb.order.findMany(...)` is a genuinely
 * platform-wide read with NO role switch at all — it already sees every
 * tenant's rows, by construction of how `platformDb`'s connection is
 * privileged, not because of any RLS bypass trick added here. The
 * SET-LOCAL-ROLE+advisory-lock dance below, in `expireOneReservation`, is
 * NOT about widening visibility (this connection already has full
 * visibility) — it's about correctly *scoping the WRITES* to the order's
 * own tenant (defense in depth against a future bug in this file rather
 * than relying solely on an explicit `tenantId` in every `where`/`data`
 * clause) and about serializing against a concurrent transition on the same
 * order, exactly like `transition()`/`markPaid` already do.
 */
export async function expireReservations(): Promise<number> {
  const now = new Date();

  const candidates = await platformDb.order.findMany({
    where: {
      stockReservedUntil: { not: null, lt: now },
      status: 'PENDING',
    },
    select: { id: true, tenantId: true },
  });

  let processedCount = 0;
  for (const { id: orderId, tenantId } of candidates) {
    try {
      const processed = await expireOneReservation(tenantId, orderId);
      if (processed) processedCount++;
    } catch (err) {
      // One order's failure (e.g. an unexpected STOCK_BELOW_ZERO-shaped
      // error, which shouldn't be possible for a positive restock delta,
      // or a transient DB error) must never abort the whole sweep — this is
      // the one deliberate difference from `orders.service.ts`'s
      // `transition()`, where a thrown error SHOULD abort that single
      // order's own transaction: here, the caller is a loop over MANY
      // orders across MANY tenants, and one bad row blocking every other
      // tenant's legitimate expiry would be a much worse outcome than
      // logging this one and moving on. Left for a later reconciliation
      // pass (P3c) to pick back up on the next sweep — nothing about this
      // order's `stockReservedUntil`/`status` was mutated by the failed
      // attempt (the whole per-order body ran inside its own transaction,
      // which rolled back), so it remains a valid candidate for the very
      // next tick.
      console.error('[stock-reservation-worker] failed to expire order, continuing sweep', {
        orderId,
        tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return processedCount;
}

/**
 * One order's expiry, inside its own advisory-lock transaction — same
 * `pg_advisory_xact_lock(hashtext(orderId))` key as `orders.service.ts`'s
 * `transition()` and `payments.service.ts`'s `markPaid`/`markFailed`,
 * DELIBERATELY: this means a webhook confirming payment, or a merchant
 * cancelling the order by hand, racing this sweep on the SAME order
 * genuinely serializes against it through the exact same lock, not just
 * against other sweep runs.
 *
 * Re-reads the order INSIDE the lock and re-validates `status === 'PENDING'`
 * before doing anything — the initial cross-tenant SELECT above and this
 * transaction acquiring the lock are two separate round trips, so an
 * admin/webhook may have already moved this exact order to CONFIRMED (paid)
 * or CANCELLED in between. Returns `false` (not counted in the sweep's
 * total) without restocking/cancelling if so — the whole reason this
 * function re-reads rather than trusting the candidate row it was handed.
 *
 * Returns `true` if this order was actually expired (restocked +
 * cancelled), `false` if it was skipped (already moved on).
 */
async function expireOneReservation(tenantId: string, orderId: string): Promise<boolean> {
  return platformDb.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL ROLE ventia_app');
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${orderId}))`;

    const order = await tx.order.findFirst({ where: { id: orderId, tenantId }, include: { items: true } });
    // Not found (shouldn't happen — this orderId came from platformDb a
    // moment ago), or no longer PENDING (an admin/webhook won the race):
    // skip, don't touch anything.
    if (!order || order.status !== 'PENDING') {
      return false;
    }

    // Restock every line — reason 'order_expired' (NOT 'order_cancelled'):
    // this is an automatic TTL expiry, not a merchant/shopper cancel action,
    // and the InventoryMovement audit trail should say so distinctly (see
    // adjustStockLine's doc comment in orders.service.ts). Actor is
    // `'system'` — the same sentinel checkout.service.ts's own `wompi`
    // reservation branch already uses for its `adjustStockLine` call and
    // `payments.service.ts`'s `markPaid`/`markFailed` already use for their
    // `OrderEvent.actor` — this is an automated job, not a human staff
    // member or an authenticated webhook caller with its own identity, so
    // reusing the codebase's existing "automated system action" sentinel is
    // more consistent than inventing a new one.
    for (const item of order.items) {
      await adjustStockLine(tx, tenantId, item, item.qty, 'order_expired', orderId, 'system');
    }

    await tx.order.update({
      where: { id: orderId },
      data: { status: 'CANCELLED', paymentStatus: 'EXPIRED', stockReservedUntil: null },
    });

    // A distinct OrderEvent `type` (`'reservation_expired'`), not the
    // `'status_changed'` type transition()'s own cancel/confirm/etc. writes
    // — this is a materially different kind of event (an automated system
    // action, not a staff member clicking a button), and a distinct type
    // lets the admin order-history UI (or any future audit tooling) render
    // it differently ("stock reservation expired automatically" vs. "staff
    // cancelled this order") without having to inspect `actor`/`data` to
    // tell them apart.
    await tx.orderEvent.create({
      data: {
        tenantId,
        orderId,
        type: 'reservation_expired',
        actor: 'system',
        data: { from: order.status, to: 'CANCELLED' } as Prisma.InputJsonValue,
      },
    });

    return true;
  });
}

/**
 * Thin BullMQ wrapper around `expireReservations()` (design decision 5) —
 * registered as an ordinary provider in `payments.module.ts`, but its
 * `start()` method is called from EXACTLY ONE place: `main.ts`'s
 * `if (require.main === module)` real-boot block, AFTER `createApp()` +
 * `app.listen(...)`.
 *
 * ## Why this must not implement `OnModuleInit`
 *
 * `createApp()` (main.ts) is the same factory every test file in this repo
 * calls (`await createApp(); await app.init();` — see
 * orders-transitions.test.ts, payments-service.test.ts, webhooks.test.ts,
 * etc.), and Nest's `app.init()` invokes `onModuleInit`/
 * `onApplicationBootstrap` on every provider reachable in the module graph,
 * in every one of those tests, against each test's own ephemeral
 * Testcontainers Postgres+Redis. If this class started its BullMQ
 * `Queue`/`Worker` from a Nest lifecycle hook, EVERY test run in this repo
 * would silently spin up a real repeatable job and a real `Worker` polling
 * a real (test-container) Redis — sweeping test data every 60s in the
 * background of unrelated test suites, and leaking connections `app.close()`
 * may not know to wait for.
 *
 * This class deliberately implements NEITHER `OnModuleInit` nor
 * `OnApplicationBootstrap` — there is no lifecycle hook here for Nest to
 * call automatically. `start()` is a completely ordinary, unexported-from-
 * any-interface public method; nothing invokes it except main.ts's real-boot
 * branch, which no test file's import graph reaches (tests import
 * `createApp`/`AppModule`, never the `if (require.main === module)` block
 * below it, since that code only runs when this file is executed directly
 * as the process entry point). `OnModuleDestroy` IS implemented, but is a
 * safe no-op if `start()` was never called (`this.queue`/`this.worker` stay
 * `null`, `?.close()` on `null` is a no-op).
 */
@Injectable()
export class StockReservationWorker implements OnModuleDestroy {
  private connection: Redis | null = null;
  private queue: Queue | null = null;
  private worker: Worker | null = null;

  /**
   * Starts the repeatable job registration + the `Worker` that processes it.
   * Idempotent-ish in the sense that calling it twice on the same instance
   * would create a second Queue/Worker/connection (not guarded against,
   * since main.ts only ever calls this once per process), but the
   * repeatable job itself is registered with a fixed `jobId`
   * (`REPEAT_JOB_ID`), so re-registering the same repeat options on the same
   * queue name is idempotent from BullMQ/Redis's side even across process
   * restarts.
   */
  async start(): Promise<void> {
    // A DEDICATED ioredis connection, NOT a reuse of app.module.ts's
    // `REDIS_CLIENT` (the client `DomainResolver`'s cache uses). BullMQ's
    // documented connection requirement is `maxRetriesPerRequest: null` on
    // any ioredis connection passed to a `Queue`/`Worker` — with ioredis's
    // default (a finite retry count), a `Worker`'s internal blocking
    // commands (BullMQ uses blocking list/stream reads to wait for jobs) can
    // throw/give up mid-operation instead of ioredis retrying indefinitely
    // as BullMQ expects, per BullMQ's own connection docs. `REDIS_CLIENT`'s
    // factory (app.module.ts) constructs a plain `new Redis(url)` with
    // ioredis's default retry behavior, tuned for `DomainResolver`'s simple
    // GET/SET cache calls — changing ITS options to satisfy BullMQ would be
    // a cross-cutting change to a connection another, unrelated part of the
    // app already depends on, for no benefit to that consumer. A second,
    // independent connection scoped to just this worker is the safer,
    // more local change: one extra Redis connection is cheap, and it keeps
    // each connection's options matched to what its own consumer actually
    // needs.
    const connectionOptions: ConnectionOptions = { maxRetriesPerRequest: null };
    this.connection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', connectionOptions);
    this.connection.on('error', (err) => console.error('[stock-reservation-worker] redis error', err.message));

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
        const count = await expireReservations();
        if (count > 0) {
          console.log(`[stock-reservation-worker] expired ${count} reservation(s)`);
        }
      },
      { connection: this.connection },
    );
    this.worker.on('failed', (job, err) => {
      console.error('[stock-reservation-worker] sweep job failed', { jobId: job?.id, error: err.message });
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
