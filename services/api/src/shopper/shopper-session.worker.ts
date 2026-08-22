import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import Redis from 'ioredis';
import { platformDb } from '@ventia/db';

/**
 * Deletes expired shopper sessions and spent or expired link tokens.
 *
 * ## Why this is not optional housekeeping
 *
 * Both tables grow with every sign-in and every "email me a link" click and
 * nothing ever removes a row. A store with real traffic accumulates them
 * forever, and the rows that pile up are precisely the ones holding credential
 * material — so the cost of not sweeping is not disk, it is a growing pile of
 * hashes whose only purpose has already been served.
 *
 * Expired rows are already INERT: `resolveSession` filters on `expiresAt` and
 * `consumeToken` filters on both `expiresAt` and `consumedAt`, so nothing here
 * changes what authenticates. This is about not keeping what is finished.
 *
 * ## Why spent tokens linger before deletion
 *
 * A consumed token is kept for {@link SPENT_TOKEN_GRACE_MS} rather than
 * deleted on use. A shopper who double-clicks the link in their email sends
 * two requests; the second must be able to distinguish "already used" from
 * "never existed" so the page can say "ya usaste este enlace" instead of
 * "enlace inválido". Deleting immediately collapses those two into the same
 * unhelpful answer.
 */

/** Hourly. These rows are inert the moment they expire, so the only thing
 * urgency would buy is a slightly smaller table. */
const SWEEP_INTERVAL_MS = 60 * 60_000;

/** How long a spent token is kept so a double-click can be told apart from a
 * bad link. An hour comfortably covers "I clicked it twice" without keeping
 * anything meaningfully longer than its own lifetime. */
export const SPENT_TOKEN_GRACE_MS = 60 * 60_000;

/** Ceiling per sweep, per table. Bounds one run's transaction and lock
 * footprint on a platform that has been running unswept for a while; whatever
 * is left is picked up an hour later, and the query is ordered by deadline so
 * each run drains the oldest first rather than re-reading an arbitrary page. */
export const SWEEP_BATCH_LIMIT = 5_000;

const QUEUE_NAME = 'shopper-session-cleanup';
const JOB_NAME = 'sweep';
/** Fixed id for the REPEATABLE JOB REGISTRATION, same reason as
 * `stock-reservation.worker.ts`: a restart must re-register the same schedule
 * rather than accumulate a second one that doubles the rate. */
const REPEAT_JOB_ID = 'shopper-session-cleanup-sweep';

export interface SweepResult {
  sessions: number;
  tokens: number;
}

/**
 * One pass. Exported as a plain function, separate from the BullMQ machinery,
 * so tests drive it against a real database with no Redis — the same split
 * every other worker in this codebase uses.
 *
 * Runs on `platformDb` because `ShopperSession` and `ShopperToken` grant
 * `ventia_app` nothing at all (migration 20260822120000): they hold only
 * credential material, so a tenant-scoped connection cannot open them. Deleting
 * across every tenant is exactly the kind of thing that connection is for.
 */
export async function sweepExpiredShopperCredentials(now: Date = new Date()): Promise<SweepResult> {
  const staleSessions = await platformDb.shopperSession.findMany({
    where: { expiresAt: { lt: now } },
    select: { id: true },
    orderBy: { expiresAt: 'asc' },
    take: SWEEP_BATCH_LIMIT,
  });
  const staleTokens = await platformDb.shopperToken.findMany({
    where: {
      OR: [
        { expiresAt: { lt: now } },
        { consumedAt: { lt: new Date(now.getTime() - SPENT_TOKEN_GRACE_MS) } },
      ],
    },
    select: { id: true },
    orderBy: { expiresAt: 'asc' },
    take: SWEEP_BATCH_LIMIT,
  });

  const [sessions, tokens] = await Promise.all([
    platformDb.shopperSession.deleteMany({ where: { id: { in: staleSessions.map((r) => r.id) } } }),
    platformDb.shopperToken.deleteMany({ where: { id: { in: staleTokens.map((r) => r.id) } } }),
  ]);

  if (staleSessions.length === SWEEP_BATCH_LIMIT || staleTokens.length === SWEEP_BATCH_LIMIT) {
    // Never truncate silently: hitting the cap means the backlog is larger
    // than one run can clear, and a healthy sweep should be distinguishable
    // from a persistently saturated one.
    console.warn('[shopper-session-cleanup] sweep hit its batch limit — remainder deferred to the next run', {
      limit: SWEEP_BATCH_LIMIT,
    });
  }

  return { sessions: sessions.count, tokens: tokens.count };
}

/**
 * Schedules the sweep.
 *
 * Not started by Nest's lifecycle — `start()` is called explicitly from
 * `main.ts`, like every other worker here, because Nest instantiates the whole
 * graph in every test that builds the app and a worker that opened Redis on
 * construction would open one in all of them.
 */
@Injectable()
export class ShopperSessionCleanupWorker implements OnModuleDestroy {
  private connection: Redis | null = null;
  private queue: Queue | null = null;
  private worker: Worker | null = null;

  async start(): Promise<void> {
    // A dedicated ioredis connection with `maxRetriesPerRequest: null`, which
    // BullMQ requires of any connection handed to a Queue/Worker. Same
    // reasoning, at more length, in stock-reservation.worker.ts.
    const connectionOptions: ConnectionOptions = { maxRetriesPerRequest: null };
    this.connection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', connectionOptions);
    this.connection.on('error', (err) => console.error('[shopper-session-cleanup] redis error', err.message));

    this.queue = new Queue(QUEUE_NAME, { connection: this.connection });
    await this.queue.add(JOB_NAME, {}, { repeat: { every: SWEEP_INTERVAL_MS }, jobId: REPEAT_JOB_ID });

    this.worker = new Worker(
      QUEUE_NAME,
      async () => {
        const { sessions, tokens } = await sweepExpiredShopperCredentials();
        if (sessions > 0 || tokens > 0) {
          console.log(`[shopper-session-cleanup] removed ${sessions} session(s) and ${tokens} token(s)`);
        }
      },
      { connection: this.connection },
    );
    this.worker.on('failed', (job, err) => {
      console.error('[shopper-session-cleanup] sweep job failed', { jobId: job?.id, error: err.message });
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
    this.connection?.disconnect();
  }
}
