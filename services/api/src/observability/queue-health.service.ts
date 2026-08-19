import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { MANAGED_QUEUES } from './queues';
import { scrubString } from './scrub';
import { sentryStatus } from './sentry';

/**
 * Read-only queue health (docs/SPEC.md §9 "BullMQ dashboards").
 *
 * ## Why a JSON endpoint and not `bull-board`
 *
 * The obvious move is to mount `bull-board`. It was rejected, for four
 * reasons that compound:
 *
 * 1. **It mounts its own Express router inside a guarded Nest app.** Nest
 *    guards protect Nest ROUTES; a third-party router mounted on the
 *    underlying Express instance is not a Nest route, so `PlatformAdminGuard`
 *    does not apply to it unless it is re-implemented as raw middleware in
 *    front of the mount. This app already carries a hard-won lesson about
 *    exactly that seam — `main.ts` mounts its rate limiters on the Express
 *    adapter *because* `/v1/auth/*` never reaches Nest routing. Cross-tenant
 *    queue state, which includes other merchants' order ids in failure
 *    messages, is not the thing to protect with a second, hand-rolled copy of
 *    the platform-admin check.
 * 2. **It is read-WRITE by default.** The UI's buttons retry, promote and
 *    remove jobs. "Retry" on `subscription-sweep` re-runs a job that suspends
 *    tenants. A dashboard whose default affordance is to re-trigger
 *    tenant-suspension is a bigger operational risk than having no dashboard.
 * 3. **It is a UI, and there is no UI agent on this task.** Its value is
 *    realized in a browser by a human who is signed in with a session cookie
 *    — which is precisely the request shape a mounted-router auth gap gets
 *    wrong. A JSON endpoint is equally usable from `curl`, from a monitoring
 *    check, and from a test.
 * 4. **New dependency, new attack surface**, rendering server-supplied job
 *    data (i.e. gateway webhook fragments in failure messages) as HTML in an
 *    operator's authenticated browser session.
 *
 * What is lost: charts, and one-click retry. Neither was asked for. What is
 * gained: every byte this endpoint emits is produced by code in this file,
 * passes through the same scrubber as our telemetry, sits behind the same
 * guard as the rest of the platform surface, and is asserted on by a test.
 *
 * ## Nothing starts on its own
 *
 * The same discipline the four workers follow, for the same reason: this
 * service opens NO connection at construction. `AppModule` is built by every
 * test file in this repo, and a Redis connection (or worse, a `Queue`) opened
 * from a constructor or an `OnModuleInit` would be opened in all of them. The
 * connection is created on the first request that gets past the guard, and
 * torn down by `OnModuleDestroy`.
 */

/** Per-queue job counts. Named exactly as BullMQ returns them. */
export interface QueueCounts {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  paused: number;
}

export interface QueueFailure {
  id: string | null;
  name: string;
  /** Attempts made before the job was moved to `failed`. */
  attempts: number;
  /** When it failed, ISO-8601. */
  at: string | null;
  /** The error message, **scrubbed** — see the note in `snapshot()`. */
  reason: string | null;
}

export interface QueueReport {
  name: string;
  meaning: string;
  counts: QueueCounts | null;
  /** Registered repeat schedules. Empty on a queue that should have one is
   * the single most diagnostic field here: it means the process that calls
   * `start()` never ran, so the sweep is not merely slow, it is absent. */
  schedules: Array<{ key: string; name: string | null; every: string | number | null; next: string | null }>;
  failures: QueueFailure[];
  /** Populated instead of `counts` when this queue could not be read. */
  error?: string;
}

export interface QueueHealthReport {
  generatedAt: string;
  redis: { ok: boolean; error?: string };
  /** Whether error reporting is on, and why not if it is off. Included here
   * because "are we blind?" is the same question an operator opens this
   * endpoint to ask, and it is not worth a second protected route. */
  sentry: { enabled: boolean; reason?: string; environment?: string };
  queues: QueueReport[];
}

/** Recent failures returned per queue unless the caller asks for fewer/more. */
export const DEFAULT_FAILURE_LIMIT = 10;
/** Hard ceiling on the caller-supplied limit — this endpoint reads job
 * payloads out of Redis synchronously, and an operator with a slipped finger
 * should not be able to ask for ten thousand of them. */
export const MAX_FAILURE_LIMIT = 50;
/** A queue read that has not answered by now is treated as a Redis failure.
 * An operator endpoint that hangs is worse than one that says "unreachable":
 * the second answer is actionable, the first looks like the API is down. */
const READ_TIMEOUT_MS = 5000;

@Injectable()
export class QueueHealthService implements OnModuleDestroy {
  private connection: Redis | null = null;
  private queues: Map<string, Queue> = new Map();

  /**
   * A dedicated ioredis connection, for the same reason
   * `stock-reservation.worker.ts` opens its own rather than reusing
   * `REDIS_CLIENT`: BullMQ and `DomainResolver` want different retry
   * behaviour and neither should be tuned for the other.
   *
   * The options differ from the workers' in one deliberate way. A worker sets
   * `maxRetriesPerRequest: null` (retry forever) because it is a background
   * process with nobody waiting. This is an HTTP request handler: retrying
   * forever means an operator's `curl` hangs until their client gives up. So
   * it retries a bounded number of times and gives up loudly. BullMQ only
   * *requires* `null` on blocking connections (`Worker`s) — verified in
   * `bullmq/dist/cjs/classes/redis-connection.js`, whose `checkBlockingOptions`
   * is a no-op unless `blocking` is true, and `QueueBase` passes
   * `hasBlockingConnection = false` for a `Queue`.
   */
  private getConnection(): Redis {
    if (!this.connection) {
      this.connection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
        maxRetriesPerRequest: 2,
        connectTimeout: 2000,
        lazyConnect: true,
      });
      // Swallowed rather than crashing the process: an unreachable Redis is
      // reported in the response body, which is the whole point of a health
      // endpoint. Without a listener, ioredis emits an unhandled 'error'.
      this.connection.on('error', () => {});
    }
    return this.connection;
  }

  private getQueue(name: string): Queue {
    let queue = this.queues.get(name);
    if (!queue) {
      queue = new Queue(name, { connection: this.getConnection() });
      // Same reason as above — a Queue forwards its connection's errors.
      queue.on('error', () => {});
      this.queues.set(name, queue);
    }
    return queue;
  }

  /**
   * Reads every managed queue.
   *
   * Failure messages are passed through `scrub.ts`'s `scrubString` before
   * being returned. That is not decoration: a `failedReason` is an arbitrary
   * error message written by a worker, and the workers process orders — a
   * Prisma error from `expireOneReservation`, or a gateway client's error
   * from reconciliation, can quote a customer's data verbatim. This response
   * crosses a tenant boundary (an operator sees every tenant's queue at
   * once), so it gets the same treatment as data leaving for Sentry.
   */
  async snapshot(failureLimit = DEFAULT_FAILURE_LIMIT): Promise<QueueHealthReport> {
    const limit = Math.min(Math.max(Math.trunc(failureLimit) || 0, 0), MAX_FAILURE_LIMIT);
    const status = sentryStatus();
    const report: QueueHealthReport = {
      generatedAt: new Date().toISOString(),
      redis: { ok: true },
      sentry: status.enabled
        ? { enabled: true, environment: status.environment }
        : { enabled: false, reason: status.reason },
      queues: [],
    };

    for (const managed of MANAGED_QUEUES) {
      try {
        report.queues.push(await withTimeout(this.readQueue(managed.name, managed.meaning, limit), READ_TIMEOUT_MS));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        report.redis = { ok: false, error: scrubString(message) };
        report.queues.push({
          name: managed.name,
          meaning: managed.meaning,
          counts: null,
          schedules: [],
          failures: [],
          error: scrubString(message),
        });
        // One unreachable queue means the Redis behind all of them is
        // unreachable; drop the connection so the NEXT request builds a fresh
        // one instead of inheriting a client stuck in a failed state.
        await this.dispose();
      }
    }

    return report;
  }

  private async readQueue(name: string, meaning: string, limit: number): Promise<QueueReport> {
    const queue = this.getQueue(name);
    const counts = (await queue.getJobCounts(
      'waiting',
      'active',
      'completed',
      'failed',
      'delayed',
      'paused',
    )) as unknown as QueueCounts;

    const schedulers = await queue.getJobSchedulers();
    const failed = limit > 0 ? await queue.getFailed(0, limit - 1) : [];

    return {
      name,
      meaning,
      counts,
      schedules: schedulers.map((s) => ({
        key: String(s.key ?? ''),
        name: s.name ?? null,
        every: s.every ?? s.pattern ?? null,
        next: typeof s.next === 'number' ? new Date(s.next).toISOString() : null,
      })),
      failures: failed.map((job) => ({
        id: job.id ?? null,
        name: job.name,
        attempts: job.attemptsMade,
        at: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
        reason: job.failedReason ? scrubString(job.failedReason) : null,
      })),
    };
  }

  private async dispose(): Promise<void> {
    const queues = [...this.queues.values()];
    this.queues.clear();
    const connection = this.connection;
    this.connection = null;
    for (const queue of queues) {
      try {
        await queue.close();
      } catch {
        // Already closing/closed — nothing useful to do on a teardown path.
      }
    }
    if (connection) {
      try {
        await connection.quit();
      } catch {
        connection.disconnect();
      }
    }
  }

  /** Safe when nothing was ever opened — which is the case in every test that
   * merely builds the module graph. */
  async onModuleDestroy(): Promise<void> {
    await this.dispose();
  }
}

/** Rejects if `promise` has not settled within `ms`. The timer is always
 * cleared, so a slow-but-eventually-successful read does not keep the process
 * alive for the remainder of the timeout. */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`queue read timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
