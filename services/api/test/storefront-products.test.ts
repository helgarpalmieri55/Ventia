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
  // A domain distinct from storefront-categories.test.ts's 'sf-cat' (and from
  // storefront-content.test.ts's 'sf-content') is required even though this
  // file reuses the same real dev Redis instance — DomainResolver caches
  // resolved tenants by domain string for 60s, and each test file spins up
  // its own ephemeral Postgres container with its own tenant UUIDs. Reusing
  // 'sf-cat.ventia.localhost' here (as the brief's literal example shows)
  // would risk this file's guard being served storefront-categories.test.ts's
  // cached tenantId when both run within the same 60s window — a
  // cross-container ID that doesn't exist in this file's container. This is
  // the same class of flake storefront-content.test.ts's own comment
  // documents as "observed empirically" for the identical reason, so this
  // file adopts a distinct 'sf-prod*' domain prefix rather than the brief's
  // literal 'sf-cat'/'sf-susp' domains.
  process.env.REDIS_URL = 'redis://localhost:6379';
  const { PrismaClient } = (await import('@ventia/db')) as { PrismaClient: typeof PrismaClientType };
  prisma = new PrismaClient({ datasources: { db: { url: db.url } } });
  const tenant = await prisma.tenant.create({ data: { slug: 'sf-prod', name: 'SF Prod', status: 'live' } });
  liveTenantId = tenant.id;
  await prisma.tenantDomain.create({ data: { tenantId: tenant.id, domain: 'sf-prod.ventia.localhost', isPrimary: true } });

  // A second, empty, live tenant for the cross-tenant isolation test below.
  // The brief's own note flags that a `suspended` fixture can't be used for
  // this: PublicTenantGuard 503s on `suspended` before the query ever runs
  // (already covered by Task 1's guard tests), so isolation must be proven
  // against another tenant that actually reaches StorefrontProductsService.
  const other = await prisma.tenant.create({ data: { slug: 'sf-prod-other', name: 'SF Prod Other', status: 'live' } });
  await prisma.tenantDomain.create({ data: { tenantId: other.id, domain: 'sf-prod-other.ventia.localhost', isPrimary: true } });

  await prisma.product.create({
    data: { tenantId: liveTenantId, name: 'Camiseta Básica', slug: 'camiseta-basica', priceCents: 45900, status: 'active', stock: 5 },
  });
  await prisma.product.create({
    data: { tenantId: liveTenantId, name: 'Pantalón Clásico', slug: 'pantalon-clasico', priceCents: 129900, status: 'active', stock: 0, trackInventory: true },
  });
  await prisma.product.create({
    data: { tenantId: liveTenantId, name: 'Borrador', slug: 'borrador', priceCents: 1000, status: 'draft' },
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

describe('GET /v1/storefront/products', () => {
  it('lists only active products with pagination shape', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/storefront/products')
      .set('x-tenant-domain', 'sf-prod.ventia.localhost');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.items.map((i: { slug: string }) => i.slug).sort()).toEqual(['camiseta-basica', 'pantalon-clasico']);
  });

  it('marks an out-of-stock tracked product as not in stock', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/storefront/products')
      .set('x-tenant-domain', 'sf-prod.ventia.localhost');
    const pantalon = res.body.items.find((i: { slug: string }) => i.slug === 'pantalon-clasico');
    expect(pantalon.inStock).toBe(false);
  });

  it('full-text search matches by name', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/storefront/products?search=camiseta')
      .set('x-tenant-domain', 'sf-prod.ventia.localhost');
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].slug).toBe('camiseta-basica');
  });

  it('trigram search tolerates a typo', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/storefront/products?search=camista') // missing an 'e'
      .set('x-tenant-domain', 'sf-prod.ventia.localhost');
    expect(res.body.items.map((i: { slug: string }) => i.slug)).toContain('camiseta-basica');
  });

  it('filters by priceMax', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/storefront/products?priceMax=100000')
      .set('x-tenant-domain', 'sf-prod.ventia.localhost');
    expect(res.body.items.map((i: { slug: string }) => i.slug)).toEqual(['camiseta-basica']);
  });

  it('another tenant never sees these products (isolation)', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/storefront/products')
      .set('x-tenant-domain', 'sf-prod-other.ventia.localhost');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
    expect(res.body.items).toEqual([]);
  });
});
