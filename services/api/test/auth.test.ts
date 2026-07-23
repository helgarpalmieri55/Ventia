import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@ventia/db';
import { startTestDb } from './helpers';
import { createAuth } from '../src/auth/auth';
import { getSessionContext } from '../src/auth/session-context';

let db: Awaited<ReturnType<typeof startTestDb>>;
let prisma: PrismaClient;
let auth: ReturnType<typeof createAuth>;

beforeAll(async () => {
  db = await startTestDb();
  prisma = new PrismaClient({ datasources: { db: { url: db.url } } });
  auth = createAuth(prisma, { secret: 'test-secret', baseURL: 'http://api.ventia.localhost' });
});

afterAll(async () => {
  await prisma.$disconnect();
  await db.stop();
});

describe('auth', () => {
  it('signs up and signs in with email/password', async () => {
    const signUp = await auth.api.signUpEmail({
      body: { email: 'owner@demo.co', password: 'Secret123!', name: 'Owner' },
    });
    expect(signUp.user.email).toBe('owner@demo.co');

    const signIn = await auth.api.signInEmail({
      body: { email: 'owner@demo.co', password: 'Secret123!' },
      returnHeaders: true,
    });
    expect(signIn.headers.get('set-cookie')).toBeTruthy();
  });

  it('getSessionContext returns membership tenant and role', async () => {
    const tenant = await prisma.tenant.create({ data: { slug: 'ctx', name: 'Ctx', status: 'live' } });
    const user = await prisma.user.findUniqueOrThrow({ where: { email: 'owner@demo.co' } });
    await prisma.membership.create({ data: { userId: user.id, tenantId: tenant.id, role: 'owner' } });

    const signIn = await auth.api.signInEmail({
      body: { email: 'owner@demo.co', password: 'Secret123!' },
      returnHeaders: true,
    });
    const cookie = signIn.headers.get('set-cookie')!;
    const ctx = await getSessionContext(auth, prisma, new Headers({ cookie }));
    expect(ctx).toMatchObject({ email: 'owner@demo.co', tenantId: tenant.id, role: 'owner' });
  });

  it('returns null without a session', async () => {
    expect(await getSessionContext(auth, prisma, new Headers())).toBeNull();
  });
});
