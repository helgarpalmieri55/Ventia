import 'reflect-metadata';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import type { INestApplication } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import type Redis from 'ioredis';
import type { PrismaClient as PrismaClientType } from '@ventia/db';
import { startTestDb } from './helpers';
import type { signUpAndGetCookie as SignUpAndGetCookie, signUpWithTenant as SignUpWithTenant } from './admin-helpers';
import type { MailMessage, Mailer } from '../src/mailer/mailer';
import type { PlatformService as PlatformServiceType } from '../src/platform/platform.service';
import type { sweepSubscriptions as SweepSubscriptions } from '../src/platform/subscription-sweep.worker';

/**
 * Manual subscription tracking + auto-suspend (docs/SPEC.md §6 M9: "plan,
 * price, paid-until date, notes; auto-suspend N days past due (configurable,
 * default 7) with warning email at N-3"), phase P6.
 *
 * Three claims are under test, and the last two are the ones that would cost
 * real money to get wrong:
 *
 * 1. An operator — and ONLY an operator — can record what a merchant pays and
 *    until when, with every mutation audited.
 * 2. The sweep suspends a merchant who is genuinely past their grace window,
 *    it reaches the storefront immediately (SPEC's < 60 s AC), and it warns
 *    them three days earlier.
 * 3. The sweep does NOT act in every ambiguous case: a merchant close to their
 *    date but inside the window, a tenant with no subscription recorded at
 *    all, one with no paid-until, a draft store, an already-suspended one, and
 *    a warning that was already sent. Suspending a paying merchant by accident
 *    is the failure this feature must never produce, so most of this file is
 *    about what does not happen.
 */

let db: Awaited<ReturnType<typeof startTestDb>>;
let redisContainer: StartedTestContainer;
let app: INestApplication;
let platformDb: PrismaClientType;
let redisClient: Redis;
let platformService: PlatformServiceType;
let sweepSubscriptions: typeof SweepSubscriptions;
let signUpWithTenant: typeof SignUpWithTenant;
let signUpAndGetCookie: typeof SignUpAndGetCookie;

const OPERATOR_EMAIL = 'ops@ventia.co';
const ALLOWLIST = OPERATOR_EMAIL;

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-08-19T12:00:00.000Z');
/** `NOW` minus `days`, as a `paidUntil`. */
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY_MS);

/** Records every message instead of sending it — the same "pass a recording
 * double" shape `order-emails.test.ts` uses, and the reason the sweep takes
 * its `Mailer` as a dependency rather than reaching for one. */
class RecordingMailer implements Mailer {
  sent: MailMessage[] = [];
  /** Set to make the next N sends throw, for the retry test. */
  failuresLeft = 0;
  async send(msg: MailMessage): Promise<void> {
    if (this.failuresLeft > 0) {
      this.failuresLeft--;
      throw new Error('resend is down');
    }
    this.sent.push(msg);
  }
}

let mailer: RecordingMailer;

const cookieCache = new Map<string, string>();
/** Signs up an operator and grants BOTH controls the guard requires — the env
 * allowlist and `User.isPlatformAdmin`, neither of which any application code
 * path can set (see platform-admin.guard.ts). */
async function operatorCookie(email = OPERATOR_EMAIL): Promise<string> {
  let cookie = cookieCache.get(email);
  if (!cookie) {
    cookie = await signUpAndGetCookie(email);
    cookieCache.set(email, cookie);
  }
  await platformDb.user.update({
    where: { email },
    data: { emailVerified: true, isPlatformAdmin: true },
  });
  return cookie;
}

let tenantSeq = 0;
async function makeTenant(
  overrides: { status?: 'draft' | 'live' | 'suspended'; plan?: 'basico' | 'pro' | 'premium'; settings?: object } = {},
) {
  tenantSeq += 1;
  const slug = `sub-${tenantSeq}-${Math.random().toString(36).slice(2, 8)}`;
  return platformDb.tenant.create({
    data: {
      slug,
      name: `Tienda ${slug}`,
      status: overrides.status ?? 'live',
      plan: overrides.plan ?? 'pro',
      ...(overrides.settings ? { settings: overrides.settings } : {}),
    },
  });
}

/** A tenant with an owner whose account email the warning should reach. */
async function makeTenantWithOwner(overrides: Parameters<typeof makeTenant>[0] = {}) {
  const tenant = await makeTenant(overrides);
  const email = `owner-${tenant.slug}@merchant.co`;
  const user = await platformDb.user.create({ data: { name: 'Dueña', email } });
  await platformDb.membership.create({ data: { userId: user.id, tenantId: tenant.id, role: 'owner' } });
  return { tenant, ownerEmail: email };
}

async function recordSubscription(
  tenantId: string,
  paidUntil: Date | null,
  overrides: { priceCents?: number; plan?: 'basico' | 'pro' | 'premium' } = {},
) {
  return platformDb.subscription.create({
    data: {
      tenantId,
      plan: overrides.plan ?? 'pro',
      priceCents: overrides.priceCents ?? 99_900_00,
      paidUntil,
    },
  });
}

/**
 * Reads `Tenant.status` with raw SQL rather than through the service that just
 * claimed to change it. A suspension that only exists in a returned object is
 * not a suspension.
 */
async function statusInPostgres(tenantId: string): Promise<string> {
  const rows = await platformDb.$queryRawUnsafe<{ status: string }[]>(
    'SELECT "status"::text AS status FROM "Tenant" WHERE "id" = $1::uuid',
    tenantId,
  );
  return rows[0]!.status;
}

beforeAll(async () => {
  db = await startTestDb();
  redisContainer = await new GenericContainer('redis:7-alpine')
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
    .start();

  process.env.DATABASE_URL = db.url;
  process.env.REDIS_URL = `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`;
  process.env.PLATFORM_ADMIN_EMAILS = ALLOWLIST;
  delete process.env.SUBSCRIPTION_GRACE_DAYS;

  // Imported dynamically AFTER the env above is set: `@ventia/db` builds its
  // PrismaClient at module scope.
  const { Test } = await import('@nestjs/testing');
  const { PlatformModule } = await import('../src/platform/platform.module');
  const { StorefrontModule } = await import('../src/storefront/storefront.module');
  const { RedisModule, REDIS_CLIENT } = await import('../src/common/redis.module');
  const { DomainResolver } = await import('../src/tenants/domain-resolver');
  const { TenantMiddleware } = await import('../src/tenants/tenant.middleware');
  const { PlatformService } = await import('../src/platform/platform.service');
  ({ sweepSubscriptions } = await import('../src/platform/subscription-sweep.worker'));
  ({ platformDb } = await import('@ventia/db'));

  // Same composition as platform-admin.test.ts: the platform API under test,
  // plus the real storefront and tenant-resolution middleware, so the
  // "suspension reaches shoppers" assertion goes through the production path
  // rather than a stub.
  const moduleRef = await Test.createTestingModule({
    imports: [RedisModule, PlatformModule, StorefrontModule],
    providers: [
      {
        provide: DomainResolver,
        // Production's 60 s TTL, deliberately: the point of the storefront
        // assertion is that the eviction beats it.
        useFactory: (redis: Redis) => new DomainResolver(redis, platformDb),
        inject: [REDIS_CLIENT],
      },
      TenantMiddleware,
    ],
  }).compile();

  app = moduleRef.createNestApplication();
  redisClient = moduleRef.get<Redis>(REDIS_CLIENT);
  const tenantMiddleware = moduleRef.get(TenantMiddleware);
  app.use((req: Request, res: Response, next: NextFunction) => tenantMiddleware.use(req, res, next));
  await app.init();

  platformService = moduleRef.get(PlatformService);
  ({ signUpWithTenant, signUpAndGetCookie } = await import('./admin-helpers'));
}, 240_000);

afterEach(async () => {
  delete process.env.SUBSCRIPTION_GRACE_DAYS;
  // The sweep is platform-wide by design, so every test's counters would
  // otherwise include the leftovers of every test before it. Its ONLY
  // candidates are `Subscription` rows (that is the point of "never suspends a
  // tenant nobody recorded"), so clearing that table between tests is enough to
  // make each run see exactly the fixtures its own test created.
  await platformDb.subscription.deleteMany({});
});

afterAll(async () => {
  await app.close();
  try {
    await redisClient.quit();
  } catch {
    redisClient.disconnect();
  }
  await redisContainer.stop();
  await db.stop();
});

/** A fresh sweep run against the real database, with a recording mailer and
 * the REAL `PlatformService` — so the suspension path under test is the same
 * one the operator's suspend button uses, cache eviction included. */
function sweep(now: Date = NOW) {
  mailer = new RecordingMailer();
  return sweepSubscriptions({ mailer, platform: platformService }, now);
}

// ---------------------------------------------------------------------------
// The operator API
// ---------------------------------------------------------------------------

describe('PUT /v1/platform/tenants/:id/subscription', () => {
  it('is closed to merchants and to anonymous callers, like every other platform route', async () => {
    const tenant = await makeTenant();
    const owner = await signUpWithTenant('sub-guard-owner@demo.co', 'owner');

    const anon = await request(app.getHttpServer())
      .put(`/v1/platform/tenants/${tenant.id}/subscription`)
      .send({ plan: 'pro', priceCents: 1, paidUntil: '2027-01-01' });
    expect(anon.status).toBe(401);

    for (const path of [`tenants/${tenant.id}/subscription`, `tenants/${owner.tenantId}/subscription`]) {
      const merchantWrite = await request(app.getHttpServer())
        .put(`/v1/platform/${path}`)
        .set('cookie', owner.cookie)
        .send({ plan: 'premium', priceCents: 0, paidUntil: '2099-01-01' });
      expect(merchantWrite.status, path).toBe(403);

      const merchantRead = await request(app.getHttpServer())
        .get(`/v1/platform/${path}`)
        .set('cookie', owner.cookie);
      expect(merchantRead.status, path).toBe(403);
    }

    // Nothing was written by any of the above — the merchant cannot buy
    // themselves service by pointing this endpoint at their own tenant.
    expect(await platformDb.subscription.count({ where: { tenantId: owner.tenantId } })).toBe(0);
  });

  it('records plan, price, paid-until and notes, and echoes what the sweep will do about it', async () => {
    const cookie = await operatorCookie();
    const tenant = await makeTenant();

    const res = await request(app.getHttpServer())
      .put(`/v1/platform/tenants/${tenant.id}/subscription`)
      .set('cookie', cookie)
      .send({ plan: 'premium', priceCents: 299_900_00, paidUntil: '2026-08-31', notes: 'transferencia Bancolombia' });

    expect(res.status).toBe(200);
    expect(res.body.subscription).toMatchObject({
      plan: 'premium',
      priceCents: 299_900_00,
      notes: 'transferencia Bancolombia',
      graceDays: 7,
    });
    // A plain date is the END of that day in Colombia (UTC-05:00), not
    // midnight UTC — five hours of somebody's grace period.
    expect(res.body.subscription.paidUntil).toBe('2026-09-01T04:59:59.999Z');
    // ...and the suspension date the operator is shown is paidUntil + 7 days,
    // which is exactly what the sweep acts on.
    expect(res.body.subscription.suspendsOn).toBe('2026-09-08T04:59:59.999Z');
    expect(res.body.subscription.warnsOn).toBe('2026-09-05T04:59:59.999Z');

    const row = await platformDb.subscription.findUniqueOrThrow({ where: { tenantId: tenant.id } });
    expect(row.priceCents).toBe(299_900_00);
    expect(row.paidUntil?.toISOString()).toBe('2026-09-01T04:59:59.999Z');
  });

  it('updates the one row instead of accumulating rows, and audits both sides of the change', async () => {
    const cookie = await operatorCookie();
    const tenant = await makeTenant();

    await request(app.getHttpServer())
      .put(`/v1/platform/tenants/${tenant.id}/subscription`)
      .set('cookie', cookie)
      .send({ plan: 'pro', priceCents: 99_900_00, paidUntil: '2026-08-31', notes: 'agosto' })
      .expect(200);

    await request(app.getHttpServer())
      .put(`/v1/platform/tenants/${tenant.id}/subscription`)
      .set('cookie', cookie)
      .send({ plan: 'pro', priceCents: 99_900_00, paidUntil: '2026-09-30', notes: 'septiembre pagado' })
      .expect(200);

    expect(await platformDb.subscription.count({ where: { tenantId: tenant.id } })).toBe(1);

    const audits = await platformDb.auditLog.findMany({
      where: { tenantId: tenant.id, action: 'platform.tenant.subscription_recorded' },
      orderBy: { createdAt: 'asc' },
    });
    expect(audits).toHaveLength(2);
    expect(audits[0]!.data).toMatchObject({ actorEmail: OPERATOR_EMAIL, created: true, previous: null });
    // The audit trail IS the payment history, which is why `previous` matters:
    // the table itself only ever holds current state.
    expect(audits[1]!.data).toMatchObject({
      created: false,
      paidUntil: '2026-10-01T04:59:59.999Z',
      previous: { paidUntil: '2026-09-01T04:59:59.999Z', notes: 'agosto' },
    });
    expect(audits[1]!.actorUserId).not.toBeNull();
  });

  it('accepts a null paid-until — "on the books, nobody has paid yet" is a real state', async () => {
    const cookie = await operatorCookie();
    const tenant = await makeTenant();

    const res = await request(app.getHttpServer())
      .put(`/v1/platform/tenants/${tenant.id}/subscription`)
      .set('cookie', cookie)
      .send({ plan: 'basico', priceCents: 0, paidUntil: null, notes: 'piloto sin cobro' });

    expect(res.status).toBe(200);
    expect(res.body.subscription).toMatchObject({ paidUntil: null, dueState: 'sin_fecha', suspendsOn: null });
  });

  it('rejects the shapes that would take a store offline by accident', async () => {
    const cookie = await operatorCookie();
    const tenant = await makeTenant();

    const bad: Array<[string, Record<string, unknown>]> = [
      ['epoch-as-number', { plan: 'pro', priceCents: 1, paidUntil: 0 }],
      ['31 de febrero', { plan: 'pro', priceCents: 1, paidUntil: '2026-02-31' }],
      ['free text', { plan: 'pro', priceCents: 1, paidUntil: 'ayer' }],
      ['year typo', { plan: 'pro', priceCents: 1, paidUntil: '2016-01-01' }],
      ['negative price', { plan: 'pro', priceCents: -1, paidUntil: '2026-09-30' }],
      ['unknown plan', { plan: 'enterprise', priceCents: 1, paidUntil: '2026-09-30' }],
      ['missing plan', { priceCents: 1, paidUntil: '2026-09-30' }],
    ];
    for (const [label, body] of bad) {
      const res = await request(app.getHttpServer())
        .put(`/v1/platform/tenants/${tenant.id}/subscription`)
        .set('cookie', cookie)
        .send(body);
      expect(res.status, label).toBe(400);
      expect(res.body.error, label).toBe('VALIDATION_FAILED');
    }
    expect(await platformDb.subscription.count({ where: { tenantId: tenant.id } })).toBe(0);
  });

  it('404s an unknown tenant without writing a subscription or an audit row', async () => {
    const cookie = await operatorCookie();
    const id = '00000000-0000-4000-8000-000000000042';
    const res = await request(app.getHttpServer())
      .put(`/v1/platform/tenants/${id}/subscription`)
      .set('cookie', cookie)
      .send({ plan: 'pro', priceCents: 1, paidUntil: '2026-09-30' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('TENANT_NOT_FOUND');
    expect(await platformDb.auditLog.count({ where: { entityId: id } })).toBe(0);
  });

  it('recording a payment does not un-suspend the store on its own', async () => {
    // Deliberate: reactivation is a separate, separately-audited decision,
    // because a suspension may have been for abuse rather than for money. The
    // response says so rather than leaving the operator to notice.
    const cookie = await operatorCookie();
    const tenant = await makeTenant({ status: 'suspended' });

    const res = await request(app.getHttpServer())
      .put(`/v1/platform/tenants/${tenant.id}/subscription`)
      .set('cookie', cookie)
      .send({ plan: 'pro', priceCents: 99_900_00, paidUntil: '2027-01-31' });

    expect(res.status).toBe(200);
    expect(res.body.tenantStatus).toBe('suspended');
    expect(await statusInPostgres(tenant.id)).toBe('suspended');
  });

  it('GET returns the subscription, and 200-with-null when there is none', async () => {
    const cookie = await operatorCookie();
    const tenant = await makeTenant();

    const empty = await request(app.getHttpServer())
      .get(`/v1/platform/tenants/${tenant.id}/subscription`)
      .set('cookie', cookie);
    expect(empty.status).toBe(200);
    expect(empty.body.subscription).toBeNull();

    await recordSubscription(tenant.id, new Date('2026-09-30T04:59:59.999Z'));

    const filled = await request(app.getHttpServer())
      .get(`/v1/platform/tenants/${tenant.id}/subscription`)
      .set('cookie', cookie);
    expect(filled.body.subscription).toMatchObject({ plan: 'pro', priceCents: 99_900_00 });

    // ...and the tenant detail carries the same view, from the same mapper.
    const detail = await request(app.getHttpServer())
      .get(`/v1/platform/tenants/${tenant.id}`)
      .set('cookie', cookie);
    expect(detail.body.subscription).toEqual(filled.body.subscription);
  });
});

// ---------------------------------------------------------------------------
// The sweep — what it does
// ---------------------------------------------------------------------------

describe('subscription sweep: suspension', () => {
  it('suspends a tenant past the grace window, and the storefront goes down immediately', async () => {
    // SPEC §6 M9 AC: "suspending a tenant takes effect on the storefront in
    // < 60 s". The sweep reuses `PlatformService`'s suspend path precisely so
    // that the resolver-cache eviction is not something a second code path
    // could forget; this asserts it end-to-end, with no waiting.
    const { tenant } = await makeTenantWithOwner();
    const domain = `${tenant.slug}.ventia.localhost`;
    await platformDb.tenantDomain.create({ data: { tenantId: tenant.id, domain, isPrimary: true } });
    await recordSubscription(tenant.id, daysAgo(8));

    const storefront = () =>
      request(app.getHttpServer()).get('/v1/storefront/products').set('x-tenant-domain', domain);
    expect((await storefront()).status).toBe(200);

    const result = await sweep();
    expect(result.suspended).toBe(1);

    // Asserted against Postgres, not against the returned object.
    expect(await statusInPostgres(tenant.id)).toBe('suspended');
    const after = await storefront();
    expect(after.status).toBe(503);
    expect(after.body.error).toBe('TENANT_SUSPENDED');
  });

  it('audits the suspension as a system action, with the numbers that justify it', async () => {
    const { tenant } = await makeTenantWithOwner();
    await recordSubscription(tenant.id, daysAgo(30));

    await sweep();

    const audit = await platformDb.auditLog.findFirstOrThrow({
      where: { tenantId: tenant.id, action: 'platform.tenant.suspended' },
    });
    // No human took this action, and the row says so honestly rather than
    // naming an invented user.
    expect(audit.actorUserId).toBeNull();
    expect(audit.data).toMatchObject({
      actorEmail: 'sistema@ventia',
      automated: true,
      graceDays: 7,
      status: 'suspended',
      previousStatus: 'live',
      cacheInvalidated: true,
    });
    expect(String((audit.data as { reason: string }).reason)).toContain('falta de pago');
  });

  it('honours SUBSCRIPTION_GRACE_DAYS', async () => {
    const { tenant } = await makeTenantWithOwner();
    await recordSubscription(tenant.id, daysAgo(4));

    // Untouched at the default 7-day window...
    expect((await sweep()).suspended).toBe(0);
    expect(await statusInPostgres(tenant.id)).toBe('live');

    // ...and suspended once the deployment's window is 3 days.
    process.env.SUBSCRIPTION_GRACE_DAYS = '3';
    expect((await sweep()).suspended).toBe(1);
    expect(await statusInPostgres(tenant.id)).toBe('suspended');
  });

  it('falls back to 7 days for a malformed grace setting rather than suspending everybody', async () => {
    const { tenant } = await makeTenantWithOwner();
    await recordSubscription(tenant.id, daysAgo(4));

    for (const value of ['0', '-3', 'siete', '']) {
      process.env.SUBSCRIPTION_GRACE_DAYS = value;
      const result = await sweep();
      expect(result.graceDays, value).toBe(7);
      expect(result.suspended, value).toBe(0);
      expect(await statusInPostgres(tenant.id)).toBe('live');
    }
  });
});

// ---------------------------------------------------------------------------
// The sweep — what it refuses to do. Most of the value is here.
// ---------------------------------------------------------------------------

describe('subscription sweep: what it will not do', () => {
  it('does NOT suspend a tenant who is merely close to their date', async () => {
    // The single most damaging bug this feature could have: an off-by-one, a
    // `<=` where a `<` belongs, or a cutoff computed in the wrong direction
    // takes a paying merchant's store offline. Four positions inside the
    // window, including the exact boundary.
    const cases: Array<[string, number]> = [
      ['still paid (2 days early)', -2],
      ['due today', 0],
      ['1 day past due', 1],
      ['6 days past due — one short of the window', 6],
      ['exactly 7 days minus a minute', 6.999],
    ];

    for (const [label, days] of cases) {
      const { tenant } = await makeTenantWithOwner();
      await recordSubscription(tenant.id, daysAgo(days));

      const result = await sweep();
      expect(result.suspended, label).toBe(0);
      expect(await statusInPostgres(tenant.id), label).toBe('live');
    }
  });

  it('does NOT suspend a tenant with no subscription recorded at all', async () => {
    // On the day this shipped, that described EVERY tenant on the platform. A
    // sweep that read "no record" as "has not paid" would have taken the whole
    // platform offline on its first run.
    const { tenant } = await makeTenantWithOwner();
    expect(await platformDb.subscription.count({ where: { tenantId: tenant.id } })).toBe(0);

    const result = await sweep();
    expect(result.suspended).toBe(0);
    expect(await statusInPostgres(tenant.id)).toBe('live');
  });

  it('does NOT suspend a subscription with no paid-until date', async () => {
    const { tenant } = await makeTenantWithOwner();
    await recordSubscription(tenant.id, null);

    await sweep();
    expect(await statusInPostgres(tenant.id)).toBe('live');
  });

  it('does NOT re-suspend (or re-audit) a tenant that is already suspended', async () => {
    // The idempotency that keeps an hourly job from writing an audit row per
    // hour forever, and from clobbering a manual reactivation.
    const { tenant } = await makeTenantWithOwner();
    await recordSubscription(tenant.id, daysAgo(20));

    expect((await sweep()).suspended).toBe(1);
    expect((await sweep()).suspended).toBe(0);
    expect((await sweep(new Date(NOW.getTime() + DAY_MS))).suspended).toBe(0);

    const audits = await platformDb.auditLog.count({
      where: { tenantId: tenant.id, action: 'platform.tenant.suspended' },
    });
    expect(audits).toBe(1);
  });

  it('does NOT touch a draft tenant', async () => {
    // Suspending one would be worse than useless: it serves nobody, and the
    // eventual "reactivate" would LAUNCH a store whose owner never finished
    // onboarding.
    const { tenant } = await makeTenantWithOwner({ status: 'draft' });
    await recordSubscription(tenant.id, daysAgo(60));

    await sweep();
    expect(await statusInPostgres(tenant.id)).toBe('draft');
  });

  it('keeps sweeping when one tenant fails', async () => {
    // A tenant deleted between the candidate query and the suspension (the
    // realistic version of "one row is broken") must not stop everyone else's
    // sweep. Simulated by pointing the suspend call at a tenant that vanishes.
    const { tenant: doomed } = await makeTenantWithOwner();
    await recordSubscription(doomed.id, daysAgo(9));
    const { tenant: healthy } = await makeTenantWithOwner();
    await recordSubscription(healthy.id, daysAgo(9));

    const failing = {
      suspendForNonPayment: async (tenantId: string, details: { paidUntil: Date; graceDays: number }) => {
        if (tenantId === doomed.id) throw new Error('boom');
        return platformService.suspendForNonPayment(tenantId, details);
      },
    };
    const recording = new RecordingMailer();
    const result = await sweepSubscriptions({ mailer: recording, platform: failing }, NOW);

    expect(result.failures).toBe(1);
    expect(result.suspended).toBe(1);
    expect(await statusInPostgres(healthy.id)).toBe('suspended');
    expect(await statusInPostgres(doomed.id)).toBe('live');
  });
});

// ---------------------------------------------------------------------------
// The warning email (N-3)
// ---------------------------------------------------------------------------

describe('subscription sweep: the N-3 warning', () => {
  it('warns the owner three days before suspension, once', async () => {
    const { tenant, ownerEmail } = await makeTenantWithOwner();
    await recordSubscription(tenant.id, daysAgo(5), { priceCents: 149_900_00 });

    const first = await sweep();
    expect(first.warned).toBe(1);
    expect(first.suspended).toBe(0);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]!.to).toBe(ownerEmail);
    expect(mailer.sent[0]!.subject).toContain('suscripción');
    // Names the consequence and the date it happens, in COP and es-CO.
    expect(mailer.sent[0]!.text).toContain('$ 149.900');
    expect(mailer.sent[0]!.text).toContain('se suspenderá automáticamente');
    expect(await statusInPostgres(tenant.id)).toBe('live');
  });

  it('does NOT send the same warning again on the next run', async () => {
    // An hourly job that re-warned every run would send a merchant 72 identical
    // emails over the notice period. The claim is a `NotificationLog` row with
    // a unique idempotency key, not a flag anybody has to remember to set.
    const { tenant } = await makeTenantWithOwner();
    await recordSubscription(tenant.id, daysAgo(5));

    expect((await sweep()).warned).toBe(1);

    const second = await sweep();
    expect(second.warned).toBe(0);
    expect(second.warningsAlreadySent).toBe(1);
    expect(mailer.sent).toHaveLength(0);

    const third = await sweep(new Date(NOW.getTime() + 6 * 60 * 60 * 1000));
    expect(third.warned).toBe(0);
    expect(mailer.sent).toHaveLength(0);

    expect(
      await platformDb.notificationLog.count({
        where: { tenantId: tenant.id, template: 'subscription_due_warning' },
      }),
    ).toBe(1);
  });

  it('warns again for the NEXT cycle once the paid-until date moves', async () => {
    // The idempotency key is bound to `paidUntil`, so it is per billing cycle,
    // not per tenant — a merchant who pays, and lapses again months later, is
    // warned again.
    const { tenant } = await makeTenantWithOwner();
    const sub = await recordSubscription(tenant.id, daysAgo(5));
    expect((await sweep()).warned).toBe(1);

    // Operator records a payment: the new period also lapses, later.
    const later = new Date(NOW.getTime() + 30 * DAY_MS);
    await platformDb.subscription.update({
      where: { id: sub.id },
      data: { paidUntil: later },
    });

    const nextCycle = await sweep(new Date(later.getTime() + 5 * DAY_MS));
    expect(nextCycle.warned).toBe(1);
    expect(mailer.sent).toHaveLength(1);
  });

  it('re-sends after a failed send, because a warning nobody received is worse than a duplicate', async () => {
    const { tenant } = await makeTenantWithOwner();
    await recordSubscription(tenant.id, daysAgo(5));

    const failing = new RecordingMailer();
    failing.failuresLeft = 1;
    const first = await sweepSubscriptions({ mailer: failing, platform: platformService }, NOW);
    expect(first.warned).toBe(0);
    expect(first.failures).toBe(1);
    expect(failing.sent).toHaveLength(0);
    const claimed = await platformDb.notificationLog.findFirstOrThrow({
      where: { tenantId: tenant.id, template: 'subscription_due_warning' },
    });
    expect(claimed.status).toBe('failed');

    const second = await sweep();
    expect(second.warned).toBe(1);
    expect(mailer.sent).toHaveLength(1);
    const after = await platformDb.notificationLog.findFirstOrThrow({
      where: { tenantId: tenant.id, template: 'subscription_due_warning' },
    });
    expect(after.status).toBe('sent');
    expect(after.attempts).toBe(2);
  });

  it('does NOT warn a tenant who is still inside the paid period', async () => {
    const { tenant } = await makeTenantWithOwner();
    await recordSubscription(tenant.id, daysAgo(3));

    const result = await sweep();
    expect(result.warned).toBe(0);
    expect(mailer.sent).toHaveLength(0);
  });

  it('falls back to the store contact email, and says so loudly when there is nobody at all', async () => {
    const withContact = await makeTenant({ settings: { storeInfo: { contactEmail: 'contacto@tienda.co' } } });
    await recordSubscription(withContact.id, daysAgo(5));
    const orphan = await makeTenant();
    await recordSubscription(orphan.id, daysAgo(5));

    const result = await sweep();
    expect(result.warned).toBe(1);
    expect(mailer.sent.map((m) => m.to)).toEqual(['contacto@tienda.co']);
    expect(result.warningsUndeliverable).toBe(1);
    // Undeliverable is not a failure that stops the sweep — and it certainly
    // does not stop the eventual suspension, which is not conditional on
    // anybody having been reachable.
    expect(result.failures).toBe(0);
  });

  it('audits the warning too, so one query answers "what did the platform do to this merchant"', async () => {
    const { tenant, ownerEmail } = await makeTenantWithOwner();
    await recordSubscription(tenant.id, daysAgo(5));
    await sweep();

    const audit = await platformDb.auditLog.findFirstOrThrow({
      where: { tenantId: tenant.id, action: 'platform.tenant.subscription_warned' },
    });
    expect(audit.actorUserId).toBeNull();
    expect(audit.data).toMatchObject({ actorEmail: 'sistema@ventia', recipient: ownerEmail });
  });

  it('a warned merchant who does not pay is suspended when the window closes', async () => {
    // The whole lifecycle in one test: warned at N-3, still live, suspended at
    // N — and warned exactly once across all of it.
    const { tenant } = await makeTenantWithOwner();
    await recordSubscription(tenant.id, daysAgo(5));

    const atWarning = await sweep();
    expect(atWarning.warned).toBe(1);
    expect(await statusInPostgres(tenant.id)).toBe('live');

    const midWindow = await sweep(new Date(NOW.getTime() + DAY_MS));
    expect(midWindow.warned).toBe(0);
    expect(await statusInPostgres(tenant.id)).toBe('live');

    const atSuspension = await sweep(new Date(NOW.getTime() + 2 * DAY_MS + 60_000));
    expect(atSuspension.suspended).toBe(1);
    expect(await statusInPostgres(tenant.id)).toBe('suspended');

    expect(
      await platformDb.notificationLog.count({
        where: { tenantId: tenant.id, template: 'subscription_due_warning' },
      }),
    ).toBe(1);
  });
});
