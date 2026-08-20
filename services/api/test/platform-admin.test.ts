import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import type { INestApplication } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import type Redis from 'ioredis';
import type { PrismaClient as PrismaClientType } from '@ventia/db';
import { startTestDb } from './helpers';
import type { signUpAndGetCookie as SignUpAndGetCookie, signUpWithTenant as SignUpWithTenant } from './admin-helpers';

/**
 * The platform-operator API (docs/SPEC.md §6 M9): Ventia's own back office.
 *
 * Two things are being proven here, and the second matters more than the
 * feature set:
 *
 * 1. The routes do what M9 asks — list/search/page tenants with plan, status,
 *    GMV and month-to-date AI usage; tenant detail; assign a plan (writing
 *    `TenantLimits` with it); suspend and reactivate.
 * 2. NOTHING a merchant possesses reaches any of them, and an unconfigured
 *    allowlist locks everyone out rather than letting everyone in.
 *
 * Plus the acceptance criterion with a number on it: "suspending a tenant
 * takes effect on the storefront in < 60 s" — asserted as *immediately*, by
 * driving the real storefront route through the real tenant-resolution
 * middleware right after the suspend call.
 */

let db: Awaited<ReturnType<typeof startTestDb>>;
let redisContainer: StartedTestContainer;
let app: INestApplication;
let platformDb: PrismaClientType;
let signUpWithTenant: typeof SignUpWithTenant;
let signUpAndGetCookie: typeof SignUpAndGetCookie;
let redisClient: Redis;

const OPERATOR_EMAIL = 'ops@ventia.co';
/** Deliberately mixed-case and padded: the guard normalizes both sides, and a
 * real allowlist is hand-edited config that will have stray spaces in it. */
const ALLOWLIST = ` OPS@Ventia.co , second-operator@ventia.co `;

/** Signs up a user, grants them both operator controls, and returns a session
 * cookie.
 *
 * Memoized per address: several tests share one operator, and
 * `signUpAndGetCookie` signs UP (which fails on a duplicate address). The
 * session outlives the file, so handing back the first cookie is both correct
 * and faster than re-authenticating.
 *
 * BOTH are set directly in the DB, and neither is decoration:
 * `emailVerified` because there is no test mailbox to click a link in, and
 * `isPlatformAdmin` because NO APPLICATION CODE PATH SETS IT — that is the
 * column's entire purpose (see platform-admin.guard.ts). A test that could
 * grant it through an endpoint would be evidence of a bug, not convenience.
 * Each is independently required, and each has its own test below proving
 * that withholding it denies. */
const cookieCache = new Map<string, string>();
async function operatorCookie(
  email: string,
  opts: { verified?: boolean; flagged?: boolean } = {},
): Promise<string> {
  let cookie = cookieCache.get(email);
  if (!cookie) {
    cookie = await signUpAndGetCookie(email);
    cookieCache.set(email, cookie);
  }
  await platformDb.user.update({
    where: { email },
    data: {
      emailVerified: opts.verified !== false,
      isPlatformAdmin: opts.flagged !== false,
    },
  });
  return cookie;
}

function thisMonth(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

let tenantSeq = 0;
async function makeTenant(
  overrides: { name?: string; status?: 'draft' | 'live' | 'suspended'; plan?: 'basico' | 'pro' | 'premium' } = {},
) {
  tenantSeq += 1;
  const slug = `pt-${tenantSeq}-${Math.random().toString(36).slice(2, 8)}`;
  return platformDb.tenant.create({
    data: {
      slug,
      name: overrides.name ?? `Tienda ${slug}`,
      status: overrides.status ?? 'live',
      plan: overrides.plan ?? 'basico',
    },
  });
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

  // Everything below is imported dynamically, AFTER the env above is set:
  // `@ventia/db` constructs its PrismaClient at module scope and would
  // otherwise bind to whatever DATABASE_URL was (not) set at file load.
  const { Test } = await import('@nestjs/testing');
  const { PlatformModule } = await import('../src/platform/platform.module');
  const { StorefrontModule } = await import('../src/storefront/storefront.module');
  const { RedisModule, REDIS_CLIENT } = await import('../src/common/redis.module');
  const { DomainResolver } = await import('../src/tenants/domain-resolver');
  const { TenantMiddleware } = await import('../src/tenants/tenant.middleware');
  ({ platformDb } = await import('@ventia/db'));

  // A purpose-built app rather than `createApp()` from src/main.ts, because
  // `PlatformModule` is intentionally not registered in `AppModule` yet — the
  // integrating agent wires it (see the task report). It composes exactly the
  // two surfaces this file exercises: the platform API under test, and the
  // real storefront + tenant-resolution middleware the suspension test needs
  // to prove the cache eviction actually reaches a shopper.
  const moduleRef = await Test.createTestingModule({
    imports: [RedisModule, PlatformModule, StorefrontModule],
    providers: [
      {
        provide: DomainResolver,
        // Same 60s default TTL as production — the point of the suspension
        // test is that the eviction beats that TTL, so shortening it here
        // would test nothing.
        useFactory: (redis: Redis) => new DomainResolver(redis, platformDb),
        inject: [REDIS_CLIENT],
      },
      TenantMiddleware,
    ],
  }).compile();

  app = moduleRef.createNestApplication();
  // `AppModule.configure()` applies this via MiddlewareConsumer; a testing
  // module has no `configure` hook, so it is mounted straight onto the
  // underlying Express instance, which puts it in the same place in the chain
  // (before routing).
  redisClient = moduleRef.get<Redis>(REDIS_CLIENT);
  const tenantMiddleware = moduleRef.get(TenantMiddleware);
  app.use((req: Request, res: Response, next: NextFunction) => tenantMiddleware.use(req, res, next));
  await app.init();

  ({ signUpWithTenant, signUpAndGetCookie } = await import('./admin-helpers'));
}, 240_000);

afterAll(async () => {
  process.env.PLATFORM_ADMIN_EMAILS = ALLOWLIST;
  await app.close();
  // `AppModule.onApplicationShutdown` quits the shared client in the real app;
  // a testing module has no such hook, and leaving the socket open makes
  // ioredis log reconnect failures after the container is gone.
  try {
    await redisClient.quit();
  } catch {
    redisClient.disconnect();
  }
  await redisContainer.stop();
  await db.stop();
});

// ---------------------------------------------------------------------------
// Authentication — the part that must not have a hole in it.
// ---------------------------------------------------------------------------

describe('PlatformAdminGuard', () => {
  /** Every route, so a new one cannot be added behind a weaker check by
   * accident. `[method, path, body]`. */
  const ROUTES: Array<[string, string, Record<string, unknown> | undefined]> = [
    ['get', '/v1/platform/tenants', undefined],
    ['get', '/v1/platform/tenants/00000000-0000-4000-8000-000000000000', undefined],
    ['patch', '/v1/platform/tenants/00000000-0000-4000-8000-000000000000/plan', { plan: 'pro' }],
    ['post', '/v1/platform/tenants/00000000-0000-4000-8000-000000000000/suspend', { reason: 'x' }],
    ['post', '/v1/platform/tenants/00000000-0000-4000-8000-000000000000/reactivate', {}],
  ];

  function call(method: string, path: string, body: Record<string, unknown> | undefined, cookie?: string) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let req = (request(app.getHttpServer()) as any)[method](path);
    if (cookie) req = req.set('cookie', cookie);
    return body === undefined ? req : req.send(body);
  }

  it('rejects an anonymous caller on every route', async () => {
    for (const [method, path, body] of ROUTES) {
      const res = await call(method, path, body);
      expect(res.status, `${method} ${path}`).toBe(401);
      expect(res.body.error).toBe('UNAUTHENTICATED');
    }
  });

  /**
   * THE test. A merchant owner — the most privileged thing the product itself
   * can grant anybody — must not reach a single platform route. If the guard
   * is ever weakened (made to accept any session, to fall back to the merchant
   * session guard, or to fail open on an unset allowlist), this is what turns
   * red.
   */
  it('rejects an ordinary merchant session on every route, owner and staff alike', async () => {
    const owner = await signUpWithTenant('platform-guard-owner@demo.co', 'owner');
    const staff = await signUpWithTenant('platform-guard-staff@demo.co', 'staff');

    for (const cookie of [owner.cookie, staff.cookie]) {
      for (const [method, path, body] of ROUTES) {
        const res = await call(method, path, body, cookie);
        expect(res.status, `${method} ${path}`).toBe(403);
        expect(res.body.error).toBe('NOT_PLATFORM_ADMIN');
      }
    }
  });

  it('rejects a merchant even when their own tenant is the one named in the path', async () => {
    // The "surely I can administer myself" escalation: a merchant calling the
    // platform API against their OWN tenant id. The platform surface is not a
    // superset of the merchant surface; it is a different authority.
    const owner = await signUpWithTenant('platform-guard-self@demo.co', 'owner');
    const res = await request(app.getHttpServer())
      .patch(`/v1/platform/tenants/${owner.tenantId}/plan`)
      .set('cookie', owner.cookie)
      .send({ plan: 'premium' });

    expect(res.status).toBe(403);
    const after = await platformDb.tenant.findUnique({ where: { id: owner.tenantId } });
    expect(after?.plan).toBe('basico');
  });

  it('FAILS CLOSED: an unset allowlist denies even a verified operator', async () => {
    const cookie = await operatorCookie(OPERATOR_EMAIL);
    // Sanity: this exact session works while the allowlist is configured.
    expect((await call('get', '/v1/platform/tenants', undefined, cookie)).status).toBe(200);

    try {
      for (const value of [undefined, '', '   ', ' , , ']) {
        if (value === undefined) delete process.env.PLATFORM_ADMIN_EMAILS;
        else process.env.PLATFORM_ADMIN_EMAILS = value;

        const res = await call('get', '/v1/platform/tenants', undefined, cookie);
        expect(res.status, `allowlist=${JSON.stringify(value)}`).toBe(403);
        expect(res.body.error).toBe('NOT_PLATFORM_ADMIN');
      }
    } finally {
      // `finally`, not a trailing statement: if this test fails it must not
      // ALSO leave the process without an allowlist, which would cascade into
      // every later test and bury the real failure under noise.
      process.env.PLATFORM_ADMIN_EMAILS = ALLOWLIST;
    }
  });

  it('rejects an allowlisted address whose email is not verified', async () => {
    // The concrete attack this closes: `requireEmailVerification` is false in
    // auth.ts, so anyone may sign up as an unregistered address and hold a
    // valid session for it immediately. Operator addresses at a company's own
    // domain are guessable, so without the emailVerified check, squatting one
    // would be a complete platform takeover.
    const cookie = await operatorCookie('second-operator@ventia.co', { verified: false });
    const res = await call('get', '/v1/platform/tenants', undefined, cookie);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('NOT_PLATFORM_ADMIN');

    // ...and it starts working the moment the address is actually verified,
    // proving the rejection was the verification and not the allowlist.
    await platformDb.user.update({ where: { email: 'second-operator@ventia.co' }, data: { emailVerified: true } });
    expect((await call('get', '/v1/platform/tenants', undefined, cookie)).status).toBe(200);
  });

  it('rejects an allowlisted, verified operator whose User.isPlatformAdmin is false', async () => {
    // The second of the two independent controls. This is the state a
    // deployment is in immediately after the column migration lands and
    // before anyone runs the UPDATE: allowlisted, verified, and still denied.
    // Denying is the correct direction for a privilege migration to fail.
    const cookie = await operatorCookie('second-operator@ventia.co', { flagged: false });
    const res = await call('get', '/v1/platform/tenants', undefined, cookie);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('NOT_PLATFORM_ADMIN');

    // ...and it starts working the moment the flag is set, proving the
    // rejection was the column and not the allowlist or the verification.
    await platformDb.user.update({
      where: { email: 'second-operator@ventia.co' },
      data: { isPlatformAdmin: true },
    });
    expect((await call('get', '/v1/platform/tenants', undefined, cookie)).status).toBe(200);
  });

  it('BOTH controls are required: neither the flag nor the allowlist suffices alone', async () => {
    // The pair that makes "in addition to, never instead of" a tested
    // property rather than a comment. Two directions, one test:
    //
    //   flag WITHOUT allowlist  — the case that would matter if someone ever
    //     wrote to this column from application code. Flagging a user must
    //     not admit them unless the deployment also named their address.
    //   allowlist WITHOUT flag  — covered above, re-asserted here so the pair
    //     reads as one claim.
    const outsider = 'flagged-but-not-listed@ventia.co';
    const cookie = await operatorCookie(outsider);
    // `operatorCookie` already set isPlatformAdmin — this address is simply
    // not in ALLOWLIST.
    expect(
      (await platformDb.user.findUnique({ where: { email: outsider }, select: { isPlatformAdmin: true } }))
        ?.isPlatformAdmin,
    ).toBe(true);

    const res = await call('get', '/v1/platform/tenants', undefined, cookie);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('NOT_PLATFORM_ADMIN');
  });

  it('the flag is not reachable through sign-up — no new user gets it', async () => {
    // The column's whole value is that no application path writes it. If
    // better-auth ever gains a `user.additionalFields` entry for it, or an
    // endpoint starts accepting it, this goes red.
    const email = 'freshly-signed-up@ventia.co';
    await signUpAndGetCookie(email);
    const user = await platformDb.user.findUnique({ where: { email }, select: { isPlatformAdmin: true } });
    expect(user?.isPlatformAdmin).toBe(false);
  });

  it('rejects a verified user who is simply not on the list', async () => {
    const cookie = await operatorCookie('not-an-operator@ventia.co');
    const res = await call('get', '/v1/platform/tenants', undefined, cookie);
    expect(res.status).toBe(403);
  });

  it('does not let a platform_admin Membership row grant access on its own', async () => {
    // `MembershipRole.platform_admin` exists in the schema and is the obvious
    // wrong answer to "how do we authenticate an operator". This pins the
    // decision: the row grants nothing, so an app-level bug that lets a
    // merchant create one (the staff-invite path already writes Memberships)
    // is not a platform compromise.
    const cookie = await operatorCookie('db-role-only@merchant.co');
    await platformDb.membership.create({
      data: {
        userId: (await platformDb.user.findUniqueOrThrow({ where: { email: 'db-role-only@merchant.co' } })).id,
        tenantId: null,
        role: 'platform_admin',
      },
    });

    const res = await call('get', '/v1/platform/tenants', undefined, cookie);
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

describe('GET /v1/platform/tenants', () => {
  it('lists tenants with plan, status, GMV and month-to-date AI usage', async () => {
    const cookie = await operatorCookie(OPERATOR_EMAIL);
    const tenant = await makeTenant({ name: 'Café del Valle', plan: 'pro' });
    await platformDb.tenantLimits.create({
      data: { tenantId: tenant.id, productsMax: 1000, aiMessagesMonth: 3000, staffSeats: 3 },
    });

    // Three orders: two that count, one CANCELLED that must not.
    await platformDb.order.createMany({
      data: [
        orderRow(tenant.id, 1, 500_000, 'CONFIRMED'),
        orderRow(tenant.id, 2, 250_000, 'PENDING'),
        orderRow(tenant.id, 3, 999_999, 'CANCELLED'),
      ],
    });
    await platformDb.agentUsage.create({
      data: {
        tenantId: tenant.id,
        month: thisMonth(),
        messagesCount: 300,
        inputTokens: 12_000,
        outputTokens: 4_000,
        costCents: 87,
      },
    });

    const res = await request(app.getHttpServer())
      .get('/v1/platform/tenants')
      .query({ q: 'café del' })
      .set('cookie', cookie);

    expect(res.status).toBe(200);
    const row = res.body.tenants.find((t: { id: string }) => t.id === tenant.id);
    expect(row).toBeDefined();
    expect(row.plan).toBe('pro');
    expect(row.status).toBe('live');
    // 500_000 + 250_000 — the cancelled 999_999 is excluded.
    expect(row.gmv).toEqual({ totalCents: 750_000, orders: 2 });
    expect(row.ai).toMatchObject({
      messages: 300,
      messagesLimit: 3000,
      inputTokens: 12_000,
      outputTokens: 4_000,
      costCents: 87,
      percentUsed: 10,
    });
    expect(res.body.month).toBe(thisMonth());
  });

  it('searches case-insensitively on name and slug, and filters by status and plan', async () => {
    const cookie = await operatorCookie(OPERATOR_EMAIL);
    const hit = await makeTenant({ name: 'Zapatos Insensitive', plan: 'premium', status: 'suspended' });
    await makeTenant({ name: 'Zapatos Insensitive Otro', plan: 'basico', status: 'live' });

    const byName = await request(app.getHttpServer())
      .get('/v1/platform/tenants')
      .query({ q: 'zapatos INSENSITIVE' })
      .set('cookie', cookie);
    expect(byName.status).toBe(200);
    expect(byName.body.total).toBeGreaterThanOrEqual(2);

    const bySlug = await request(app.getHttpServer())
      .get('/v1/platform/tenants')
      .query({ q: hit.slug })
      .set('cookie', cookie);
    expect(bySlug.body.tenants.map((t: { id: string }) => t.id)).toEqual([hit.id]);

    const filtered = await request(app.getHttpServer())
      .get('/v1/platform/tenants')
      .query({ q: 'zapatos insensitive', status: 'suspended', plan: 'premium' })
      .set('cookie', cookie);
    expect(filtered.body.tenants.map((t: { id: string }) => t.id)).toEqual([hit.id]);
  });

  it('pages, and rejects a page size big enough to scan the platform', async () => {
    const cookie = await operatorCookie(OPERATOR_EMAIL);
    const first = await request(app.getHttpServer())
      .get('/v1/platform/tenants')
      .query({ page: 1, perPage: 2 })
      .set('cookie', cookie);
    expect(first.status).toBe(200);
    expect(first.body.tenants).toHaveLength(2);
    expect(first.body.perPage).toBe(2);
    expect(first.body.totalPages).toBe(Math.ceil(first.body.total / 2));

    const second = await request(app.getHttpServer())
      .get('/v1/platform/tenants')
      .query({ page: 2, perPage: 2 })
      .set('cookie', cookie);
    const overlap = second.body.tenants
      .map((t: { id: string }) => t.id)
      .filter((id: string) => first.body.tenants.some((t: { id: string }) => t.id === id));
    expect(overlap).toEqual([]);

    const tooBig = await request(app.getHttpServer())
      .get('/v1/platform/tenants')
      .query({ perPage: 5000 })
      .set('cookie', cookie);
    expect(tooBig.status).toBe(400);
    expect(tooBig.body.error).toBe('VALIDATION_FAILED');
  });
});

describe('GET /v1/platform/tenants/:id', () => {
  it('returns the detail an operator opens the page for', async () => {
    const cookie = await operatorCookie(OPERATOR_EMAIL);
    const tenant = await makeTenant({ name: 'Detalle SAS', plan: 'premium' });
    await platformDb.tenantLimits.create({
      data: {
        tenantId: tenant.id,
        productsMax: 10_000,
        aiMessagesMonth: 10_000,
        staffSeats: 10,
        customDomain: true,
        humanHandoff: true,
        whatsappChannel: true,
      },
    });
    await platformDb.tenantDomain.create({
      data: { tenantId: tenant.id, domain: `${tenant.slug}.ventia.localhost`, isPrimary: true },
    });
    await platformDb.subscription.create({
      data: { tenantId: tenant.id, plan: 'premium', priceCents: 29_900_00, notes: 'pago manual' },
    });
    await platformDb.order.create({ data: orderRow(tenant.id, 1, 120_000, 'DELIVERED') });

    const res = await request(app.getHttpServer())
      .get(`/v1/platform/tenants/${tenant.id}`)
      .set('cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: tenant.id,
      name: 'Detalle SAS',
      plan: 'premium',
      status: 'live',
      limitsMatchPlan: true,
      gmv: { totalCents: 120_000, orders: 1 },
    });
    expect(res.body.domains).toEqual([
      { domain: `${tenant.slug}.ventia.localhost`, isPrimary: true, verifiedAt: null },
    ]);
    expect(res.body.subscription).toMatchObject({ plan: 'premium', priceCents: 29_900_00 });
    expect(res.body.ai).toMatchObject({ messages: 0, messagesLimit: 10_000, percentUsed: 0 });
  });

  it('flags a tenant whose TenantLimits have drifted from its plan', async () => {
    // The reason detail reports limits off the ROW rather than deriving them
    // from the plan: this state is invisible otherwise, and it is exactly what
    // an operator is trying to diagnose.
    const cookie = await operatorCookie(OPERATOR_EMAIL);
    const drifted = await makeTenant({ plan: 'premium' });
    await platformDb.tenantLimits.create({
      data: { tenantId: drifted.id, productsMax: 100, aiMessagesMonth: 500, staffSeats: 1 },
    });

    const res = await request(app.getHttpServer())
      .get(`/v1/platform/tenants/${drifted.id}`)
      .set('cookie', cookie);
    expect(res.body.limitsMatchPlan).toBe(false);
    expect(res.body.limits.aiMessagesMonth).toBe(500);

    const unprovisioned = await makeTenant({ plan: 'pro' });
    const res2 = await request(app.getHttpServer())
      .get(`/v1/platform/tenants/${unprovisioned.id}`)
      .set('cookie', cookie);
    expect(res2.body.limits).toBeNull();
    expect(res2.body.limitsMatchPlan).toBe(false);
    // No limits row means a zero AI budget, which is what the agent enforces.
    expect(res2.body.ai).toMatchObject({ messagesLimit: 0, percentUsed: null });
  });

  it('404s an unknown tenant and 400s a malformed id', async () => {
    const cookie = await operatorCookie(OPERATOR_EMAIL);
    const missing = await request(app.getHttpServer())
      .get('/v1/platform/tenants/00000000-0000-4000-8000-000000000000')
      .set('cookie', cookie);
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe('TENANT_NOT_FOUND');

    const malformed = await request(app.getHttpServer())
      .get('/v1/platform/tenants/not-a-uuid')
      .set('cookie', cookie);
    expect(malformed.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Plan assignment
// ---------------------------------------------------------------------------

describe('PATCH /v1/platform/tenants/:id/plan', () => {
  it('writes the plan AND the matching TenantLimits, for every tier', async () => {
    const cookie = await operatorCookie(OPERATOR_EMAIL);
    const { PLANS } = await import('@ventia/core');

    for (const plan of ['basico', 'pro', 'premium'] as const) {
      const tenant = await makeTenant({ plan: 'basico' });
      const res = await request(app.getHttpServer())
        .patch(`/v1/platform/tenants/${tenant.id}/plan`)
        .set('cookie', cookie)
        .send({ plan, note: `upgrade a ${plan}` });

      expect(res.status, plan).toBe(200);
      expect(res.body.plan).toBe(plan);

      const after = await platformDb.tenant.findUniqueOrThrow({
        where: { id: tenant.id },
        include: { limits: true },
      });
      expect(after.plan).toBe(plan);
      // The limits row must equal the table in @ventia/core exactly — this is
      // what makes that table the single source of truth rather than a
      // suggestion.
      expect(after.limits).toMatchObject(PLANS[plan]);
    }
  });

  it('upserts limits for a tenant that never had a TenantLimits row', async () => {
    const cookie = await operatorCookie(OPERATOR_EMAIL);
    const tenant = await makeTenant({ plan: 'basico' });
    expect(await platformDb.tenantLimits.findUnique({ where: { tenantId: tenant.id } })).toBeNull();

    const res = await request(app.getHttpServer())
      .patch(`/v1/platform/tenants/${tenant.id}/plan`)
      .set('cookie', cookie)
      .send({ plan: 'pro' });

    expect(res.status).toBe(200);
    const limits = await platformDb.tenantLimits.findUniqueOrThrow({ where: { tenantId: tenant.id } });
    expect(limits.aiMessagesMonth).toBe(3000);
    expect(limits.customDomain).toBe(true);
  });

  it('downgrades tighten the limits row too', async () => {
    // A downgrade that left `premium` limits behind would keep giving away the
    // expensive part of the product — the AI allowance — for a `basico` price.
    const cookie = await operatorCookie(OPERATOR_EMAIL);
    const tenant = await makeTenant({ plan: 'premium' });
    await platformDb.tenantLimits.create({
      data: {
        tenantId: tenant.id,
        productsMax: 10_000,
        aiMessagesMonth: 10_000,
        staffSeats: 10,
        customDomain: true,
        humanHandoff: true,
        whatsappChannel: true,
      },
    });

    await request(app.getHttpServer())
      .patch(`/v1/platform/tenants/${tenant.id}/plan`)
      .set('cookie', cookie)
      .send({ plan: 'basico' })
      .expect(200);

    const limits = await platformDb.tenantLimits.findUniqueOrThrow({ where: { tenantId: tenant.id } });
    expect(limits).toMatchObject({
      productsMax: 100,
      aiMessagesMonth: 500,
      staffSeats: 1,
      customDomain: false,
      humanHandoff: false,
      whatsappChannel: false,
    });
  });

  it('rejects an unknown plan and 404s an unknown tenant', async () => {
    const cookie = await operatorCookie(OPERATOR_EMAIL);
    const tenant = await makeTenant();

    const badPlan = await request(app.getHttpServer())
      .patch(`/v1/platform/tenants/${tenant.id}/plan`)
      .set('cookie', cookie)
      .send({ plan: 'enterprise' });
    expect(badPlan.status).toBe(400);
    expect(badPlan.body.error).toBe('VALIDATION_FAILED');

    const missing = await request(app.getHttpServer())
      .patch('/v1/platform/tenants/00000000-0000-4000-8000-000000000000/plan')
      .set('cookie', cookie)
      .send({ plan: 'pro' });
    expect(missing.status).toBe(404);
  });

  it('audit-logs the change with before and after', async () => {
    const cookie = await operatorCookie(OPERATOR_EMAIL);
    const tenant = await makeTenant({ plan: 'basico' });

    await request(app.getHttpServer())
      .patch(`/v1/platform/tenants/${tenant.id}/plan`)
      .set('cookie', cookie)
      .send({ plan: 'premium', note: 'pagó anual' })
      .expect(200);

    const audit = await platformDb.auditLog.findFirstOrThrow({
      where: { tenantId: tenant.id, action: 'platform.tenant.plan_assigned' },
    });
    expect(audit.entity).toBe('Tenant');
    expect(audit.entityId).toBe(tenant.id);
    expect(audit.actorUserId).not.toBeNull();
    expect(audit.data).toMatchObject({
      actorEmail: OPERATOR_EMAIL,
      previousPlan: 'basico',
      plan: 'premium',
      note: 'pagó anual',
    });
  });
});

// ---------------------------------------------------------------------------
// Suspend / reactivate — including the storefront-latency AC.
// ---------------------------------------------------------------------------

describe('suspend / reactivate', () => {
  /** Creates a tenant with a resolvable domain and one active product, so a
   * storefront request against it is a genuine 200 before suspension. */
  async function liveStorefront() {
    const tenant = await makeTenant({ plan: 'pro' });
    const domain = `${tenant.slug}.ventia.localhost`;
    await platformDb.tenantDomain.create({ data: { tenantId: tenant.id, domain, isPrimary: true } });
    return { tenant, domain };
  }

  const storefront = (domain: string) =>
    request(app.getHttpServer()).get('/v1/storefront/products').set('x-tenant-domain', domain);

  it('takes the storefront down IMMEDIATELY, not after the 60s resolver TTL', async () => {
    // SPEC §6 M9 AC: "suspending a tenant takes effect on the storefront in
    // < 60 s". `DomainResolver` caches the resolved tenant (status included)
    // in Redis for 60 s, so a bare status UPDATE would keep serving a
    // suspended store for up to a minute. The first request below is what
    // populates that cache; the assertion after the suspend call is that the
    // eviction beat the TTL, with no waiting at all.
    const cookie = await operatorCookie(OPERATOR_EMAIL);
    const { tenant, domain } = await liveStorefront();

    const before = await storefront(domain);
    expect(before.status).toBe(200);

    const suspend = await request(app.getHttpServer())
      .post(`/v1/platform/tenants/${tenant.id}/suspend`)
      .set('cookie', cookie)
      .send({ reason: 'impago 7 días' });
    expect(suspend.status).toBe(200);
    expect(suspend.body).toMatchObject({ status: 'suspended', storefrontEffective: 'immediate' });

    const after = await storefront(domain);
    expect(after.status).toBe(503);
    expect(after.body.error).toBe('TENANT_SUSPENDED');
  });

  it('evicts EVERY domain pointing at the tenant, not just the primary', async () => {
    // A tenant on a custom domain has at least two hosts resolving to it, each
    // cached under its own key. Evicting only one would leave the store up on
    // the other for the rest of the TTL — which is the domain the shoppers are
    // actually on.
    const cookie = await operatorCookie(OPERATOR_EMAIL);
    const { tenant, domain } = await liveStorefront();
    const custom = `tienda-${tenant.slug}.example.com`;
    await platformDb.tenantDomain.create({ data: { tenantId: tenant.id, domain: custom } });

    expect((await storefront(domain)).status).toBe(200);
    expect((await storefront(custom)).status).toBe(200);

    await request(app.getHttpServer())
      .post(`/v1/platform/tenants/${tenant.id}/suspend`)
      .set('cookie', cookie)
      .send({ reason: 'abuso' })
      .expect(200);

    expect((await storefront(domain)).status).toBe(503);
    expect((await storefront(custom)).status).toBe(503);
  });

  it('reactivation brings the storefront back immediately too', async () => {
    const cookie = await operatorCookie(OPERATOR_EMAIL);
    const { tenant, domain } = await liveStorefront();

    await request(app.getHttpServer())
      .post(`/v1/platform/tenants/${tenant.id}/suspend`)
      .set('cookie', cookie)
      .send({ reason: 'impago' })
      .expect(200);
    expect((await storefront(domain)).status).toBe(503);

    const res = await request(app.getHttpServer())
      .post(`/v1/platform/tenants/${tenant.id}/reactivate`)
      .set('cookie', cookie)
      .send({ note: 'pagó' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'live', previousStatus: 'suspended' });

    expect((await storefront(domain)).status).toBe(200);
  });

  it('requires a reason to suspend', async () => {
    const cookie = await operatorCookie(OPERATOR_EMAIL);
    const tenant = await makeTenant();

    for (const body of [{}, { reason: '' }, { reason: '   ' }]) {
      const res = await request(app.getHttpServer())
        .post(`/v1/platform/tenants/${tenant.id}/suspend`)
        .set('cookie', cookie)
        .send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect((await platformDb.tenant.findUniqueOrThrow({ where: { id: tenant.id } })).status).toBe('live');
  });

  it('refuses to "reactivate" a tenant that is not suspended', async () => {
    // Reactivating a `draft` tenant would LAUNCH a store its merchant never
    // finished onboarding — a much bigger action than undoing a suspension.
    const cookie = await operatorCookie(OPERATOR_EMAIL);
    const draft = await makeTenant({ status: 'draft' });

    const res = await request(app.getHttpServer())
      .post(`/v1/platform/tenants/${draft.id}/reactivate`)
      .set('cookie', cookie)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('TENANT_NOT_SUSPENDED');
    expect((await platformDb.tenant.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe('draft');
  });

  it('audit-logs both directions, with the reason', async () => {
    const cookie = await operatorCookie(OPERATOR_EMAIL);
    const tenant = await makeTenant();

    await request(app.getHttpServer())
      .post(`/v1/platform/tenants/${tenant.id}/suspend`)
      .set('cookie', cookie)
      .send({ reason: 'fraude reportado' })
      .expect(200);
    await request(app.getHttpServer())
      .post(`/v1/platform/tenants/${tenant.id}/reactivate`)
      .set('cookie', cookie)
      .send({ note: 'falso positivo' })
      .expect(200);

    const rows = await platformDb.auditLog.findMany({
      where: { tenantId: tenant.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(rows.map((r) => r.action)).toEqual([
      'platform.tenant.suspended',
      'platform.tenant.reactivated',
    ]);
    expect(rows[0]!.data).toMatchObject({
      reason: 'fraude reportado',
      previousStatus: 'live',
      status: 'suspended',
      cacheInvalidated: true,
      actorEmail: OPERATOR_EMAIL,
    });
    expect(rows[1]!.data).toMatchObject({ note: 'falso positivo', status: 'live' });
  });

  it('404s an unknown tenant without writing an audit row', async () => {
    const cookie = await operatorCookie(OPERATOR_EMAIL);
    const id = '00000000-0000-4000-8000-000000000001';
    const res = await request(app.getHttpServer())
      .post(`/v1/platform/tenants/${id}/suspend`)
      .set('cookie', cookie)
      .send({ reason: 'x' });
    expect(res.status).toBe(404);
    expect(await platformDb.auditLog.count({ where: { entityId: id } })).toBe(0);
  });
});

describe('cacheKeysFor', () => {
  it('builds DomainResolver\'s key format, lowercased', async () => {
    // Belt to the behavioral tests' braces: those prove the eviction works
    // end-to-end, this pins the literal format so a failure says WHICH half
    // broke. See PlatformService#setStatus limitation 1.
    const { cacheKeysFor } = await import('../src/platform/platform.service');
    expect(cacheKeysFor(['Tienda.Example.COM', ' demo.ventia.localhost '])).toEqual([
      'tenant:domain:tienda.example.com',
      'tenant:domain:demo.ventia.localhost',
    ]);
  });
});

/** Minimal valid `Order` row. Only the fields GMV reads matter; the rest are
 * the schema's non-null requirements. */
function orderRow(tenantId: string, number: number, totalCents: number, status: 'PENDING' | 'CONFIRMED' | 'DELIVERED' | 'CANCELLED') {
  return {
    tenantId,
    number,
    reference: `VNT-${tenantId.slice(0, 8)}-${number}-${Math.random().toString(36).slice(2, 8)}`,
    status,
    email: 'compradora@example.co',
    phone: '3001234567',
    shippingAddress: { departamento: 'Antioquia', municipio: 'Medellín', linea1: 'Cra 1 #2-3' },
    subtotalCents: totalCents,
    taxCents: 0,
    totalCents,
  };
}
