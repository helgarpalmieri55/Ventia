import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient as PrismaClientType } from '@ventia/db';
import { startTestDb } from './helpers';
import type { signUpAndGetCookie as SignUpAndGetCookie, signUpWithTenant as SignUpWithTenant } from './admin-helpers';

/**
 * Operator impersonation — the acceptance criteria from
 * docs/superpowers/specs/2026-08-19-impersonation-design.md §7, written
 * before the implementation precisely so the implementation is not graded on
 * its own homework.
 *
 * The single property everything here defends: **the operator stays
 * themselves and borrows a scope.** No `Session` row is minted for the
 * merchant, no `Membership` is created, and `getSessionContext` keeps
 * returning the operator's own `userId` — so the audit trail names the person
 * who actually acted, and there is no merchant credential anywhere to leak.
 *
 * Two assertions in this file are the ones the design says must hold or the
 * feature is not built (§7's closing paragraph):
 *
 *   1. `describe('the op binding')` — a grant is only valid for the operator
 *      it was issued to. Without this, a leaked token is a bearer token for
 *      someone else's store.
 *   2. `describe('attribution')` — a write performed under impersonation
 *      records the OPERATOR's userId, not the merchant's.
 *
 * Both were mutation-tested: each check was broken in turn, the specific test
 * below went red, and the break was reverted.
 */

let db: Awaited<ReturnType<typeof startTestDb>>;
let redisContainer: StartedTestContainer;
let app: INestApplication;
let platformDb: PrismaClientType;
let signUpWithTenant: typeof SignUpWithTenant;
let signUpAndGetCookie: typeof SignUpAndGetCookie;

// Impersonation internals, imported dynamically after env is set (see beforeAll).
let IMPERSONATION_COOKIE: string;
let IMPERSONATION_TTL_MS: number;
let signImpersonationGrant: typeof import('../src/auth/impersonation').signImpersonationGrant;
let verifyImpersonationGrant: typeof import('../src/auth/impersonation').verifyImpersonationGrant;
let issueImpersonationGrant: typeof import('../src/auth/impersonation').issueImpersonationGrant;
let withImpersonationWriteAllowlist: typeof import('../src/auth/impersonation-policy').withImpersonationWriteAllowlist;
let normalizeRoutePath: typeof import('../src/auth/impersonation-policy').normalizeRoutePath;

const AUTH_SECRET = 'impersonation-test-secret';
const OPERATOR_A = 'ops-a@ventia.co';
const OPERATOR_B = 'ops-b@ventia.co';
const ALLOWLIST = ` OPS-A@Ventia.co , ops-b@ventia.co `;

/** operator id → session cookie. */
let operatorA: { userId: string; cookie: string };
let operatorB: { userId: string; cookie: string };
/** The store an operator enters. */
let store: { cookie: string; tenantId: string; userId: string };
/** A DIFFERENT store, used for the "grant for X on a request that resolves Y" case. */
let otherStore: { cookie: string; tenantId: string; userId: string };
const OTHER_STORE_HOST = 'otra-tienda.ventia.localhost';

async function makeOperator(email: string): Promise<{ userId: string; cookie: string }> {
  const cookie = await signUpAndGetCookie(email);
  // BOTH controls, set directly in the DB — the same fixture shape as
  // test/platform-admin.test.ts. `emailVerified` because there is no test
  // mailbox to click a link in; `isPlatformAdmin` because NO APPLICATION CODE
  // PATH SETS IT, which is that column's entire purpose.
  const user = await platformDb.user.update({
    where: { email },
    data: { emailVerified: true, isPlatformAdmin: true },
    select: { id: true },
  });
  return { userId: user.id, cookie };
}

/** Pulls the impersonation grant out of a `set-cookie` header list. */
function grantCookieFrom(res: request.Response): string | null {
  const raw = res.headers['set-cookie'];
  const all = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const entry = all.find((c) => c.startsWith(`${IMPERSONATION_COOKIE}=`));
  if (!entry) return null;
  return entry.split(';')[0];
}

function setCookieEntry(res: request.Response): string | undefined {
  const raw = res.headers['set-cookie'];
  const all = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return all.find((c) => c.startsWith(`${IMPERSONATION_COOKIE}=`));
}

/** Issues a real grant through the real endpoint. Returns the cookie PAIR a
 * browser would send back: the operator's session AND the grant. */
async function impersonate(
  operator: { cookie: string },
  tenantId: string,
  body: Record<string, unknown> = {},
): Promise<{ res: request.Response; cookies: string[] }> {
  const res = await request(app.getHttpServer())
    .post(`/v1/platform/tenants/${tenantId}/impersonate`)
    .set('cookie', operator.cookie)
    .send(body);
  const grant = grantCookieFrom(res);
  return { res, cookies: grant ? [operator.cookie, grant] : [operator.cookie] };
}

/** A hand-minted grant cookie, for the cases a real issue cannot produce
 * (already expired, signed by somebody else, `op` pointing at another user). */
function forgedGrantCookie(
  grant: { op: string; ten: string; exp: number },
  secret = AUTH_SECRET,
): string {
  return `${IMPERSONATION_COOKIE}=${signImpersonationGrant(grant, secret)}`;
}

beforeAll(async () => {
  db = await startTestDb();
  redisContainer = await new GenericContainer('redis:7-alpine')
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
    .start();

  // Env BEFORE the first (dynamic) import of @ventia/db, ../src/main or
  // ./admin-helpers — each constructs a PrismaClient / better-auth instance at
  // module scope. AUTH_SECRET in particular must be set before admin.module's
  // AUTH_INSTANCE factory runs, so the app signs sessions and grants with the
  // same secret this file signs its forgeries with.
  process.env.DATABASE_URL = db.url;
  process.env.REDIS_URL = `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`;
  process.env.AUTH_SECRET = AUTH_SECRET;
  process.env.PLATFORM_ADMIN_EMAILS = ALLOWLIST;

  const { createApp } = await import('../src/main');
  app = await createApp();
  await app.init();

  ({ platformDb } = await import('@ventia/db'));
  ({ signUpWithTenant, signUpAndGetCookie } = await import('./admin-helpers'));

  const impersonationModule = await import('../src/auth/impersonation');
  ({ IMPERSONATION_COOKIE, signImpersonationGrant, verifyImpersonationGrant, issueImpersonationGrant } =
    impersonationModule);
  const policyModule = await import('../src/auth/impersonation-policy');
  ({ withImpersonationWriteAllowlist, normalizeRoutePath } = policyModule);
  ({ IMPERSONATION_TTL_MS } = await import('@ventia/core'));

  operatorA = await makeOperator(OPERATOR_A);
  operatorB = await makeOperator(OPERATOR_B);
  store = await signUpWithTenant('tienda-impersonada@demo.co', 'owner');
  otherStore = await signUpWithTenant('otra-tienda@demo.co', 'owner');
  await platformDb.tenantDomain.create({
    data: { tenantId: otherStore.tenantId, domain: OTHER_STORE_HOST, isPrimary: true },
  });
}, 240_000);

afterAll(async () => {
  process.env.PLATFORM_ADMIN_EMAILS = ALLOWLIST;
  await app.close();
  await redisContainer.stop();
  await db.stop();
});

// ---------------------------------------------------------------------------
// The token itself (design §2). No HTTP — these are the properties the whole
// rest of the file leans on.
// ---------------------------------------------------------------------------

describe('the grant token', () => {
  it('is exactly { op, ten, exp } and expires 30 minutes after issue', () => {
    const now = 1_700_000_000_000;
    const { token, grant } = issueImpersonationGrant('op-1', 'ten-1', AUTH_SECRET, now);
    expect(grant).toEqual({ op: 'op-1', ten: 'ten-1', exp: now + IMPERSONATION_TTL_MS });
    expect(IMPERSONATION_TTL_MS).toBe(30 * 60 * 1000);

    const payload = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));
    // No extra claims. A token that carried, say, the merchant's user id
    // would be a step back toward "acting as them".
    expect(Object.keys(payload).sort()).toEqual(['exp', 'op', 'ten']);
  });

  it('does not verify under a different secret, so it is the server that says who may act', () => {
    const { token } = issueImpersonationGrant('op-1', 'ten-1', 'some-other-secret');
    expect(verifyImpersonationGrant(token, AUTH_SECRET)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('does not verify with a tampered payload — the tenant cannot be swapped in flight', () => {
    const { token } = issueImpersonationGrant('op-1', 'ten-1', AUTH_SECRET);
    const [, sig] = token.split('.');
    const swapped = Buffer.from(JSON.stringify({ op: 'op-1', ten: 'ten-2', exp: Date.now() + 60_000 }));
    expect(verifyImpersonationGrant(`${swapped.toString('base64url')}.${sig}`, AUTH_SECRET)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('refuses a truncated signature rather than throwing (timingSafeEqual would)', () => {
    const { token } = issueImpersonationGrant('op-1', 'ten-1', AUTH_SECRET);
    const truncated = `${token.split('.')[0]}.abc`;
    expect(() => verifyImpersonationGrant(truncated, AUTH_SECRET)).not.toThrow();
    expect(verifyImpersonationGrant(truncated, AUTH_SECRET).ok).toBe(false);
  });

  it('expires BY CONSTRUCTION — past exp it does not verify at all', () => {
    const now = 1_700_000_000_000;
    const { token } = issueImpersonationGrant('op-1', 'ten-1', AUTH_SECRET, now);
    // Minute 29: still good.
    expect(verifyImpersonationGrant(token, AUTH_SECRET, now + 29 * 60_000).ok).toBe(true);
    // Minute 31: gone. Design §7's "expiry enforced at 31 minutes".
    expect(verifyImpersonationGrant(token, AUTH_SECRET, now + 31 * 60_000)).toEqual({
      ok: false,
      reason: 'expired',
    });
    // And exactly at the deadline, which is the boundary somebody eventually
    // gets wrong with a `>`.
    expect(verifyImpersonationGrant(token, AUTH_SECRET, now + IMPERSONATION_TTL_MS).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Issuing (design §3)
// ---------------------------------------------------------------------------

describe('POST /v1/platform/tenants/:id/impersonate', () => {
  it('returns the banner payload and sets a cookie with the pinned attributes', async () => {
    const before = Date.now();
    const { res } = await impersonate(operatorA, store.tenantId, { reason: 'ticket #42' });
    const after = Date.now();

    expect(res.status).toBe(200);
    expect(res.body.impersonation).toMatchObject({
      operatorId: operatorA.userId,
      operatorEmail: OPERATOR_A,
      tenantId: store.tenantId,
    });
    expect(typeof res.body.impersonation.tenantName).toBe('string');
    const expiresAt = new Date(res.body.impersonation.expiresAt).getTime();
    expect(expiresAt).toBeGreaterThanOrEqual(before + IMPERSONATION_TTL_MS);
    expect(expiresAt).toBeLessThanOrEqual(after + IMPERSONATION_TTL_MS);

    // The same attributes test/session-cookie.test.ts pins for the session
    // cookie, and for the same reasons: `/v1/admin/*` has no CSRF token and no
    // origin check, so SameSite is the entire defence — and a grant that a
    // stored XSS could read out of document.cookie would be thirty minutes of
    // owner scope inside a named merchant's store.
    const entry = setCookieEntry(res)!;
    expect(entry).toMatch(/HttpOnly/i);
    expect(entry).toMatch(/SameSite=(Lax|Strict)/i);
    expect(entry).not.toMatch(/SameSite=None/i);
    expect(/Path=([^;]+)/i.exec(entry)?.[1]).toBe('/');
    // Secure mirrors better-auth's own rule (baseURL starts with https). The
    // test app runs on http, so it must be ABSENT here — asserting it is
    // present would make this test pass in dev for the wrong reason.
    expect(process.env.API_URL ?? 'http://api.ventia.localhost').toMatch(/^http:/);
    expect(entry).not.toMatch(/;\s*Secure/i);
    // The cookie dies when the signature does.
    const maxAge = Number(/Max-Age=(\d+)/i.exec(entry)?.[1]);
    expect(maxAge).toBeGreaterThan(29 * 60);
    expect(maxAge).toBeLessThanOrEqual(30 * 60);
  });

  it('writes a platform audit row naming the operator, the tenant, and the reason', async () => {
    await impersonate(operatorA, store.tenantId, { reason: 'revisando envíos' });
    const row = await platformDb.auditLog.findFirst({
      where: { action: 'platform.tenant.impersonation_started', tenantId: store.tenantId },
      orderBy: { createdAt: 'desc' },
    });
    expect(row).not.toBeNull();
    expect(row!.actorUserId).toBe(operatorA.userId);
    expect(row!.entityId).toBe(store.tenantId);
    expect(row!.data).toMatchObject({ actorEmail: OPERATOR_A, reason: 'revisando envíos' });
  });

  it('ISSUES NOTHING when the audit write fails — an unrecorded impersonation must not happen', async () => {
    // Design §3's ordering, made into a fact. Every OTHER platform mutation
    // deliberately swallows an audit failure (the mutation already committed);
    // this one must not, because here the audit row is what makes the grant
    // legitimate in the first place.
    //
    // Spied at the module boundary rather than on `platformDb.auditLog.create`
    // — the Prisma delegate is a proxy whose method has no restorable
    // descriptor, so `mockRestore()` leaves it `undefined` and every later
    // audit write in the file dies. Learned the hard way.
    const auditModule = await import('../src/platform/platform-audit');
    const spy = vi
      .spyOn(auditModule, 'writePlatformAuditOrThrow')
      .mockRejectedValueOnce(new Error('audit table is on fire'));
    try {
      const res = await request(app.getHttpServer())
        .post(`/v1/platform/tenants/${store.tenantId}/impersonate`)
        .set('cookie', operatorA.cookie)
        .send({});
      expect(res.status).toBeGreaterThanOrEqual(500);
      expect(grantCookieFrom(res)).toBeNull();
    } finally {
      spy.mockRestore();
    }

    // ...and the very next attempt succeeds AND audits, so the assertion above
    // was about the ordering rather than about a permanently broken fixture.
    const recovered = await impersonate(operatorA, store.tenantId);
    expect(recovered.res.status).toBe(200);
    expect(grantCookieFrom(recovered.res)).not.toBeNull();
  });

  it('404s for a tenant that does not exist, and 400s for a non-uuid', async () => {
    const missing = await request(app.getHttpServer())
      .post('/v1/platform/tenants/00000000-0000-4000-8000-000000000000/impersonate')
      .set('cookie', operatorA.cookie)
      .send({});
    expect(missing.status).toBe(404);
    expect(grantCookieFrom(missing)).toBeNull();

    const bad = await request(app.getHttpServer())
      .post('/v1/platform/tenants/not-a-uuid/impersonate')
      .set('cookie', operatorA.cookie)
      .send({});
    expect(bad.status).toBe(400);
  });

  it('MINTS NO SESSION and NO MEMBERSHIP — the operator stays themselves (design §1)', async () => {
    const sessionsBefore = await platformDb.session.count({ where: { userId: store.userId } });
    const membershipsBefore = await platformDb.membership.count({ where: { userId: operatorA.userId } });

    const { res } = await impersonate(operatorA, store.tenantId);
    expect(res.status).toBe(200);

    // The rejected design would have created a Session row for the merchant's
    // user — a full account takeover sitting in a cookie jar. Nothing here
    // creates one, and nothing creates a Membership either, so an
    // impersonation can never be mistaken for a staff seat or count against
    // one.
    expect(await platformDb.session.count({ where: { userId: store.userId } })).toBe(sessionsBefore);
    expect(await platformDb.membership.count({ where: { userId: operatorA.userId } })).toBe(membershipsBefore);
    expect(membershipsBefore).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Who may obtain one (design §7: "a non-operator cannot obtain a grant")
// ---------------------------------------------------------------------------

describe('only a Ventia operator can obtain a grant', () => {
  async function attempt(cookie?: string) {
    let req = request(app.getHttpServer()).post(`/v1/platform/tenants/${store.tenantId}/impersonate`);
    if (cookie) req = req.set('cookie', cookie);
    return req.send({});
  }

  it('refuses an anonymous caller', async () => {
    const res = await attempt();
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHENTICATED');
    expect(grantCookieFrom(res)).toBeNull();
  });

  it('refuses a merchant owner — including the owner of the very store named in the path', async () => {
    const res = await attempt(store.cookie);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('NOT_PLATFORM_ADMIN');
    expect(grantCookieFrom(res)).toBeNull();
  });

  it('refuses an allowlisted, verified user whose User.isPlatformAdmin is false', async () => {
    await platformDb.user.update({ where: { email: OPERATOR_B }, data: { isPlatformAdmin: false } });
    try {
      const res = await attempt(operatorB.cookie);
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('NOT_PLATFORM_ADMIN');
      expect(grantCookieFrom(res)).toBeNull();
    } finally {
      await platformDb.user.update({ where: { email: OPERATOR_B }, data: { isPlatformAdmin: true } });
    }
  });

  it('refuses a verified, flagged operator when the allowlist is unset — fails closed', async () => {
    delete process.env.PLATFORM_ADMIN_EMAILS;
    try {
      const res = await attempt(operatorA.cookie);
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('NOT_PLATFORM_ADMIN');
      expect(grantCookieFrom(res)).toBeNull();
    } finally {
      process.env.PLATFORM_ADMIN_EMAILS = ALLOWLIST;
    }
  });

  it('refuses an allowlisted, flagged operator whose email is not verified', async () => {
    await platformDb.user.update({ where: { email: OPERATOR_B }, data: { emailVerified: false } });
    try {
      const res = await attempt(operatorB.cookie);
      expect(res.status).toBe(403);
      expect(grantCookieFrom(res)).toBeNull();
    } finally {
      await platformDb.user.update({ where: { email: OPERATOR_B }, data: { emailVerified: true } });
    }
  });
});

// ---------------------------------------------------------------------------
// THE op binding (design §2, §7). Mutation-tested.
// ---------------------------------------------------------------------------

describe('the op binding — a grant is valid only for the operator it was issued to', () => {
  it("rejects operator A's grant presented with operator B's session", async () => {
    const { res } = await impersonate(operatorA, store.tenantId);
    const grant = grantCookieFrom(res)!;

    // The leak scenario: B got A's token out of a log, a screenshot, a shared
    // machine. B is a REAL operator with real platform privilege — so nothing
    // but the `op` comparison stands between them and A's granted store.
    const asB = await request(app.getHttpServer())
      .get('/v1/admin/me')
      .set('cookie', [operatorB.cookie, grant]);
    expect(asB.status).toBe(403);
    expect(asB.body.error).toBe('IMPERSONATION_NOT_BOUND');
  });

  it("rejects an operator's grant presented with a MERCHANT's session", async () => {
    const { res } = await impersonate(operatorA, otherStore.tenantId);
    const grant = grantCookieFrom(res)!;

    // A merchant who obtained a grant must not be able to ride it into
    // another merchant's store. Their own session resolves their own tenant;
    // the grant names someone else's.
    const asMerchant = await request(app.getHttpServer())
      .get('/v1/admin/me')
      .set('cookie', [store.cookie, grant]);
    expect(asMerchant.status).toBe(403);
    expect(asMerchant.body.error).toBe('IMPERSONATION_NOT_BOUND');
  });

  it('rejects a grant presented with NO session at all — it is a scope, not a credential', async () => {
    const { res } = await impersonate(operatorA, store.tenantId);
    const grant = grantCookieFrom(res)!;

    const anonymous = await request(app.getHttpServer()).get('/v1/admin/me').set('cookie', grant);
    expect(anonymous.status).toBe(401);
    expect(anonymous.body.error).toBe('UNAUTHENTICATED');
  });

  it('rejects a grant whose op claim was rewritten (the signature covers it)', async () => {
    const forged = forgedGrantCookie({
      op: operatorB.userId,
      ten: store.tenantId,
      exp: Date.now() + IMPERSONATION_TTL_MS,
    }, 'not-the-servers-secret');
    const res = await request(app.getHttpServer())
      .get('/v1/admin/me')
      .set('cookie', [operatorB.cookie, forged]);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('IMPERSONATION_INVALID');
  });

  it('rejects a well-signed grant for a user who is no longer an operator', async () => {
    // Beyond the design's minimum, and deliberate: `UPDATE "User" SET
    // "isPlatformAdmin" = false` is this codebase's documented revocation for
    // an operator, and it should not take up to thirty minutes to reach a
    // cookie already in a browser.
    const { res } = await impersonate(operatorB, store.tenantId);
    const grant = grantCookieFrom(res)!;
    expect(
      (await request(app.getHttpServer()).get('/v1/admin/me').set('cookie', [operatorB.cookie, grant])).status,
    ).toBe(200);

    await platformDb.user.update({ where: { email: OPERATOR_B }, data: { isPlatformAdmin: false } });
    try {
      const after = await request(app.getHttpServer())
        .get('/v1/admin/me')
        .set('cookie', [operatorB.cookie, grant]);
      expect(after.status).toBe(403);
      expect(after.body.error).toBe('IMPERSONATION_REVOKED');
    } finally {
      await platformDb.user.update({ where: { email: OPERATOR_B }, data: { isPlatformAdmin: true } });
    }
  });
});

// ---------------------------------------------------------------------------
// Tenant scoping (design §6, §7)
// ---------------------------------------------------------------------------

describe('a grant names one tenant', () => {
  it('rejects a grant for tenant X on a request that resolves tenant Y', async () => {
    const { cookies } = await impersonate(operatorA, store.tenantId);
    const res = await request(app.getHttpServer())
      .get('/v1/admin/me')
      .set('cookie', cookies)
      // TenantMiddleware resolves THIS host to the other store. A request
      // that names two different tenants is incoherent and is refused before
      // it reaches a query — RLS would stop it anyway (design §6), but not by
      // accident of a lower layer.
      .set('host', OTHER_STORE_HOST);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('IMPERSONATION_TENANT_MISMATCH');
  });

  it('allows the same request when the resolved tenant IS the granted one', async () => {
    const domain = `tienda-impersonada.ventia.localhost`;
    await platformDb.tenantDomain.upsert({
      where: { domain },
      create: { tenantId: store.tenantId, domain, isPrimary: true },
      update: { tenantId: store.tenantId },
    });
    const { cookies } = await impersonate(operatorA, store.tenantId);
    const res = await request(app.getHttpServer()).get('/v1/admin/me').set('cookie', cookies).set('host', domain);
    expect(res.status).toBe(200);
    expect(res.body.impersonation.tenantId).toBe(store.tenantId);
  });
});

// ---------------------------------------------------------------------------
// Expiry: 30 minutes hard, no sliding window (design §2, §7)
// ---------------------------------------------------------------------------

describe('expiry', () => {
  it('rejects a grant that was issued 31 minutes ago', async () => {
    const issued = Date.now() - 31 * 60_000;
    const expired = forgedGrantCookie({
      op: operatorA.userId,
      ten: store.tenantId,
      exp: issued + IMPERSONATION_TTL_MS,
    });
    const res = await request(app.getHttpServer())
      .get('/v1/admin/me')
      .set('cookie', [operatorA.cookie, expired]);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('IMPERSONATION_EXPIRED');
  });

  it('accepts one issued 29 minutes ago, and does NOT extend its deadline', async () => {
    // The sliding-window failure this guards against: an operator who leaves a
    // tab open would otherwise be inside a merchant's store indefinitely.
    const issued = Date.now() - 29 * 60_000;
    const exp = issued + IMPERSONATION_TTL_MS;
    const nearlyDone = forgedGrantCookie({ op: operatorA.userId, ten: store.tenantId, exp });

    for (let i = 0; i < 3; i += 1) {
      const res = await request(app.getHttpServer())
        .get('/v1/admin/me')
        .set('cookie', [operatorA.cookie, nearlyDone]);
      expect(res.status).toBe(200);
      // Same deadline every time — the server reports the instant it signed,
      // not "thirty minutes from this request".
      expect(new Date(res.body.impersonation.expiresAt).getTime()).toBe(exp);
      // ...and nothing re-issues the cookie behind the operator's back.
      expect(setCookieEntry(res)).toBeUndefined();
    }
  });

  it('a fresh grant reports the same deadline on every later request', async () => {
    const { res: issue, cookies } = await impersonate(operatorA, store.tenantId);
    const deadline = issue.body.impersonation.expiresAt;
    for (let i = 0; i < 3; i += 1) {
      const me = await request(app.getHttpServer()).get('/v1/admin/me').set('cookie', cookies);
      expect(me.status).toBe(200);
      expect(me.body.impersonation.expiresAt).toBe(deadline);
      expect(setCookieEntry(me)).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Attribution — the property the whole design exists for (design §7).
// Mutation-tested.
// ---------------------------------------------------------------------------

describe('attribution: a write under impersonation records the OPERATOR', () => {
  const ALLOW_CATEGORY_CREATE = [
    {
      method: 'POST' as const,
      path: '/v1/admin/categories',
      why: 'test-only: design §7 requires proving operator attribution on a real write, and the shipped allow-list is empty',
    },
  ];

  it("names the operator's userId, never the merchant's, on the audit row", async () => {
    const { cookies } = await impersonate(operatorA, store.tenantId);

    const created = await withImpersonationWriteAllowlist(ALLOW_CATEGORY_CREATE, async () =>
      request(app.getHttpServer())
        .post('/v1/admin/categories')
        .set('cookie', cookies)
        .send({ name: 'Categoría creada por soporte' }),
    );
    expect(created.status).toBe(201);
    // RLS is unchanged: the row lands in the granted tenant and nowhere else.
    expect(created.body.tenantId).toBe(store.tenantId);

    const audit = await platformDb.auditLog.findFirst({
      where: { action: 'category.create', entityId: created.body.id },
    });
    expect(audit).not.toBeNull();
    // THE assertion. `writeAudit` records `session.userId`; the rejected
    // design (mint a session as the merchant) would have put `store.userId`
    // here and made the merchant's own log assert they did something they did
    // not do.
    expect(audit!.actorUserId).toBe(operatorA.userId);
    expect(audit!.actorUserId).not.toBe(store.userId);
    expect(audit!.tenantId).toBe(store.tenantId);
  });

  it('reports the operator, not the merchant, as the acting user on /v1/admin/me', async () => {
    const { cookies } = await impersonate(operatorA, store.tenantId);
    const me = await request(app.getHttpServer()).get('/v1/admin/me').set('cookie', cookies);
    expect(me.status).toBe(200);
    expect(me.body.userId).toBe(operatorA.userId);
    expect(me.body.userId).not.toBe(store.userId);
    expect(me.body.email).toBe(OPERATOR_A);
    expect(me.body.tenantId).toBe(store.tenantId);
    // Borrowed, not granted: no Membership row backs this.
    expect(me.body.role).toBe('owner');
  });
});

// ---------------------------------------------------------------------------
// Writes are an allow-list, default deny (design §4)
// ---------------------------------------------------------------------------

describe('writes are an allow-list, default deny', () => {
  it('reads are broadly available — support can see the store as the merchant does', async () => {
    const { cookies } = await impersonate(operatorA, store.tenantId);
    for (const path of ['/v1/admin/me', '/v1/admin/categories', '/v1/admin/products', '/v1/admin/orders']) {
      const res = await request(app.getHttpServer()).get(path).set('cookie', cookies);
      expect(res.status, path).toBe(200);
    }
  });

  it('refuses an ordinary write that nobody has reviewed onto the list', async () => {
    const { cookies } = await impersonate(operatorA, store.tenantId);
    const res = await request(app.getHttpServer())
      .post('/v1/admin/categories')
      .set('cookie', cookies)
      .send({ name: 'No debería existir' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('IMPERSONATION_READ_ONLY');
    expect(await platformDb.category.count({ where: { tenantId: store.tenantId, name: 'No debería existir' } })).toBe(0);
  });

  it('refuses writes behind AuthenticatedGuard too, not only AdminSessionGuard', async () => {
    // POST /v1/admin/onboarding/tenant is the one admin route fronted by the
    // lighter guard. "Default deny on writes" has to be a property of the
    // system, not of one guard, or the next route added there inherits a hole.
    const { cookies } = await impersonate(operatorA, store.tenantId);
    const res = await request(app.getHttpServer())
      .post('/v1/admin/onboarding/tenant')
      .set('cookie', cookies)
      .send({ name: 'Tienda fantasma' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('IMPERSONATION_READ_ONLY');
  });

  it('leaves the merchant\'s own writes completely untouched', async () => {
    // The policy applies to impersonated requests, not to the store's owner.
    const res = await request(app.getHttpServer())
      .post('/v1/admin/categories')
      .set('cookie', store.cookie)
      .send({ name: 'Categoría del comerciante' });
    expect(res.status).toBe(201);
  });

  it('normalizes uuid segments so a rule names a route, not a row', () => {
    expect(normalizeRoutePath('/v1/admin/customers/3f2504e0-4f89-41d3-9a0c-0305e82c3301/anonymize?x=1')).toBe(
      '/v1/admin/customers/:id/anonymize',
    );
    // A non-uuid last segment is meaningful and must NOT be collapsed.
    expect(normalizeRoutePath('/v1/admin/settings/payments')).toBe('/v1/admin/settings/payments');
  });
});

// ---------------------------------------------------------------------------
// The three refused categories (design §4, §7)
// ---------------------------------------------------------------------------

describe('the three categories §4 refuses regardless of the audit trail', () => {
  // A body that WOULD anonymize. Deliberately valid: if the refusal ever moved
  // out of the guard these requests would reach the handler and actually
  // destroy the PII, and the "still there" assertions below would catch it —
  // an invalid body would let a broken guard hide behind a 400.
  const VALID_ANONYMIZE_BODY = { requestChannel: 'correo', confirm: 'ANONIMIZAR' };

  it('REFUSES POST /v1/admin/customers/:id/anonymize — Ley 1581 supresión is one-way', async () => {
    // Named explicitly by the design, so named explicitly here. An operator
    // must never trigger a shopper's supresión while wearing a merchant's
    // face, and the merchant must never have to explain to the SIC an
    // anonymization they did not request.
    const customer = await platformDb.customer.create({
      data: {
        tenantId: store.tenantId,
        email: 'compradora@example.com',
        name: 'Compradora Real',
        phone: '+573001112233',
      },
    });
    const { cookies } = await impersonate(operatorA, store.tenantId);

    const res = await request(app.getHttpServer())
      .post(`/v1/admin/customers/${customer.id}/anonymize`)
      .set('cookie', cookies)
      .send(VALID_ANONYMIZE_BODY);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('IMPERSONATION_FORBIDDEN_ROUTE');

    // The PII is still there. An audit row would have been no remedy.
    const after = await platformDb.customer.findUnique({ where: { id: customer.id } });
    expect(after).toMatchObject({ email: 'compradora@example.com', name: 'Compradora Real', phone: '+573001112233' });
  });

  it('REFUSES it even if someone later widens the write allow-list to include it', async () => {
    const customer = await platformDb.customer.create({
      data: { tenantId: store.tenantId, email: 'segunda@example.com', name: 'Segunda' },
    });
    const { cookies } = await impersonate(operatorA, store.tenantId);

    const res = await withImpersonationWriteAllowlist(
      [{ method: 'POST', path: '/v1/admin/customers/:id/anonymize', why: 'test: hard deny must win' }],
      async () =>
        request(app.getHttpServer())
          .post(`/v1/admin/customers/${customer.id}/anonymize`)
          .set('cookie', cookies)
          .send(VALID_ANONYMIZE_BODY),
    );
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('IMPERSONATION_FORBIDDEN_ROUTE');
    expect((await platformDb.customer.findUnique({ where: { id: customer.id } }))?.email).toBe('segunda@example.com');
  });

  it('REFUSES anything that emails or messages a real customer (§4.2)', async () => {
    const { cookies } = await impersonate(operatorA, store.tenantId);
    const orderId = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
    for (const transition of ['confirm', 'preparing', 'shipped', 'delivered', 'cancel']) {
      const res = await request(app.getHttpServer())
        .patch(`/v1/admin/orders/${orderId}/${transition}`)
        .set('cookie', cookies)
        .send({});
      // 403 from the policy, NOT a 404 for the made-up order id — the refusal
      // happens in the guard, before the handler ever looks the order up.
      expect(res.status, transition).toBe(403);
      expect(res.body.error, transition).toBe('IMPERSONATION_FORBIDDEN_ROUTE');
    }
  });

  it('REFUSES credential and identity surfaces (§4.3)', async () => {
    const { cookies } = await impersonate(operatorA, store.tenantId);
    const id = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
    const routes: Array<[string, string]> = [
      ['patch', '/v1/admin/settings/payments'],
      ['post', `/v1/admin/settings/payments/${id}/test-connection`],
      ['post', '/v1/admin/whatsapp/numbers'],
      ['patch', `/v1/admin/whatsapp/numbers/${id}`],
      ['delete', `/v1/admin/whatsapp/numbers/${id}`],
      ['post', '/v1/admin/staff/invites'],
      ['delete', `/v1/admin/staff/invites/${id}`],
      ['delete', `/v1/admin/staff/${id}`],
      ['post', '/v1/admin/domains'],
      ['post', `/v1/admin/domains/${id}/verify`],
      ['delete', `/v1/admin/domains/${id}`],
    ];
    for (const [method, path] of routes) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res = await (request(app.getHttpServer()) as any)[method](path).set('cookie', cookies).send({});
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(res.body.error, `${method} ${path}`).toBe('IMPERSONATION_FORBIDDEN_ROUTE');
    }
  });
});

// ---------------------------------------------------------------------------
// The banner's source of truth (design §5, §7)
// ---------------------------------------------------------------------------

describe('GET /v1/admin/me is the banner\'s source of truth', () => {
  it('carries the impersonation context whenever a valid grant is presented', async () => {
    const { cookies } = await impersonate(operatorA, store.tenantId);
    const me = await request(app.getHttpServer()).get('/v1/admin/me').set('cookie', cookies);
    expect(me.status).toBe(200);
    expect(me.body.impersonation).toMatchObject({
      operatorId: operatorA.userId,
      operatorEmail: OPERATOR_A,
      tenantId: store.tenantId,
    });
    // Everything the banner needs, from ONE response: who, which store (by
    // name, not uuid), and how long is left.
    expect(typeof me.body.impersonation.tenantName).toBe('string');
    expect(me.body.impersonation.tenantName.length).toBeGreaterThan(0);
    expect(Number.isNaN(new Date(me.body.impersonation.expiresAt).getTime())).toBe(false);
  });

  it('reports impersonation: null — explicitly — for an ordinary merchant session', async () => {
    const me = await request(app.getHttpServer()).get('/v1/admin/me').set('cookie', store.cookie);
    expect(me.status).toBe(200);
    expect(me.body).toHaveProperty('impersonation');
    expect(me.body.impersonation).toBeNull();
    expect(me.body.userId).toBe(store.userId);
  });

  it('stops reporting it once DELETE clears the grant', async () => {
    const { res, cookies } = await impersonate(operatorA, store.tenantId);
    expect(res.body.impersonation).toBeTruthy();

    const ended = await request(app.getHttpServer())
      .delete(`/v1/platform/tenants/${store.tenantId}/impersonate`)
      .set('cookie', cookies);
    expect(ended.status).toBe(200);
    expect(ended.body).toEqual({ ended: true });

    // The clearing Set-Cookie must carry the SAME attributes as the one that
    // created it, or a browser treats it as a different cookie and clears
    // nothing — leaving the operator inside the store while the UI shows them
    // out.
    const cleared = setCookieEntry(ended)!;
    expect(cleared).toMatch(/HttpOnly/i);
    expect(cleared).toMatch(/SameSite=Lax/i);
    expect(/Path=([^;]+)/i.exec(cleared)?.[1]).toBe('/');
    expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970|Max-Age=0/i);

    // And a session with no grant cookie is back to the operator's own
    // (tenant-less) identity — which is a NO_TENANT, not a store.
    const after = await request(app.getHttpServer()).get('/v1/admin/me').set('cookie', operatorA.cookie);
    expect(after.status).toBe(403);
    expect(after.body.error).toBe('NO_TENANT');
  });

  it('DELETE is idempotent and records the end', async () => {
    const again = await request(app.getHttpServer())
      .delete(`/v1/platform/tenants/${store.tenantId}/impersonate`)
      .set('cookie', operatorA.cookie);
    expect(again.status).toBe(200);
    const row = await platformDb.auditLog.findFirst({
      where: { action: 'platform.tenant.impersonation_ended', tenantId: store.tenantId },
      orderBy: { createdAt: 'desc' },
    });
    expect(row?.actorUserId).toBe(operatorA.userId);
  });

  it('a malformed grant cookie is refused rather than silently ignored', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/admin/me')
      .set('cookie', [operatorA.cookie, `${IMPERSONATION_COOKIE}=garbage`]);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('IMPERSONATION_INVALID');
  });
});

// ---------------------------------------------------------------------------
// GET /v1/platform/me — why it exists
// ---------------------------------------------------------------------------

describe('GET /v1/platform/me', () => {
  it('answers the question /v1/admin/me cannot answer for an operator', async () => {
    // The motivating fact, asserted rather than described: an operator with no
    // store of their own is a NO_TENANT on the merchant surface, so the
    // console header has nothing to render — on the very surface where the
    // actions land on other companies.
    const admin = await request(app.getHttpServer()).get('/v1/admin/me').set('cookie', operatorA.cookie);
    expect(admin.status).toBe(403);
    expect(admin.body.error).toBe('NO_TENANT');

    const platform = await request(app.getHttpServer()).get('/v1/platform/me').set('cookie', operatorA.cookie);
    expect(platform.status).toBe(200);
    expect(platform.body).toEqual({ userId: operatorA.userId, email: OPERATOR_A });
  });

  it('exposes nothing beyond the two fields the guard already proved', async () => {
    const res = await request(app.getHttpServer()).get('/v1/platform/me').set('cookie', operatorA.cookie);
    expect(Object.keys(res.body).sort()).toEqual(['email', 'userId']);
  });

  it('is behind PlatformAdminGuard like every other platform route', async () => {
    const anonymous = await request(app.getHttpServer()).get('/v1/platform/me');
    expect(anonymous.status).toBe(401);
    expect(anonymous.body.error).toBe('UNAUTHENTICATED');

    const merchant = await request(app.getHttpServer()).get('/v1/platform/me').set('cookie', store.cookie);
    expect(merchant.status).toBe(403);
    expect(merchant.body.error).toBe('NOT_PLATFORM_ADMIN');
  });
});
