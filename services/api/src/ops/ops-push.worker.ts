import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import Redis from 'ioredis';
import { OpsMetricsService, type OpsSnapshot } from './ops-metrics.service';
import { configuredToken } from './ops-token.guard';

/** Where the snapshot is POSTed. Unset disables the push entirely — the pull
 * endpoint keeps working on its own. */
export const OPS_PUSH_URL_ENV = 'OPS_PUSH_URL';
/** How often, in seconds. Optional; see {@link DEFAULT_PUSH_INTERVAL_MS}. */
export const OPS_PUSH_INTERVAL_ENV = 'OPS_PUSH_INTERVAL_SECONDS';

/**
 * One minute, matching the cadence of the other sweeps in this codebase.
 *
 * Fast enough that a cost spike or a store going critical is noticed inside a
 * coffee break, slow enough that the snapshot's aggregate queries — a handful
 * of grouped counts over `Order` and `AgentUsage` — are irrelevant load.
 */
export const DEFAULT_PUSH_INTERVAL_MS = 60_000;
/** Floor on the configured interval. A one-second push is not monitoring, it
 * is a self-inflicted load test against your own database. */
export const MIN_PUSH_INTERVAL_MS = 10_000;

/** How long the receiving endpoint gets before the attempt is abandoned. The
 * next tick carries fresher data anyway, so hanging on a slow receiver only
 * risks overlapping runs. */
const PUSH_TIMEOUT_MS = 10_000;

const QUEUE_NAME = 'ops-push';
const JOB_NAME = 'push';
/** Fixed id for the REPEATABLE JOB REGISTRATION, same reason as
 * `stock-reservation.worker.ts`: a process restart must re-register the same
 * schedule rather than accumulate a second one that doubles the rate. */
const REPEAT_JOB_ID = 'ops-push-snapshot';

/** Header carrying the HMAC of the body, so the receiver can verify the POST
 * came from this platform and not from anyone who learned the URL. */
export const SIGNATURE_HEADER = 'x-ventia-signature';
/** Header carrying the timestamp the signature covers, so a captured body
 * cannot be replayed indefinitely. */
export const TIMESTAMP_HEADER = 'x-ventia-timestamp';

export interface PushConfig {
  url: string;
  intervalMs: number;
  secret: string;
}

/**
 * Reads the push configuration, or `null` when the push should not run.
 *
 * Requires BOTH a URL and the OPS token: the token doubles as the HMAC secret,
 * so a URL without one would mean POSTing every tenant's cost and health to an
 * endpoint with nothing proving where it came from. Refusing to start is the
 * right answer — an unsigned feed the receiver cannot authenticate is worse
 * than no feed, because it will be trusted anyway.
 */
export function pushConfig(env: NodeJS.ProcessEnv = process.env): PushConfig | null {
  const url = (env[OPS_PUSH_URL_ENV] ?? '').trim();
  if (url.length === 0) return null;

  const secret = configuredToken(env);
  if (secret === null) return null;

  // Refuse anything that is not an absolute http(s) URL rather than letting
  // `fetch` decide at push time — a typo here would otherwise be discovered as
  // a recurring error log instead of at startup.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

  return { url: parsed.toString(), intervalMs: pushIntervalMs(env), secret };
}

/** The configured interval, clamped up to {@link MIN_PUSH_INTERVAL_MS}. An
 * unparseable or absent value takes the default rather than failing: a
 * mistyped cadence should not take the whole feed down. */
export function pushIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number((env[OPS_PUSH_INTERVAL_ENV] ?? '').trim());
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_PUSH_INTERVAL_MS;
  return Math.max(MIN_PUSH_INTERVAL_MS, Math.round(raw * 1000));
}

/**
 * `HMAC-SHA256(timestamp + "." + body)`, hex.
 *
 * The timestamp is inside the signed material, not merely alongside it — a
 * signature over the body alone lets anyone who captures one POST replay it
 * forever, and the receiver would have no way to tell a replay from a genuine
 * repeat of an unchanged snapshot.
 */
export function signPayload(secret: string, timestamp: string, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

/**
 * Sends one snapshot. Exported as a plain function, separate from the BullMQ
 * machinery below, so tests drive it with a fake `fetch` and no Redis — the
 * same split `stock-reservation.worker.ts` uses.
 *
 * Returns whether the receiver accepted it. Never throws: a monitoring push
 * that crashes the worker on a receiver outage is a monitoring system that
 * goes down with the thing it monitors.
 */
export async function pushSnapshot(
  snapshot: OpsSnapshot,
  config: PushConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const body = JSON.stringify(snapshot);
  const timestamp = snapshot.generatedAt;

  try {
    const response = await fetchImpl(config.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [TIMESTAMP_HEADER]: timestamp,
        [SIGNATURE_HEADER]: signPayload(config.secret, timestamp, body),
      },
      body,
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.warn('[ops-push] receiver rejected the snapshot', { status: response.status });
      return false;
    }
    return true;
  } catch (error) {
    console.error('[ops-push] could not deliver the snapshot', {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Posts the OPS snapshot on a schedule.
 *
 * ## Why a push at all, when there is a pull endpoint
 *
 * A polled endpoint that stops being polled looks exactly like one that stops
 * being available — the OPS app cannot tell "Ventia is down" from "my poller
 * died". A push that keeps arriving makes the ABSENCE of data a signal in its
 * own right, which is the only way "is it up?" gets a trustworthy answer.
 *
 * ## Not started by Nest's lifecycle
 *
 * Like every other worker here, `start()` is called explicitly from `main.ts`
 * rather than from `onModuleInit`. Nest instantiates the whole graph in every
 * test that builds the app, and a worker that opened a Redis connection on
 * construction would open one in all of them.
 */
@Injectable()
export class OpsPushWorker implements OnModuleDestroy {
  private connection: Redis | null = null;
  private queue: Queue | null = null;
  private worker: Worker | null = null;

  // Explicit @Inject: esbuild (vitest's transform) emits no `design:paramtypes`.
  constructor(@Inject(OpsMetricsService) private readonly metrics: OpsMetricsService) {}

  /** Starts the schedule, or does nothing when the push is not configured. */
  async start(): Promise<void> {
    const config = pushConfig();
    if (config === null) {
      console.log('[ops-push] not configured — pull endpoint only');
      return;
    }

    // A dedicated ioredis connection with `maxRetriesPerRequest: null`, which
    // BullMQ requires of any connection handed to a Queue/Worker. Same
    // reasoning, at more length, in stock-reservation.worker.ts.
    const connectionOptions: ConnectionOptions = { maxRetriesPerRequest: null };
    this.connection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', connectionOptions);
    this.connection.on('error', (err) => console.error('[ops-push] redis error', err.message));

    this.queue = new Queue(QUEUE_NAME, { connection: this.connection });
    await this.queue.add(JOB_NAME, {}, { repeat: { every: config.intervalMs }, jobId: REPEAT_JOB_ID });

    this.worker = new Worker(
      QUEUE_NAME,
      async () => {
        // Re-read the config each tick rather than closing over the one from
        // `start()`: an operator rotating the token or changing the receiver
        // should not have to restart the API for the push to follow.
        const current = pushConfig();
        if (current === null) return;
        await pushSnapshot(await this.metrics.snapshot(), current);
      },
      { connection: this.connection },
    );
    this.worker.on('failed', (job, err) => {
      console.error('[ops-push] push job failed', { jobId: job?.id, error: err.message });
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
    this.connection?.disconnect();
  }
}
