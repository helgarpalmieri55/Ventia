import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient as PrismaClientType } from '@ventia/db';
import { startTestDb } from './helpers';

let db: Awaited<ReturnType<typeof startTestDb>>;
let prisma: PrismaClientType;
let app: INestApplication;
let liveTenantId: string;

beforeAll(async () => {
  db = await startTestDb();
  // See storefront-categories.test.ts for why this is a dynamic import
  // (platformDb is constructed at module-evaluation time from
  // process.env.DATABASE_URL, so env vars must be set first).
  process.env.DATABASE_URL = db.url;
  // Reuse the existing dev redis; a distinct domain (sf-content, not
  // storefront-categories.test.ts's sf-cat) is required here even though both
  // files reuse this same real Redis instance — DomainResolver caches
  // resolved tenants by domain string for 60s (see domain-resolver.ts), and
  // each test file spins up its own ephemeral Postgres container. Sharing a
  // domain across files risks one file's cache entry (pointing at ITS
  // container's tenantId) being served to the other file's guard, which then
  // queries a different container where that tenantId doesn't exist —
  // producing a spurious 404. This was observed empirically as a flake in the
  // full suite run and is why this file's domain differs from the brief's
  // categories-test domain despite the brief only specifying the shared
  // "beforeAll pattern" structurally, not the literal domain value for this file.
  process.env.REDIS_URL = 'redis://localhost:6379';
  const { PrismaClient } = (await import('@ventia/db')) as { PrismaClient: typeof PrismaClientType };
  prisma = new PrismaClient({ datasources: { db: { url: db.url } } });
  const tenant = await prisma.tenant.create({ data: { slug: 'sf-content', name: 'SF Content', status: 'live' } });
  liveTenantId = tenant.id;
  await prisma.tenantDomain.create({ data: { tenantId: tenant.id, domain: 'sf-content.ventia.localhost', isPrimary: true } });

  // Same PublicTenantGuard as storefront-categories.test.ts (@UseGuards(PublicTenantGuard))
  // guards this controller too — verify the draft-tenant block holds here as well.
  const draft = await prisma.tenant.create({ data: { slug: 'sf-content-draft', name: 'SF Content Draft', status: 'draft' } });
  await prisma.tenantDomain.create({ data: { tenantId: draft.id, domain: 'sf-content-draft.ventia.localhost', isPrimary: true } });
  await prisma.tenantContent.create({
    data: { tenantId: draft.id, type: 'policy_shipping', title: 'Envíos', bodyMd: 'Entregamos en 3 días.' },
  });

  const { createApp } = await import('../src/main');
  app = await createApp();
  await app.init();
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
  await db.stop();
});

describe('GET /v1/storefront/content/:type', () => {
  it('returns saved content', async () => {
    await prisma.tenantContent.create({
      data: { tenantId: liveTenantId, type: 'policy_shipping', title: 'Envíos', bodyMd: 'Entregamos en 3 días.' },
    });
    const res = await request(app.getHttpServer())
      .get('/v1/storefront/content/policy_shipping')
      .set('x-tenant-domain', 'sf-content.ventia.localhost');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ title: 'Envíos', bodyMd: 'Entregamos en 3 días.' });
  });

  it('404s CONTENT_NOT_FOUND when nothing saved', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/storefront/content/about')
      .set('x-tenant-domain', 'sf-content.ventia.localhost');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('CONTENT_NOT_FOUND');
  });

  it('400s an invalid type', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/storefront/content/bogus')
      .set('x-tenant-domain', 'sf-content.ventia.localhost');
    expect(res.status).toBe(400);
  });

  it('404s a draft (unlaunched) tenant identically to an unresolved one, even with saved content behind it', async () => {
    const unresolved = await request(app.getHttpServer())
      .get('/v1/storefront/content/policy_shipping')
      .set('x-tenant-domain', 'nope.ventia.localhost');
    const draftRes = await request(app.getHttpServer())
      .get('/v1/storefront/content/policy_shipping')
      .set('x-tenant-domain', 'sf-content-draft.ventia.localhost');

    expect(draftRes.status).toBe(404);
    expect(draftRes.body.error).toBe('TENANT_NOT_FOUND');
    expect(draftRes.status).toBe(unresolved.status);
    expect(draftRes.body).toEqual(unresolved.body);
  });
});
