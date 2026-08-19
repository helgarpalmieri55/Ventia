import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient as PrismaClientType } from '@ventia/db';
import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { startTestDb } from './helpers';
import { MANAGED_QUEUES } from '../src/observability/queues';
import { REDACTED_EMAIL, REDACTED_ID } from '../src/observability/scrub';
import type { signUpAndGetCookie as SignUpAndGetCookie } from './admin-helpers';

/**
 * `GET /v1/observability/queues` (docs/SPEC.md §9 "BullMQ dashboards").
 *
 * Queue state is CROSS-TENANT platform data — the counts aggregate every
 * merchant on the instance and a failure message can name one merchant's
 * order to another merchant's eyes. So the access-control half of this file
 * matters more than the feature half, and is written the same way
 * `test/platform-admin.test.ts` writes it: every one of `PlatformAdminGuard`'s
 * three independent conditions is withheld separately, and each withholding
 * must deny on its own.
 *
 * The feature half is proven against REAL BullMQ state in a real Redis: a job
 * is enqueued, a worker is made to fail with a message containing a shopper's
 * email and cédula, and the endpoint is then asserted to report the failure
 * with those values scrubbed.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENDPOINT = '/v1/observability/queues';
const OPERATOR = 'ops@ventia.co';
const MERCHANT = 'tienda@correo.co';
const ALLOWLIST = ` OPS@Ventia.co `;
/** A message a real worker could genuinely produce: `expireReservations()`
 * logs the error of any order it fails to expire, and those errors come from
 * Prisma, which quotes column values. */
const FAILURE_MESSAGE = 'no se pudo expirar el pedido de ana.gomez@correo.co (cc 1020345678)';

let db: Awaited<ReturnType<typeof startTestDb>>;
let redisContainer: StartedTestContainer;
let app: INestApplication;
let platformDb: PrismaClientType;
let signUpAndGetCookie: typeof SignUpAndGetCookie;
let redisUrl: string;

/** Signs a user up once and returns their cookie; the grants are applied per
 * call so a test can withhold exactly one of them. Both are set directly in
 * the database because no application code path sets `isPlatformAdmin` — that
 * is the column's whole purpose (see platform-admin.guard.ts). */
const cookies = new Map<string, string>();
async function cookieFor(email: string, opts: { verified?: boolean; flagged?: boolean } = {}): Promise<string> {
  let cookie = cookies.get(email);
  if (!cookie) {
    cookie = await signUpAndGetCookie(email);
    cookies.set(email, cookie);
  }
  await platformDb.user.update({
    where: { email },
    data: { emailVerified: opts.verified !== false, isPlatformAdmin: opts.flagged !== false },
  });
  return cookie;
}

beforeAll(async () => {
  db = await startTestDb();
  redisContainer = await new GenericContainer('redis:7-alpine')
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
    .start();

  redisUrl = `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`;
  // Before the first import of @ventia/db / ../src/main — both read env at
  // module-evaluation time.
  process.env.DATABASE_URL = db.url;
  process.env.REDIS_URL = redisUrl;
  process.env.PLATFORM_ADMIN_EMAILS = ALLOWLIST;

  ({ platformDb } = await import('@ventia/db'));
  const { createApp } = await import('../src/main');
  app = await createApp();
  await app.init();
  ({ signUpAndGetCookie } = await import('./admin-helpers'));
}, 240_000);

afterAll(async () => {
  await app.close();
  await redisContainer.stop();
  await db.stop();
});

describe('access control', () => {
  it('401s an anonymous caller', async () => {
    const res = await request(app.getHttpServer()).get(ENDPOINT);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHENTICATED');
  });

  it('403s a signed-in merchant who is not on the allowlist', async () => {
    const res = await request(app.getHttpServer()).get(ENDPOINT).set('cookie', await cookieFor(MERCHANT));
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('NOT_PLATFORM_ADMIN');
    // The response must not distinguish "not allowlisted" from "not verified"
    // from "column not set" — a merchant probing this learns only "not you".
    expect(JSON.stringify(res.body)).not.toContain('allowlist');
  });

  it('403s an allowlisted operator whose email is not verified', async () => {
    const cookie = await cookieFor(OPERATOR, { verified: false });
    const res = await request(app.getHttpServer()).get(ENDPOINT).set('cookie', cookie);
    expect(res.status).toBe(403);
  });

  it('403s an allowlisted, verified operator without User.isPlatformAdmin', async () => {
    const cookie = await cookieFor(OPERATOR, { flagged: false });
    const res = await request(app.getHttpServer()).get(ENDPOINT).set('cookie', cookie);
    expect(res.status).toBe(403);
  });

  it('403s everyone when PLATFORM_ADMIN_EMAILS is unset — fails closed', async () => {
    const cookie = await cookieFor(OPERATOR);
    delete process.env.PLATFORM_ADMIN_EMAILS;
    try {
      const res = await request(app.getHttpServer()).get(ENDPOINT).set('cookie', cookie);
      expect(res.status).toBe(403);
    } finally {
      process.env.PLATFORM_ADMIN_EMAILS = ALLOWLIST;
    }
  });

  it('admits a full operator', async () => {
    const res = await request(app.getHttpServer()).get(ENDPOINT).set('cookie', await cookieFor(OPERATOR));
    expect(res.status).toBe(200);
  });
});

describe('the report, against real BullMQ state', () => {
  let connection: IORedis;

  beforeAll(async () => {
    connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });

    // A job nobody will process: shows up as `waiting`. Registered with the
    // same repeat options the real worker uses, so the `schedules` field —
    // the most diagnostic one in the report — is exercised too.
    const idle = new Queue('conversation-retention', { connection });
    await idle.add('sweep', {});
    await idle.add('sweep', {}, { repeat: { every: 3_600_000 }, jobId: 'conversation-retention-sweep' });
    await idle.close();

    // A job that fails, with a message carrying a shopper's data.
    const failing = new Queue('stock-reservation-expiry', { connection });
    await failing.add('sweep', {});
    const worker = new Worker(
      'stock-reservation-expiry',
      async () => {
        throw new Error(FAILURE_MESSAGE);
      },
      { connection },
    );
    await new Promise<void>((resolve) => worker.once('failed', () => resolve()));
    await worker.close();
    await failing.close();
  }, 60_000);

  afterAll(async () => {
    await connection.quit();
  });

  it('reports counts for every managed queue', async () => {
    const res = await request(app.getHttpServer()).get(ENDPOINT).set('cookie', await cookieFor(OPERATOR));
    expect(res.status).toBe(200);
    expect(res.body.redis).toEqual({ ok: true });
    expect(res.body.queues.map((q: { name: string }) => q.name)).toEqual(MANAGED_QUEUES.map((q) => q.name));

    const byName = Object.fromEntries(res.body.queues.map((q: { name: string }) => [q.name, q]));
    expect(byName['conversation-retention'].counts.waiting).toBe(1);
    // An empty `schedules` on a queue that should have one means the process
    // that calls `start()` never ran — the failure this field exists to name.
    expect(byName['conversation-retention'].schedules).toHaveLength(1);
    expect(byName['conversation-retention'].schedules[0].every).toBe(3_600_000);
    expect(byName['subscription-sweep'].schedules).toEqual([]);
    expect(byName['stock-reservation-expiry'].counts.failed).toBe(1);
    // A queue nobody has touched reports zeros rather than an error — "no
    // jobs" and "cannot read the queue" must not look the same.
    expect(byName['subscription-sweep'].counts).toMatchObject({ waiting: 0, active: 0, failed: 0 });
  });

  it('returns recent failures with the error message scrubbed', async () => {
    const res = await request(app.getHttpServer()).get(ENDPOINT).set('cookie', await cookieFor(OPERATOR));
    const queue = res.body.queues.find((q: { name: string }) => q.name === 'stock-reservation-expiry');
    expect(queue.failures).toHaveLength(1);
    expect(queue.failures[0].name).toBe('sweep');
    expect(queue.failures[0].reason).toBe(
      `no se pudo expirar el pedido de ${REDACTED_EMAIL} (cc ${REDACTED_ID})`,
    );
    expect(JSON.stringify(res.body)).not.toContain('ana.gomez@correo.co');
  });

  it('honours ?failures=0 and clamps nonsense to the default', async () => {
    const cookie = await cookieFor(OPERATOR);
    const none = await request(app.getHttpServer()).get(`${ENDPOINT}?failures=0`).set('cookie', cookie);
    expect(none.body.queues.every((q: { failures: unknown[] }) => q.failures.length === 0)).toBe(true);

    const nonsense = await request(app.getHttpServer()).get(`${ENDPOINT}?failures=abc`).set('cookie', cookie);
    expect(nonsense.status).toBe(200);
    expect(
      nonsense.body.queues.find((q: { name: string }) => q.name === 'stock-reservation-expiry').failures,
    ).toHaveLength(1);
  });

  it('reports whether error reporting is on — it is not, in a test process', async () => {
    const res = await request(app.getHttpServer()).get(ENDPOINT).set('cookie', await cookieFor(OPERATOR));
    expect(res.body.sentry).toEqual({ enabled: false, reason: 'no-dsn' });
  });
});

describe('the queue-name registry', () => {
  it('matches every worker’s own QUEUE_NAME constant', () => {
    // The registry duplicates four module-private constants in files this
    // module does not own. This reads each worker's source and fails if the
    // copy has drifted — the cheapest possible guard against a dashboard that
    // silently reports on a queue nobody writes to.
    for (const managed of MANAGED_QUEUES) {
      const source = readFileSync(path.resolve(__dirname, '..', managed.source), 'utf8');
      const match = source.match(/^const QUEUE_NAME = '([^']+)';$/m);
      expect(match?.[1], managed.source).toBe(managed.name);
    }
  });
});
