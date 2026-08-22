import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient as PrismaClientType } from '@ventia/db';
import { startTestDb } from './helpers';
import { MIN_TOKEN_LENGTH, OPS_TOKEN_ENV } from '../src/ops/ops-token.guard';
import { INPUT_PRICE_ENV, OUTPUT_PRICE_ENV } from '../src/agent/agent-pricing';

/**
 * `GET /v1/ops/metrics` — the feed an external OPS application polls for cost
 * and uptime.
 *
 * Two properties matter more than the shape of the payload: it must be
 * unreachable without the machine credential, and it must never report a cost
 * it did not actually compute. The second is not hypothetical — `costCents`
 * was a column nothing wrote, and the operator console read it and showed
 * every tenant as free.
 */

const TOKEN = 'v'.repeat(MIN_TOKEN_LENGTH);
const MONTH = new Date().toISOString().slice(0, 7);

let db: Awaited<ReturnType<typeof startTestDb>>;
let prisma: PrismaClientType;
let app: INestApplication;
let liveTenantId: string;
let quietTenantId: string;

beforeAll(async () => {
  db = await startTestDb();
  process.env.DATABASE_URL = db.url;
  process.env.REDIS_URL = 'redis://localhost:6379';
  process.env[OPS_TOKEN_ENV] = TOKEN;

  const { createApp } = await import('../src/main');
  app = await createApp();
  await app.init();
  ({ platformDb: prisma } = await import('@ventia/db'));

  // A live store, verified domain, real usage this month.
  const live = await prisma.tenant.create({
    data: { slug: `ops-live-${Date.now()}`, name: 'Ops Live', status: 'live', plan: 'pro' },
  });
  liveTenantId = live.id;
  await prisma.tenantLimits.create({
    data: { tenantId: liveTenantId, productsMax: 1000, aiMessagesMonth: 100, staffSeats: 3, customDomain: true },
  });
  await prisma.tenantDomain.create({
    data: { tenantId: liveTenantId, domain: `${live.slug}.ventia.localhost`, isPrimary: true, verifiedAt: new Date() },
  });
  await prisma.agentUsage.create({
    data: {
      tenantId: liveTenantId,
      month: MONTH,
      messagesCount: 95,
      inputTokens: 1_000_000,
      outputTokens: 200_000,
      costMicroUsd: 6_000_000n,
    },
  });

  // A live store with NO domain at all — unreachable, which is critical.
  const quiet = await prisma.tenant.create({
    data: { slug: `ops-quiet-${Date.now()}`, name: 'Ops Quiet', status: 'live', plan: 'basico' },
  });
  quietTenantId = quiet.id;
  await prisma.tenantLimits.create({
    data: { tenantId: quietTenantId, productsMax: 100, aiMessagesMonth: 500, staffSeats: 1, customDomain: false },
  });
});

afterAll(async () => {
  delete process.env[OPS_TOKEN_ENV];
  delete process.env[INPUT_PRICE_ENV];
  delete process.env[OUTPUT_PRICE_ENV];
  await app.close();
  await db.stop();
});

function get(token: string | null) {
  const req = request(app.getHttpServer()).get('/v1/ops/metrics');
  return token === null ? req : req.set('authorization', `Bearer ${token}`);
}

describe('GET /v1/ops/metrics — access', () => {
  it('refuses an anonymous request', async () => {
    expect((await get(null)).status).toBe(401);
  });

  it('refuses a wrong token', async () => {
    expect((await get('w'.repeat(MIN_TOKEN_LENGTH))).status).toBe(401);
  });

  it('refuses a token that is merely a prefix of the real one', async () => {
    expect((await get(TOKEN.slice(0, -1))).status).toBe(401);
  });

  it('answers 503, not 200, when no token is configured at all', async () => {
    // Fails CLOSED. A metrics endpoint that opens up when its secret goes
    // missing hands every tenant's data to anyone who finds the URL — and
    // unlike an outage, nobody notices.
    const previous = process.env[OPS_TOKEN_ENV];
    delete process.env[OPS_TOKEN_ENV];
    try {
      const res = await get(TOKEN);
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: 'OPS_FEED_NOT_CONFIGURED' });
    } finally {
      process.env[OPS_TOKEN_ENV] = previous;
    }
  });

  it('serves the snapshot with the right token', async () => {
    expect((await get(TOKEN)).status).toBe(200);
  });
});

describe('GET /v1/ops/metrics — cost', () => {
  it('reports cost as null, never zero, when prices are unconfigured', async () => {
    delete process.env[INPUT_PRICE_ENV];
    delete process.env[OUTPUT_PRICE_ENV];

    const res = await get(TOKEN);

    expect(res.body.platform.costConfigured).toBe(false);
    expect(res.body.platform.ai.costMicroUsd).toBeNull();
    expect(res.body.platform.ai.costCents).toBeNull();
    const store = res.body.stores.find((s: { tenantId: string }) => s.tenantId === liveTenantId);
    expect(store.ai.costCents).toBeNull();
    // BOTH cost fields, not just the rounded one: an OPS dashboard summing
    // `costMicroUsd` across stores would otherwise total a confident zero.
    expect(store.ai.costMicroUsd).toBeNull();
    // The token counters are still real and still reported — only the money
    // is unknown.
    expect(store.ai.inputTokens).toBe(1_000_000);
  });

  it('reports real cost once prices are configured', async () => {
    process.env[INPUT_PRICE_ENV] = '3';
    process.env[OUTPUT_PRICE_ENV] = '15';

    const res = await get(TOKEN);

    expect(res.body.platform.costConfigured).toBe(true);
    const store = res.body.stores.find((s: { tenantId: string }) => s.tenantId === liveTenantId);
    // 6,000,000 micro-USD = $6.00 = 600 cents.
    expect(store.ai.costMicroUsd).toBe(6_000_000);
    expect(store.ai.costCents).toBe(600);
    expect(res.body.platform.ai.costMicroUsd).toBeGreaterThanOrEqual(6_000_000);
  });

  it('never emits a bigint, which JSON cannot carry', async () => {
    // `costMicroUsd` is a Postgres BIGINT and Prisma hands back a JS bigint;
    // `JSON.stringify` throws on one outright, so a missed conversion is a 500
    // rather than a wrong number.
    process.env[INPUT_PRICE_ENV] = '3';
    process.env[OUTPUT_PRICE_ENV] = '15';
    const res = await get(TOKEN);
    expect(res.status).toBe(200);
    expect(typeof res.body.platform.ai.costMicroUsd).toBe('number');
  });
});

describe('GET /v1/ops/metrics — per-store health', () => {
  it('flags a live store with no domain as critical, because nobody can reach it', async () => {
    const res = await get(TOKEN);
    const store = res.body.stores.find((s: { tenantId: string }) => s.tenantId === quietTenantId);

    expect(store.issues).toContain('no_primary_domain');
    expect(store.health).toBe('critical');
  });

  it('flags a store near its AI limit as a warning, not a failure', async () => {
    // 95 of 100 is past the 90% threshold. The agent still answers, so this is
    // something to act on before it becomes an outage — not one yet.
    const res = await get(TOKEN);
    const store = res.body.stores.find((s: { tenantId: string }) => s.tenantId === liveTenantId);

    expect(store.ai.percentUsed).toBe(95);
    expect(store.issues).toContain('ai_budget_warning');
    expect(store.health).toBe('warning');
  });

  it('distinguishes an unprovisioned budget from an unused one', async () => {
    // A tenant with no TenantLimits row is hard-capped at zero by
    // AgentBudgetService — its agent never answers anyone. Reporting that as
    // "0 of 0 messages used, all good" is how a dead store looks healthy.
    const orphan = await prisma.tenant.create({
      data: { slug: `ops-orphan-${Date.now()}`, name: 'Ops Orphan', status: 'live' },
    });
    await prisma.tenantDomain.create({
      data: { tenantId: orphan.id, domain: `${orphan.slug}.ventia.localhost`, isPrimary: true, verifiedAt: new Date() },
    });

    const res = await get(TOKEN);
    const store = res.body.stores.find((s: { tenantId: string }) => s.tenantId === orphan.id);

    expect(store.ai.messagesLimit).toBe(0);
    expect(store.ai.percentUsed).toBeNull();
    expect(store.issues).toContain('ai_budget_unprovisioned');
  });

  it('does not call a draft store unreachable — it is mid-onboarding, not broken', async () => {
    const draft = await prisma.tenant.create({
      data: { slug: `ops-draft-${Date.now()}`, name: 'Ops Draft', status: 'draft' },
    });
    await prisma.tenantLimits.create({
      data: { tenantId: draft.id, productsMax: 100, aiMessagesMonth: 500, staffSeats: 1, customDomain: false },
    });

    const res = await get(TOKEN);
    const store = res.body.stores.find((s: { tenantId: string }) => s.tenantId === draft.id);

    expect(store.issues).not.toContain('no_primary_domain');
    expect(store.health).toBe('ok');
  });
});

describe('GET /v1/ops/metrics — platform', () => {
  it('reports dependency health and process uptime', async () => {
    const res = await get(TOKEN);

    expect(res.body.dependencies.database.ok).toBe(true);
    expect(typeof res.body.dependencies.database.latencyMs).toBe('number');
    expect(typeof res.body.dependencies.redis.ok).toBe('boolean');
    expect(res.body.platform.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(res.body.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('counts tenants by status', async () => {
    const res = await get(TOKEN);
    expect(res.body.platform.tenants.total).toBe(res.body.stores.length);
    expect(res.body.platform.tenants.live).toBeGreaterThanOrEqual(2);
  });
});

describe('dependency error text leaving this process', () => {
  it('scrubs what has no business crossing the network, and keeps what an operator needs', async () => {
    const { message } = await import('../src/ops/ops-metrics.service');

    // A driver that quotes the URL it failed to connect with. The host and
    // port stay — "which database is down" is the whole point of the field —
    // and the credential does not.
    const withToken = message(new Error('connect failed: Authorization: Bearer abcdef0123456789abcdef0123456789'));
    expect(withToken).not.toContain('abcdef0123456789abcdef0123456789');

    // An exception that interpolated a shopper into its text. This payload is
    // POSTed to a configured URL with nobody reading it first.
    const withPii = message(new Error('row for ana@example.com (cédula 1020345678) failed'));
    expect(withPii).not.toContain('ana@example.com');
    expect(withPii).not.toContain('1020345678');

    // Still useful: the operator can tell which dependency and why.
    const plain = message(new Error("Can't reach database server at db.internal:5432"));
    expect(plain).toContain('db.internal');
    expect(plain).toContain("Can't reach database server");
  });

  it('handles a thrown non-Error without losing it', () => {
    // Deliberately not `String(error)` of an Error — a rejected promise can
    // carry anything.
    return import('../src/ops/ops-metrics.service').then(({ message }) => {
      expect(message('redis timeout')).toBe('redis timeout');
      expect(message(undefined)).toBe('undefined');
    });
  });
});
