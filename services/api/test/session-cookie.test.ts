import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@ventia/db';
import { startTestDb } from './helpers';
import { createAuth } from '../src/auth/auth';

/**
 * The session cookie's own attributes, pinned.
 *
 * SPEC.md §9 asks for "httpOnly sessions · CSRF on admin mutations". Those are
 * two requirements with two different mechanisms, and only one of them is
 * visible in this codebase's own source:
 *
 *  - `/v1/auth/*` is protected by better-auth's origin check, configured with
 *    `trustedOrigins` in admin.module.ts. That is explicit and greppable.
 *  - `/v1/admin/*` — products, orders, settings, staff, WhatsApp numbers — has
 *    NO origin check and no CSRF token. Its protection is entirely the session
 *    cookie's `SameSite` attribute, which stops a cross-site form or fetch
 *    from carrying the cookie on a state-changing request.
 *
 * That second one is invisible: it is a default inside a dependency, and
 * nothing in this repo would fail if a future better-auth release, or a config
 * change made for an unrelated reason, flipped it to `None`. The whole admin
 * API would silently become CSRF-able, and every existing test would still
 * pass.
 *
 * Hence this file. It asserts the attributes rather than assuming them, so
 * "the admin API is CSRF-protected" is a checked fact rather than a belief.
 */

let db: Awaited<ReturnType<typeof startTestDb>>;
let prisma: PrismaClient;
let auth: ReturnType<typeof createAuth>;

beforeAll(async () => {
  db = await startTestDb();
  prisma = new PrismaClient({ datasources: { db: { url: db.url } } });
  auth = createAuth(prisma, { secret: 'test-secret', baseURL: 'http://api.ventia.localhost' });
  await auth.api.signUpEmail({
    body: { email: 'cookie@demo.co', password: 'Secret123!', name: 'Cookie' },
  });
}, 180_000);

afterAll(async () => {
  await prisma.$disconnect();
  await db.stop();
});

async function sessionCookieHeader(): Promise<string> {
  const signIn = await auth.api.signInEmail({
    body: { email: 'cookie@demo.co', password: 'Secret123!' },
    returnHeaders: true,
  });
  const raw = signIn.headers.get('set-cookie');
  if (!raw) throw new Error('sign-in returned no Set-Cookie');
  return raw;
}

describe('the admin session cookie', () => {
  it('is httpOnly, so a stored XSS cannot read it', async () => {
    // SPEC §9's "httpOnly sessions". Without it any injected script on the
    // admin origin exfiltrates a live merchant session.
    expect(await sessionCookieHeader()).toMatch(/HttpOnly/i);
  });

  it('is SameSite=Lax or Strict — the ONLY thing protecting /v1/admin/* from CSRF', async () => {
    // Nothing else guards those routes: no CSRF token, no origin check (that
    // exists only for /v1/auth/*). If this attribute became `None`, every
    // admin mutation — cancel an order, rewire payment credentials, disable a
    // WhatsApp number — would be triggerable by any site the merchant visits
    // while signed in, and no other test in this repo would notice.
    const cookie = await sessionCookieHeader();
    expect(cookie).toMatch(/SameSite=(Lax|Strict)/i);
    expect(cookie).not.toMatch(/SameSite=None/i);
  });

  it('is scoped to a path that covers the admin API', async () => {
    // A cookie pinned to `/v1/auth` would not be sent to `/v1/admin/*` at all
    // and nothing would work; asserting it keeps the scope deliberate rather
    // than incidental.
    const cookie = await sessionCookieHeader();
    const path = /Path=([^;]+)/i.exec(cookie)?.[1] ?? '/';
    expect(path).toBe('/');
  });
});
