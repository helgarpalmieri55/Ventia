import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient as PrismaClientType } from '@ventia/db';
import { startTestDb } from './helpers';
import type { signUpWithTenant as SignUpWithTenant } from './admin-helpers';
import { MAILER, type Mailer, type MailMessage } from '../src/mailer/mailer';

let db: Awaited<ReturnType<typeof startTestDb>>;
let redisContainer: StartedTestContainer;
let app: INestApplication;
let signUpWithTenant: typeof SignUpWithTenant;
let platformDb: PrismaClientType;
let sent: MailMessage[];

const PASSWORD = 'Secret123!';

beforeAll(async () => {
  db = await startTestDb();
  redisContainer = await new GenericContainer('redis:7-alpine')
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
    .start();

  // platformDb (exported by @ventia/db) and admin-helpers' internal client are
  // both constructed at module-evaluation time from process.env.DATABASE_URL,
  // so env vars must be set BEFORE the first import (static or dynamic) of
  // @ventia/db, ../src/main, or ./admin-helpers.
  process.env.DATABASE_URL = db.url;
  process.env.REDIS_URL = `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`;

  const { createApp } = await import('../src/main');
  app = await createApp();
  await app.init();

  ({ signUpWithTenant } = await import('./admin-helpers'));
  ({ platformDb } = await import('@ventia/db'));

  // Recording double: the app's AUTH_INSTANCE (services/api/src/admin/admin.module.ts)
  // is built with `inject: [MAILER]`, so `app.get(MAILER)` returns the exact
  // singleton closed over by createAuth()'s sendVerificationEmail callback.
  // Spying on its `send` method captures every message the real auth flow
  // sends, without standing up a second app/module just to swap providers.
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

function signUpEmail(email: string) {
  return request(app.getHttpServer())
    .post('/v1/auth/sign-up/email')
    .send({ email, password: PASSWORD, name: email });
}

/** Pulls the verify-email URL out of a captured message's text body. */
function extractVerifyUrl(mail: MailMessage): URL {
  const match = mail.text.match(/(https?:\/\/\S+)/);
  if (!match) throw new Error(`no URL found in captured mail text: ${mail.text}`);
  return new URL(match[1]);
}

describe('email verification', () => {
  it('signup sends a verification email through the Mailer, addressed to the new user, with a verify URL', async () => {
    const email = 'verify-signup@demo.co';

    const res = await signUpEmail(email);
    expect(res.status).toBe(200);

    const mail = sent.find((m) => m.to === email);
    expect(mail).toBeTruthy();
    expect(mail!.subject).toBe('Verifica tu correo — Ventia');
    expect(mail!.text).toContain('/v1/auth/verify-email?token=');
  });

  it('GET-ing the verification URL flips user.emailVerified to true in the DB', async () => {
    const email = 'verify-flip@demo.co';

    const res = await signUpEmail(email);
    expect(res.status).toBe(200);

    const before = await platformDb.user.findUniqueOrThrow({ where: { email } });
    expect(before.emailVerified).toBe(false);

    const mail = sent.find((m) => m.to === email)!;
    const url = extractVerifyUrl(mail);

    const verifyRes = await request(app.getHttpServer()).get(`${url.pathname}${url.search}`);
    // better-auth redirects (302) to callbackURL ("/" by default) on success;
    // the DB flip is what this test actually cares about.
    expect([200, 302]).toContain(verifyRes.status);

    const after = await platformDb.user.findUniqueOrThrow({ where: { email } });
    expect(after.emailVerified).toBe(true);
  });

  describe('GET /v1/admin/me', () => {
    it('returns emailVerified: false for a user who never verified', async () => {
      const { cookie, tenantId } = await signUpWithTenant('me-unverified@demo.co', 'owner');

      const res = await request(app.getHttpServer()).get('/v1/admin/me').set('cookie', cookie);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ tenantId, role: 'owner', emailVerified: false });
    });

    it('returns emailVerified: true after the user verifies their email', async () => {
      const email = 'me-verified@demo.co';

      const signUp = await signUpEmail(email);
      expect(signUp.status).toBe(200);

      const mail = sent.find((m) => m.to === email)!;
      const url = extractVerifyUrl(mail);
      await request(app.getHttpServer()).get(`${url.pathname}${url.search}`);

      const user = await platformDb.user.findUniqueOrThrow({ where: { email } });
      expect(user.emailVerified).toBe(true);

      const tenant = await platformDb.tenant.create({
        data: { slug: 'me-verified-tenant', name: 'Me Verified', status: 'live' },
      });
      await platformDb.membership.create({ data: { userId: user.id, tenantId: tenant.id, role: 'owner' } });

      const signIn = await request(app.getHttpServer())
        .post('/v1/auth/sign-in/email')
        .send({ email, password: PASSWORD });
      const rawCookie = signIn.headers['set-cookie'];
      expect(rawCookie).toBeTruthy();
      const cookie = Array.isArray(rawCookie) ? rawCookie.join('; ') : rawCookie;

      const res = await request(app.getHttpServer()).get('/v1/admin/me').set('cookie', cookie);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ tenantId: tenant.id, role: 'owner', emailVerified: true });
    });
  });
});
