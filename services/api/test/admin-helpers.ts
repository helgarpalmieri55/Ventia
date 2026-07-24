import { PrismaClient } from '@ventia/db';
import { createAuth } from '../src/auth/auth';

// A fresh PrismaClient + better-auth instance bound to the test container URL,
// deliberately separate from the app-under-test's own AUTH_INSTANCE (which is
// wired through Nest DI in src/admin/admin.module.ts). Both point at the same
// underlying Postgres container and use the same secret/baseURL defaults, so a
// session created here is valid when presented to the running app.
//
// This module reads process.env.DATABASE_URL at import time (module-level
// PrismaClient construction), so callers MUST set DATABASE_URL before the
// first (dynamic) import of this file — same env-before-import pattern used
// for '../src/main' in test/tenant-endpoint.test.ts.
const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
const auth = createAuth(prisma, {
  secret: process.env.AUTH_SECRET ?? 'dev-secret-change-me',
  baseURL: process.env.API_URL ?? 'http://api.ventia.localhost',
});

const PASSWORD = 'Secret123!';

/** Signs up a fresh user (no tenant/membership) and returns a session cookie. */
export async function signUpAndGetCookie(email: string): Promise<string> {
  await auth.api.signUpEmail({ body: { email, password: PASSWORD, name: email } });
  const signIn = await auth.api.signInEmail({
    body: { email, password: PASSWORD },
    returnHeaders: true,
  });
  const cookie = signIn.headers.get('set-cookie');
  if (!cookie) throw new Error('signInEmail did not return a set-cookie header');
  return cookie;
}

/** Signs up a user, creates a tenant + membership for them, and returns a session cookie. */
export async function signUpWithTenant(
  email: string,
  role: 'owner' | 'staff',
): Promise<{ cookie: string; tenantId: string; userId: string }> {
  const signUp = await auth.api.signUpEmail({ body: { email, password: PASSWORD, name: email } });
  const tenant = await prisma.tenant.create({
    data: { slug: email.split('@')[0], name: email, status: 'live' },
  });
  await prisma.membership.create({ data: { userId: signUp.user.id, tenantId: tenant.id, role } });

  const signIn = await auth.api.signInEmail({
    body: { email, password: PASSWORD },
    returnHeaders: true,
  });
  const cookie = signIn.headers.get('set-cookie');
  if (!cookie) throw new Error('signInEmail did not return a set-cookie header');
  return { cookie, tenantId: tenant.id, userId: signUp.user.id };
}
