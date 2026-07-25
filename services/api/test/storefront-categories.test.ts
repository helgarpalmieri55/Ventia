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
  // platformDb (exported by @ventia/db) is constructed at module-evaluation
  // time from process.env.DATABASE_URL, so env vars must be set BEFORE the
  // first import (static or dynamic) of @ventia/db or ../src/main — hence
  // the dynamic import below instead of a static top-of-file one (deviation
  // from the brief's literal static `import { PrismaClient } from '@ventia/db'`,
  // which would evaluate the module, and thus construct platformDb, too early;
  // see test/tenant-endpoint.test.ts for the same pattern).
  process.env.DATABASE_URL = db.url;
  process.env.REDIS_URL = 'redis://localhost:6379'; // reuse the existing dev redis; storefront tests don't need isolation from admin tests' redis keys since domains differ
  const { PrismaClient } = (await import('@ventia/db')) as { PrismaClient: typeof PrismaClientType };
  prisma = new PrismaClient({ datasources: { db: { url: db.url } } });
  const tenant = await prisma.tenant.create({ data: { slug: 'sf-cat', name: 'SF Cat', status: 'live' } });
  liveTenantId = tenant.id;
  await prisma.tenantDomain.create({ data: { tenantId: tenant.id, domain: 'sf-cat.ventia.localhost', isPrimary: true } });
  const suspended = await prisma.tenant.create({ data: { slug: 'sf-susp', name: 'SF Susp', status: 'suspended' } });
  await prisma.tenantDomain.create({ data: { tenantId: suspended.id, domain: 'sf-susp.ventia.localhost', isPrimary: true } });

  const cat = await prisma.category.create({ data: { tenantId: liveTenantId, name: 'Ropa', slug: 'ropa', position: 0 } });
  const p1 = await prisma.product.create({ data: { tenantId: liveTenantId, name: 'Camiseta', slug: 'camiseta', priceCents: 45900, status: 'active' } });
  await prisma.product.create({ data: { tenantId: liveTenantId, name: 'Borrador', slug: 'borrador', priceCents: 1000, status: 'draft' } });
  await prisma.productCategory.create({ data: { tenantId: liveTenantId, productId: p1.id, categoryId: cat.id } });
  await prisma.category.create({ data: { tenantId: liveTenantId, name: 'Vacía', slug: 'vacia', position: 1 } });

  const { createApp } = await import('../src/main');
  app = await createApp();
  await app.init();
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
  await db.stop();
});

describe('GET /v1/storefront/categories', () => {
  it('lists categories with active-product counts, ordered', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/storefront/categories')
      .set('x-tenant-domain', 'sf-cat.ventia.localhost');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { id: expect.any(String), name: 'Ropa', slug: 'ropa', productCount: 1 },
      { id: expect.any(String), name: 'Vacía', slug: 'vacia', productCount: 0 },
    ]);
  });

  it('404s for an unresolved tenant', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/storefront/categories')
      .set('x-tenant-domain', 'nope.ventia.localhost');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('TENANT_NOT_FOUND');
  });

  it('503s for a suspended tenant', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/storefront/categories')
      .set('x-tenant-domain', 'sf-susp.ventia.localhost');
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('TENANT_SUSPENDED');
  });
});
