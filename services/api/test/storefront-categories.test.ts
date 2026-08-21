import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient as PrismaClientType } from '@ventia/db';
import { startTestDb } from './helpers';

let db: Awaited<ReturnType<typeof startTestDb>>;
let prisma: PrismaClientType;
let app: INestApplication;
let liveTenantId: string;

/**
 * A per-run suffix on every domain this file uses.
 *
 * `DomainResolver` caches domain → tenant in Redis for 60 seconds, and these
 * tests point at the shared dev Redis while getting a brand-new Postgres
 * container each run. Fixed domains therefore make two runs inside the same
 * minute resolve to the previous run's tenant id, which no longer exists — the
 * request still returns 200 (the cached tenant looks live) and every
 * tenant-scoped read comes back empty. Unique domains give each run its own
 * cache keys instead of requiring the suite to be run no more than once a
 * minute.
 */
const RUN = `${Date.now().toString(36)}`;
const LIVE_DOMAIN = `sf-cat-${RUN}.ventia.localhost`;
const SUSPENDED_DOMAIN = `sf-susp-${RUN}.ventia.localhost`;
const DRAFT_DOMAIN = `sf-draft-${RUN}.ventia.localhost`;
const UNKNOWN_DOMAIN = `nope-${RUN}.ventia.localhost`;

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
  const tenant = await prisma.tenant.create({ data: { slug: `sf-cat-${RUN}`, name: 'SF Cat', status: 'live' } });
  liveTenantId = tenant.id;
  await prisma.tenantDomain.create({ data: { tenantId: tenant.id, domain: LIVE_DOMAIN, isPrimary: true } });
  const suspended = await prisma.tenant.create({ data: { slug: `sf-susp-${RUN}`, name: 'SF Susp', status: 'suspended' } });
  await prisma.tenantDomain.create({ data: { tenantId: suspended.id, domain: SUSPENDED_DOMAIN, isPrimary: true } });

  // Draft tenants get a live TenantDomain row at provisioning time, well
  // before launch, so this fixture mirrors a real mid-onboarding merchant:
  // real category/product data already sitting behind an unlaunched domain.
  const draft = await prisma.tenant.create({ data: { slug: `sf-draft-${RUN}`, name: 'SF Draft', status: 'draft' } });
  await prisma.tenantDomain.create({ data: { tenantId: draft.id, domain: DRAFT_DOMAIN, isPrimary: true } });
  const draftCat = await prisma.category.create({ data: { tenantId: draft.id, name: 'Draft Cat', slug: 'draft-cat', position: 0 } });
  const draftProduct = await prisma.product.create({
    data: { tenantId: draft.id, name: 'Draft Product', slug: 'draft-product', priceCents: 9900, status: 'active' },
  });
  await prisma.productCategory.create({ data: { tenantId: draft.id, productId: draftProduct.id, categoryId: draftCat.id } });

  const cat = await prisma.category.create({ data: { tenantId: liveTenantId, name: 'Ropa', slug: 'ropa', position: 0 } });
  const p1 = await prisma.product.create({ data: { tenantId: liveTenantId, name: 'Camiseta', slug: 'camiseta', priceCents: 45900, status: 'active' } });
  await prisma.product.create({ data: { tenantId: liveTenantId, name: 'Borrador', slug: 'borrador', priceCents: 1000, status: 'draft' } });
  await prisma.productCategory.create({ data: { tenantId: liveTenantId, productId: p1.id, categoryId: cat.id } });
  await prisma.category.create({ data: { tenantId: liveTenantId, name: 'Vacía', slug: 'vacia', position: 1 } });
  // A child of 'Ropa': the storefront builds both its breadcrumb and its
  // drop-down menu from this one list, so the parent link has to be in it.
  await prisma.category.create({
    data: { tenantId: liveTenantId, name: 'Camisetas', slug: 'camisetas', position: 2, parentId: cat.id },
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

describe('GET /v1/storefront/categories', () => {
  it('lists categories with active-product counts, ordered', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/storefront/categories')
      .set('x-tenant-domain', LIVE_DOMAIN);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { id: expect.any(String), name: 'Ropa', slug: 'ropa', parentId: null, productCount: 1 },
      { id: expect.any(String), name: 'Vacía', slug: 'vacia', parentId: null, productCount: 0 },
      {
        id: expect.any(String),
        name: 'Camisetas',
        slug: 'camisetas',
        parentId: res.body[0].id,
        productCount: 0,
      },
    ]);
  });

  it('404s for an unresolved tenant', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/storefront/categories')
      .set('x-tenant-domain', UNKNOWN_DOMAIN);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('TENANT_NOT_FOUND');
  });

  it('503s for a suspended tenant', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/storefront/categories')
      .set('x-tenant-domain', SUSPENDED_DOMAIN);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('TENANT_SUSPENDED');
  });

  it('404s a draft (unlaunched) tenant identically to an unresolved one, even with live data behind it', async () => {
    const unresolved = await request(app.getHttpServer())
      .get('/v1/storefront/categories')
      .set('x-tenant-domain', UNKNOWN_DOMAIN);
    const draftRes = await request(app.getHttpServer())
      .get('/v1/storefront/categories')
      .set('x-tenant-domain', DRAFT_DOMAIN);

    expect(draftRes.status).toBe(404);
    expect(draftRes.body.error).toBe('TENANT_NOT_FOUND');
    // Same status and body as the unresolved-domain case — an anonymous
    // prober must not be able to distinguish "no such tenant" from "tenant
    // exists but hasn't launched yet".
    expect(draftRes.status).toBe(unresolved.status);
    expect(draftRes.body).toEqual(unresolved.body);
  });
});
