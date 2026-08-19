import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient as PrismaClientType } from '@ventia/db';
import { startTestDb } from './helpers';
import type { signUpWithTenant as SignUpWithTenant } from './admin-helpers';
import type * as PlanLimitsModule from '../src/common/plan-limits';
import type { WhatsAppNumbersService as WhatsAppNumbersServiceType } from '../src/whatsapp/whatsapp-numbers.service';

/**
 * The shared plan-limit enforcement (docs/SPEC.md §5 point 5).
 *
 * Two things are under test and they are not the same thing:
 *
 *  1. **The posture.** A tenant with no `TenantLimits` row has not been
 *     provisioned onto a plan. For every boolean entitlement that means the
 *     feature is OFF — a store that was never sold WhatsApp must not get it
 *     because nobody wrote a row. This file pins that for all three booleans,
 *     including `customDomain`, which has no call site yet.
 *  2. **The error shape.** All six limits must fail as one
 *     `402 { error: 'PLAN_LIMIT_EXCEEDED', details: { feature, limit? } }`, so
 *     `apps/admin/lib/errors.ts` has exactly one upgrade prompt to render and
 *     the merchant is told which entitlement ran out. The HTTP block at the
 *     bottom asserts that against the real endpoints rather than against the
 *     helper, because the helper being right is worth nothing if a controller
 *     hand-rolls its own body.
 */

let db: Awaited<ReturnType<typeof startTestDb>>;
let redisContainer: StartedTestContainer;
let app: INestApplication;
let platformDb: PrismaClientType;
let signUpWithTenant: typeof SignUpWithTenant;
let numbers: WhatsAppNumbersServiceType;
let planLimits: typeof PlanLimitsModule;

beforeAll(async () => {
  db = await startTestDb();
  redisContainer = await new GenericContainer('redis:7-alpine')
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
    .start();

  // Env before the first import of @ventia/db / ../src/main — both build their
  // Prisma client at module-evaluation time. Same ordering rule as
  // test/products.test.ts.
  process.env.DATABASE_URL = db.url;
  process.env.REDIS_URL = `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`;
  process.env.PAYMENTS_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
  process.env.ANTHROPIC_API_KEY ??= 'sk-ant-test-not-used';

  const { createApp } = await import('../src/main');
  app = await createApp();
  await app.init();

  ({ signUpWithTenant } = await import('./admin-helpers'));
  ({ platformDb } = await import('@ventia/db'));
  planLimits = await import('../src/common/plan-limits');
  const { WhatsAppNumbersService } = await import('../src/whatsapp/whatsapp-numbers.service');
  numbers = app.get(WhatsAppNumbersService);
}, 240_000);

afterAll(async () => {
  await app.close();
  await redisContainer.stop();
  await db.stop();
});

let tenantSeq = 0;

/** A bare tenant with NO `TenantLimits` row — the unprovisioned case. */
async function unprovisionedTenant(): Promise<string> {
  const n = ++tenantSeq;
  const tenant = await platformDb.tenant.create({
    data: { slug: `pl-unprov-${n}-${Date.now()}`, name: `Sin plan ${n}`, status: 'live' },
  });
  return tenant.id;
}

async function tenantWithLimits(overrides: Record<string, unknown> = {}): Promise<string> {
  const n = ++tenantSeq;
  const tenant = await platformDb.tenant.create({
    data: {
      slug: `pl-${n}-${Date.now()}`,
      name: `Con plan ${n}`,
      status: 'live',
      limits: { create: { productsMax: 10, aiMessagesMonth: 100, staffSeats: 2, ...overrides } },
    },
  });
  return tenant.id;
}

/** Runs `fn`, returning the HttpException body it threw (or `null` if it did
 * not throw). Asserting on the body rather than on the class is deliberate:
 * the body is what a merchant's browser receives, and it is the thing that
 * must be identical across all six limits. */
async function bodyOfThrow(fn: () => Promise<unknown>): Promise<unknown | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    return (err as { getResponse: () => unknown }).getResponse();
  }
}

const BOOLEAN_FEATURES = ['customDomain', 'humanHandoff', 'whatsappChannel'] as const;

describe('boolean entitlements: an unprovisioned tenant has them OFF', () => {
  for (const feature of BOOLEAN_FEATURES) {
    it(`${feature}: no TenantLimits row reads as false, not as unlimited`, async () => {
      const tenantId = await unprovisionedTenant();
      expect(await planLimits.isPlanFeatureEnabled(tenantId, feature)).toBe(false);
    });

    it(`${feature}: no TenantLimits row throws the typed 402`, async () => {
      const tenantId = await unprovisionedTenant();
      const body = await bodyOfThrow(() => planLimits.assertPlanFeature(tenantId, feature));
      expect(body).toEqual({ error: 'PLAN_LIMIT_EXCEEDED', details: { feature } });
    });

    it(`${feature}: a row with the flag off throws; with it on, passes`, async () => {
      const off = await tenantWithLimits({ [feature]: false });
      const on = await tenantWithLimits({ [feature]: true });

      expect(await planLimits.isPlanFeatureEnabled(off, feature)).toBe(false);
      expect(await bodyOfThrow(() => planLimits.assertPlanFeature(off, feature))).toEqual({
        error: 'PLAN_LIMIT_EXCEEDED',
        details: { feature },
      });

      expect(await planLimits.isPlanFeatureEnabled(on, feature)).toBe(true);
      expect(await bodyOfThrow(() => planLimits.assertPlanFeature(on, feature))).toBeNull();
    });
  }

  it('the 402 status is what the exception carries, not just the body', async () => {
    const tenantId = await unprovisionedTenant();
    try {
      await planLimits.assertPlanFeature(tenantId, 'whatsappChannel');
      throw new Error('expected assertPlanFeature to throw');
    } catch (err) {
      expect((err as { getStatus: () => number }).getStatus()).toBe(402);
    }
  });
});

describe('numeric quotas', () => {
  it('blocks at the ceiling and reports the limit the merchant was sold', async () => {
    const tenantId = await tenantWithLimits({ productsMax: 3 });

    // 2 used + 1 more = 3, exactly at the limit — allowed.
    expect(
      await bodyOfThrow(() =>
        planLimits.assertPlanQuota({
          tenantId,
          quota: 'productsMax',
          count: async () => 2,
          whenUnprovisioned: 'block',
        }),
      ),
    ).toBeNull();

    // 3 used + 1 more = 4, over — refused, and the body names the feature.
    expect(
      await bodyOfThrow(() =>
        planLimits.assertPlanQuota({
          tenantId,
          quota: 'productsMax',
          count: async () => 3,
          whenUnprovisioned: 'block',
        }),
      ),
    ).toEqual({ error: 'PLAN_LIMIT_EXCEEDED', details: { feature: 'productsMax', limit: 3 } });
  });

  it('`additional` is what a bulk operation would add, not a per-row check', async () => {
    const tenantId = await tenantWithLimits({ productsMax: 10 });
    const check = (additional: number) =>
      bodyOfThrow(() =>
        planLimits.assertPlanQuota({
          tenantId,
          quota: 'productsMax',
          count: async () => 8,
          additional,
          whenUnprovisioned: 'block',
        }),
      );

    expect(await check(2)).toBeNull();
    expect(await check(3)).toEqual({
      error: 'PLAN_LIMIT_EXCEEDED',
      details: { feature: 'productsMax', limit: 10 },
    });
  });

  it("whenUnprovisioned: 'block' refuses an unprovisioned tenant without even counting", async () => {
    const tenantId = await unprovisionedTenant();
    let counted = false;

    const body = await bodyOfThrow(() =>
      planLimits.assertPlanQuota({
        tenantId,
        quota: 'staffSeats',
        count: async () => {
          counted = true;
          return 0;
        },
        whenUnprovisioned: 'block',
      }),
    );

    expect(body).toEqual({ error: 'PLAN_LIMIT_EXCEEDED', details: { feature: 'staffSeats', limit: 0 } });
    // Nothing to compare against means nothing worth counting — the callback
    // is skipped rather than paying for a query whose answer cannot matter.
    expect(counted).toBe(false);
  });

  it("whenUnprovisioned: 'allow' is the legacy fail-open posture productsMax/staffSeats still carry", async () => {
    const tenantId = await unprovisionedTenant();
    expect(
      await bodyOfThrow(() =>
        planLimits.assertPlanQuota({
          tenantId,
          quota: 'productsMax',
          count: async () => 1_000_000,
          whenUnprovisioned: 'allow',
        }),
      ),
    ).toBeNull();
  });

  it('planQuotaExceeded answers exactly what assertPlanQuota would throw on', async () => {
    const provisioned = await tenantWithLimits({ productsMax: 2 });
    const unprovisioned = await unprovisionedTenant();

    const cases = [
      { tenantId: provisioned, used: 1, whenUnprovisioned: 'block' as const, expected: false },
      { tenantId: provisioned, used: 2, whenUnprovisioned: 'block' as const, expected: true },
      { tenantId: unprovisioned, used: 0, whenUnprovisioned: 'block' as const, expected: true },
      { tenantId: unprovisioned, used: 999, whenUnprovisioned: 'allow' as const, expected: false },
    ];

    for (const c of cases) {
      const spec = {
        tenantId: c.tenantId,
        quota: 'productsMax' as const,
        count: async () => c.used,
        whenUnprovisioned: c.whenUnprovisioned,
      };
      // The dry-run flag and the commit-time refusal must never disagree —
      // that is the whole reason both go through this module.
      expect(await planLimits.planQuotaExceeded(spec)).toBe(c.expected);
      expect((await bodyOfThrow(() => planLimits.assertPlanQuota(spec))) !== null).toBe(c.expected);
    }
  });
});

describe('every limit fails as the same HTTP error', () => {
  it('productsMax: 402 naming the feature and the limit', async () => {
    const { cookie, tenantId } = await signUpWithTenant('plan-limits-products@demo.co', 'owner');
    await platformDb.tenantLimits.create({
      data: { tenantId, productsMax: 1, aiMessagesMonth: 100, staffSeats: 2 },
    });

    const first = await request(app.getHttpServer())
      .post('/v1/admin/products')
      .set('cookie', cookie)
      .send({ name: 'Producto Uno', priceCents: 10_000 });
    expect(first.status).toBe(201);

    const second = await request(app.getHttpServer())
      .post('/v1/admin/products')
      .set('cookie', cookie)
      .send({ name: 'Producto Dos', priceCents: 10_000 });

    expect(second.status).toBe(402);
    expect(second.body).toEqual({
      error: 'PLAN_LIMIT_EXCEEDED',
      details: { feature: 'productsMax', limit: 1 },
    });
  });

  it('staffSeats: 402 naming the feature and the limit', async () => {
    const { cookie, tenantId } = await signUpWithTenant('plan-limits-staff@demo.co', 'owner');
    await platformDb.tenantLimits.create({
      data: { tenantId, productsMax: 100, aiMessagesMonth: 100, staffSeats: 1 },
    });

    const first = await request(app.getHttpServer())
      .post('/v1/admin/staff/invites')
      .set('cookie', cookie)
      .send({ email: 'plan-limits-seat-a@demo.co' });
    expect(first.status).toBe(201);

    const second = await request(app.getHttpServer())
      .post('/v1/admin/staff/invites')
      .set('cookie', cookie)
      .send({ email: 'plan-limits-seat-b@demo.co' });

    expect(second.status).toBe(402);
    expect(second.body).toEqual({
      error: 'PLAN_LIMIT_EXCEEDED',
      details: { feature: 'staffSeats', limit: 1 },
    });
  });

  it('whatsappChannel: 402 naming the feature, with no limit number to report', async () => {
    const { cookie, tenantId } = await signUpWithTenant('plan-limits-wa-connect@demo.co', 'owner');
    await platformDb.tenantLimits.create({
      data: { tenantId, productsMax: 100, aiMessagesMonth: 100, staffSeats: 2, whatsappChannel: false },
    });

    const res = await request(app.getHttpServer())
      .post('/v1/admin/whatsapp/numbers')
      .set('cookie', cookie)
      .send({
        provider: 'cloud',
        phoneNumberId: '106540352242001',
        accessToken: 'token-de-prueba-largo',
        appSecret: 'app-secret-de-prueba',
        verifyToken: 'verify-de-prueba',
        displayPhone: '3001112244',
      });

    expect(res.status).toBe(402);
    expect(res.body).toEqual({
      error: 'PLAN_LIMIT_EXCEEDED',
      details: { feature: 'whatsappChannel' },
    });
  });
});

describe('re-enabling a WhatsApp number is plan-gated too', () => {
  it('PATCH status=connected on a downgraded store is refused with the same 402', async () => {
    const { cookie, tenantId } = await signUpWithTenant('plan-limits-wa-reenable@demo.co', 'owner');
    await platformDb.tenantLimits.create({
      data: { tenantId, productsMax: 100, aiMessagesMonth: 100, staffSeats: 2, whatsappChannel: true },
    });
    const number = await numbers.connect({
      tenantId,
      provider: 'cloud',
      externalId: `9990001${Date.now()}`.slice(0, 15),
      displayPhone: '+573001112255',
      credentials: { token: 'tok', appSecret: 'sec', verifyToken: 'ver' },
    });

    // Park it off, then take the plan away. The number stays registered —
    // nothing deletes it — which is exactly the state that made this endpoint
    // a hole: `connect` was gated, `PATCH` was not, so an owner could flip the
    // switch back on and keep the channel a downgrade was supposed to remove.
    await numbers.setStatus(tenantId, number.id, 'disabled');
    await platformDb.tenantLimits.update({ where: { tenantId }, data: { whatsappChannel: false } });

    const res = await request(app.getHttpServer())
      .patch(`/v1/admin/whatsapp/numbers/${number.id}`)
      .set('cookie', cookie)
      .send({ status: 'connected' });

    expect(res.status).toBe(402);
    expect(res.body).toEqual({
      error: 'PLAN_LIMIT_EXCEEDED',
      details: { feature: 'whatsappChannel' },
    });
    expect((await numbers.listForTenant(tenantId))[0].status).toBe('disabled');
  });

  it('PATCH status=disabled stays allowed without the plan — the off switch is never gated', async () => {
    const { cookie, tenantId } = await signUpWithTenant('plan-limits-wa-disable@demo.co', 'owner');
    await platformDb.tenantLimits.create({
      data: { tenantId, productsMax: 100, aiMessagesMonth: 100, staffSeats: 2, whatsappChannel: true },
    });
    const number = await numbers.connect({
      tenantId,
      provider: 'cloud',
      externalId: `9991001${Date.now()}`.slice(0, 15),
      displayPhone: '+573001112266',
      credentials: { token: 'tok', appSecret: 'sec', verifyToken: 'ver' },
    });
    await platformDb.tenantLimits.update({ where: { tenantId }, data: { whatsappChannel: false } });

    const res = await request(app.getHttpServer())
      .patch(`/v1/admin/whatsapp/numbers/${number.id}`)
      .set('cookie', cookie)
      .send({ status: 'disabled' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('disabled');
  });
});

describe('GET whatsapp numbers reports channelEnabled from the same source as the gate', () => {
  it('false for an unprovisioned tenant, so the page shows the upgrade panel', async () => {
    const { cookie } = await signUpWithTenant('plan-limits-wa-list@demo.co', 'owner');
    // Deliberately no TenantLimits row: the unprovisioned case.
    const res = await request(app.getHttpServer())
      .get('/v1/admin/whatsapp/numbers')
      .set('cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body.channelEnabled).toBe(false);
  });
});
