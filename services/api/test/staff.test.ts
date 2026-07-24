import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient as PrismaClientType } from '@ventia/db';
import { createHash } from 'node:crypto';
import { startTestDb } from './helpers';
import type { signUpAndGetCookie as SignUpAndGetCookie, signUpWithTenant as SignUpWithTenant } from './admin-helpers';
import { MAILER, type Mailer, type MailMessage } from '../src/mailer/mailer';

let db: Awaited<ReturnType<typeof startTestDb>>;
let redisContainer: StartedTestContainer;
let app: INestApplication;
let signUpAndGetCookie: typeof SignUpAndGetCookie;
let signUpWithTenant: typeof SignUpWithTenant;
let platformDb: PrismaClientType;
let sent: MailMessage[];

beforeAll(async () => {
  db = await startTestDb();
  redisContainer = await new GenericContainer('redis:7-alpine')
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
    .start();

  process.env.DATABASE_URL = db.url;
  process.env.REDIS_URL = `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`;

  const { createApp } = await import('../src/main');
  app = await createApp();
  await app.init();

  ({ signUpAndGetCookie, signUpWithTenant } = await import('./admin-helpers'));
  ({ platformDb } = await import('@ventia/db'));

  sent = [];
  const mailer = app.get<Mailer>(MAILER);
  vi.spyOn(mailer, 'send').mockImplementation(async (msg) => {
    sent.push(msg);
  });
}, 120_000);

afterAll(async () => {
  await app.close();
  await redisContainer.stop();
  await db.stop();
});

function invite(cookie: string, email: string) {
  return request(app.getHttpServer()).post('/v1/admin/staff/invites').set('cookie', cookie).send({ email });
}

function accept(cookie: string, token: string) {
  return request(app.getHttpServer()).post('/v1/staff/accept').set('cookie', cookie).send({ token });
}

/** Pulls the raw accept token out of a captured invite mail's text body. */
function extractToken(mail: MailMessage): string {
  const match = mail.text.match(/\/v1\/staff\/accept\?token=([0-9a-f]{48})/);
  if (!match) throw new Error(`no accept token found in captured mail text: ${mail.text}`);
  return match[1]!;
}

describe('POST /v1/admin/staff/invites → POST /v1/staff/accept (full flow)', () => {
  it('owner invites a brand-new email; the invitee signs up, accepts, and /v1/admin/me reflects staff + tenant', async () => {
    const { cookie: ownerCookie, tenantId } = await signUpWithTenant('staff-flow-owner@demo.co', 'owner');
    const inviteeEmail = 'staff-flow-newbie@demo.co';

    const inviteRes = await invite(ownerCookie, inviteeEmail);
    expect(inviteRes.status).toBe(201);
    expect(inviteRes.body).toMatchObject({ email: inviteeEmail });
    expect(inviteRes.body.id).toBeTruthy();
    expect(inviteRes.body.expiresAt).toBeTruthy();

    const mail = sent.find((m) => m.to === inviteeEmail);
    expect(mail).toBeTruthy();
    expect(mail!.subject).toContain('Ventia');
    expect(mail!.subject).toContain('Invitación');
    expect(mail!.text).toContain('/v1/staff/accept?token=');
    const token = extractToken(mail!);

    const inviteeCookie = await signUpAndGetCookie(inviteeEmail);
    const acceptRes = await accept(inviteeCookie, token);
    expect(acceptRes.status).toBe(201);
    expect(acceptRes.body).toEqual({ tenantId, role: 'staff' });

    const me = await request(app.getHttpServer()).get('/v1/admin/me').set('cookie', inviteeCookie);
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ tenantId, role: 'staff' });

    const audits = await platformDb.auditLog.findMany({ where: { tenantId, action: 'staff.invite' } });
    expect(audits.length).toBe(1);
    const acceptAudits = await platformDb.auditLog.findMany({ where: { tenantId, action: 'staff.accept' } });
    expect(acceptAudits.length).toBe(1);
  });
});

describe('seat limits', () => {
  it('402 PLAN_LIMIT_EXCEEDED once the seat count (accepted + pending) reaches staffSeats', async () => {
    const { cookie: ownerCookie, tenantId } = await signUpWithTenant('staff-seats-owner@demo.co', 'owner');
    await platformDb.tenantLimits.create({
      data: { tenantId, productsMax: 100, aiMessagesMonth: 500, staffSeats: 1 },
    });

    // First invite succeeds and is accepted, consuming the only seat.
    const firstEmail = 'staff-seats-first@demo.co';
    const firstInvite = await invite(ownerCookie, firstEmail);
    expect(firstInvite.status).toBe(201);
    const firstMail = sent.find((m) => m.to === firstEmail)!;
    const firstToken = extractToken(firstMail);
    const firstCookie = await signUpAndGetCookie(firstEmail);
    const firstAccept = await accept(firstCookie, firstToken);
    expect(firstAccept.status).toBe(201);

    // Seat now taken by an accepted staff member — next invite is blocked.
    const secondRes = await invite(ownerCookie, 'staff-seats-second@demo.co');
    expect(secondRes.status).toBe(402);
    expect(secondRes.body).toEqual({ error: 'PLAN_LIMIT_EXCEEDED', details: { limit: 1 } });
  });

  it('a pending (unaccepted) invite counts toward the seat limit too', async () => {
    const { cookie: ownerCookie, tenantId } = await signUpWithTenant('staff-seats-pending-owner@demo.co', 'owner');
    await platformDb.tenantLimits.create({
      data: { tenantId, productsMax: 100, aiMessagesMonth: 500, staffSeats: 1 },
    });

    const firstRes = await invite(ownerCookie, 'staff-seats-pending-first@demo.co');
    expect(firstRes.status).toBe(201);

    const secondRes = await invite(ownerCookie, 'staff-seats-pending-second@demo.co');
    expect(secondRes.status).toBe(402);
    expect(secondRes.body).toEqual({ error: 'PLAN_LIMIT_EXCEEDED', details: { limit: 1 } });
  });

  it('no tenantLimits row means unlimited seats', async () => {
    const { cookie: ownerCookie } = await signUpWithTenant('staff-seats-unlimited-owner@demo.co', 'owner');

    const first = await invite(ownerCookie, 'staff-seats-unlimited-a@demo.co');
    const second = await invite(ownerCookie, 'staff-seats-unlimited-b@demo.co');
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
  });
});

describe('POST /v1/admin/staff/invites conflicts', () => {
  it('409 ALREADY_MEMBER when the email already belongs to a member of this tenant', async () => {
    const { cookie: ownerCookie } = await signUpWithTenant('staff-already-member@demo.co', 'owner');

    const res = await invite(ownerCookie, 'staff-already-member@demo.co');

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'ALREADY_MEMBER' });
  });

  it('409 INVITE_EXISTS for a second pending invite to the same email', async () => {
    const { cookie: ownerCookie } = await signUpWithTenant('staff-invite-exists-owner@demo.co', 'owner');
    const email = 'staff-invite-exists-invitee@demo.co';

    const first = await invite(ownerCookie, email);
    expect(first.status).toBe(201);

    const second = await invite(ownerCookie, email);
    expect(second.status).toBe(409);
    expect(second.body).toEqual({ error: 'INVITE_EXISTS' });
  });
});

describe('POST /v1/staff/accept invalid-token cases', () => {
  it('400 INVITE_INVALID for an expired invite', async () => {
    const { tenantId } = await signUpWithTenant('staff-expired-owner@demo.co', 'owner');
    const raw = 'a'.repeat(48);
    const tokenHash = createHash('sha256').update(raw).digest('hex');
    await platformDb.staffInvite.create({
      data: {
        tenantId,
        email: 'staff-expired-invitee@demo.co',
        tokenHash,
        expiresAt: new Date(Date.now() - 1000),
      },
    });

    const cookie = await signUpAndGetCookie('staff-expired-invitee@demo.co');
    const res = await accept(cookie, raw);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'INVITE_INVALID' });
  });

  it('400 INVITE_INVALID for a revoked invite', async () => {
    const { cookie: ownerCookie } = await signUpWithTenant('staff-revoked-owner@demo.co', 'owner');
    const email = 'staff-revoked-invitee@demo.co';

    const inviteRes = await invite(ownerCookie, email);
    expect(inviteRes.status).toBe(201);
    const mail = sent.find((m) => m.to === email)!;
    const token = extractToken(mail);

    const revokeRes = await request(app.getHttpServer())
      .delete(`/v1/admin/staff/invites/${inviteRes.body.id}`)
      .set('cookie', ownerCookie);
    expect(revokeRes.status).toBe(204);

    const cookie = await signUpAndGetCookie(email);
    const res = await accept(cookie, token);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'INVITE_INVALID' });
  });

  it('400 INVITE_INVALID on a double accept of the same token', async () => {
    const { cookie: ownerCookie } = await signUpWithTenant('staff-double-accept-owner@demo.co', 'owner');
    const email = 'staff-double-accept-invitee@demo.co';

    const inviteRes = await invite(ownerCookie, email);
    expect(inviteRes.status).toBe(201);
    const mail = sent.find((m) => m.to === email)!;
    const token = extractToken(mail);
    const cookie = await signUpAndGetCookie(email);

    const first = await accept(cookie, token);
    expect(first.status).toBe(201);

    const second = await accept(cookie, token);
    expect(second.status).toBe(400);
    expect(second.body).toEqual({ error: 'INVITE_INVALID' });
  });

  it('409 ALREADY_HAS_TENANT when the accepting session already belongs to a different tenant', async () => {
    const { cookie: ownerCookie } = await signUpWithTenant('staff-oc-owner@demo.co', 'owner');
    const inviteRes = await invite(ownerCookie, 'staff-oc-invitee@demo.co');
    expect(inviteRes.status).toBe(201);
    const mail = sent.find((m) => m.to === 'staff-oc-invitee@demo.co')!;
    const token = extractToken(mail);

    // A completely different, already-tenanted user tries to redeem the token.
    const { cookie: otherCookie } = await signUpWithTenant('staff-oc-other-owner@demo.co', 'owner');

    const res = await accept(otherCookie, token);

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'ALREADY_HAS_TENANT' });
  });
});

describe('role + removal', () => {
  it('403 FORBIDDEN_ROLE when staff tries to invite', async () => {
    const { cookie: staffCookie } = await signUpWithTenant('staff-forbidden@demo.co', 'staff');

    const res = await invite(staffCookie, 'someone@demo.co');

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'FORBIDDEN_ROLE' });
  });

  it('400 CANNOT_REMOVE_OWNER when an owner tries to remove themselves', async () => {
    const { cookie: ownerCookie, userId } = await signUpWithTenant('staff-remove-owner@demo.co', 'owner');

    const res = await request(app.getHttpServer())
      .delete(`/v1/admin/staff/${userId}`)
      .set('cookie', ownerCookie);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'CANNOT_REMOVE_OWNER' });
  });

  it('removing a staff member 204s and their /v1/admin/me now 403s NO_TENANT', async () => {
    const { cookie: ownerCookie, tenantId } = await signUpWithTenant('staff-remove-owner-2@demo.co', 'owner');
    const email = 'staff-remove-staffer@demo.co';

    const inviteRes = await invite(ownerCookie, email);
    expect(inviteRes.status).toBe(201);
    const mail = sent.find((m) => m.to === email)!;
    const token = extractToken(mail);
    const staffCookie = await signUpAndGetCookie(email);
    const acceptRes = await accept(staffCookie, token);
    expect(acceptRes.status).toBe(201);
    const staffUserId = (await platformDb.user.findUniqueOrThrow({ where: { email } })).id;

    const removeRes = await request(app.getHttpServer())
      .delete(`/v1/admin/staff/${staffUserId}`)
      .set('cookie', ownerCookie);
    expect(removeRes.status).toBe(204);

    const me = await request(app.getHttpServer()).get('/v1/admin/me').set('cookie', staffCookie);
    expect(me.status).toBe(403);
    expect(me.body).toEqual({ error: 'NO_TENANT' });

    const removeAudits = await platformDb.auditLog.findMany({ where: { tenantId, action: 'staff.remove' } });
    expect(removeAudits.length).toBe(1);
  });

  it('404 for removing a userId with no membership in this tenant', async () => {
    const { cookie: ownerCookie } = await signUpWithTenant('staff-remove-404@demo.co', 'owner');
    const { userId: strangerId } = await signUpWithTenant('staff-remove-404-stranger@demo.co', 'owner');

    const res = await request(app.getHttpServer())
      .delete(`/v1/admin/staff/${strangerId}`)
      .set('cookie', ownerCookie);

    expect(res.status).toBe(404);
  });
});

describe('GET /v1/admin/staff', () => {
  it('lists members (with user email/name) and pending invites only', async () => {
    const { cookie: ownerCookie, userId } = await signUpWithTenant('staff-list-owner@demo.co', 'owner');
    const email = 'staff-list-invitee@demo.co';

    const inviteRes = await invite(ownerCookie, email);
    expect(inviteRes.status).toBe(201);

    const res = await request(app.getHttpServer()).get('/v1/admin/staff').set('cookie', ownerCookie);
    expect(res.status).toBe(200);
    expect(res.body.members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ userId, email: 'staff-list-owner@demo.co', role: 'owner' }),
      ]),
    );
    expect(res.body.invites).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: inviteRes.body.id, email })]),
    );

    // Accept, then confirm the invite drops out of the pending list.
    const mail = sent.find((m) => m.to === email)!;
    const token = extractToken(mail);
    const staffCookie = await signUpAndGetCookie(email);
    await accept(staffCookie, token);

    const afterAccept = await request(app.getHttpServer()).get('/v1/admin/staff').set('cookie', ownerCookie);
    expect(afterAccept.body.invites).toEqual([]);
    expect(afterAccept.body.members).toEqual(
      expect.arrayContaining([expect.objectContaining({ email, role: 'staff' })]),
    );
  });
});

describe('cross-tenant isolation', () => {
  it("404 when owner of tenant B revokes tenant A's invite id", async () => {
    const { cookie: ownerACookie } = await signUpWithTenant('staff-cross-a@demo.co', 'owner');
    const { cookie: ownerBCookie } = await signUpWithTenant('staff-cross-b@demo.co', 'owner');

    const inviteRes = await invite(ownerACookie, 'staff-cross-invitee@demo.co');
    expect(inviteRes.status).toBe(201);

    const res = await request(app.getHttpServer())
      .delete(`/v1/admin/staff/invites/${inviteRes.body.id}`)
      .set('cookie', ownerBCookie);

    expect(res.status).toBe(404);
  });
});
