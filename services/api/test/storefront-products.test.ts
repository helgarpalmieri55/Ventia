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

  // A dedicated tenant for the category-filter/sort tests below, kept
  // separate from `sf-prod` so its fixed 2-product fixture above (and the
  // `total: 2` assertion against it) never has to change as coverage grows.
  const sortTenant = await prisma.tenant.create({ data: { slug: 'sf-prod-sort', name: 'SF Prod Sort', status: 'live' } });
  await prisma.tenantDomain.create({ data: { tenantId: sortTenant.id, domain: 'sf-prod-sort.ventia.localhost', isPrimary: true } });
  const ropaCategory = await prisma.category.create({ data: { tenantId: sortTenant.id, name: 'Ropa', slug: 'ropa', position: 0 } });
  // Three products with diverging price/date orderings to ensure sort=price
  // and sort=newest tests catch accidental ORDER BY branch swaps:
  // - sort=price (ascending): [producto-tres, producto-uno, producto-dos]
  // - sort=newest (descending): [producto-tres, producto-dos, producto-uno]
  const productA = await prisma.product.create({
    data: {
      tenantId: sortTenant.id,
      name: 'Producto Uno',
      slug: 'producto-uno',
      priceCents: 3000,
      status: 'active',
      createdAt: new Date('2020-01-01T00:00:00Z'),
    },
  });
  await prisma.productCategory.create({ data: { tenantId: sortTenant.id, productId: productA.id, categoryId: ropaCategory.id } });
  await prisma.product.create({
    data: {
      tenantId: sortTenant.id,
      name: 'Producto Dos',
      slug: 'producto-dos',
      priceCents: 5000,
      status: 'active',
      createdAt: new Date('2020-01-02T00:00:00Z'),
    },
  });
  await prisma.product.create({
    data: {
      tenantId: sortTenant.id,
      name: 'Producto Tres',
      slug: 'producto-tres',
      priceCents: 1000,
      status: 'active',
      createdAt: new Date('2020-01-03T00:00:00Z'),
    },
  });

  // A dedicated tenant with exactly `pageSize` active products, for the
  // out-of-range-page `total` test (Finding 1): page 2 must report the same
  // real `total` as page 1 even though its `items` come back empty.
  const pageTenant = await prisma.tenant.create({ data: { slug: 'sf-prod-page', name: 'SF Prod Page', status: 'live' } });
  await prisma.tenantDomain.create({ data: { tenantId: pageTenant.id, domain: 'sf-prod-page.ventia.localhost', isPrimary: true } });
  for (let i = 0; i < 5; i++) {
    await prisma.product.create({
      data: { tenantId: pageTenant.id, name: `Producto Página ${i}`, slug: `producto-pagina-${i}`, priceCents: 1000 + i, status: 'active' },
    });
  }

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

  it('filters by category', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/storefront/products?category=ropa')
      .set('x-tenant-domain', 'sf-prod-sort.ventia.localhost');
    expect(res.status).toBe(200);
    expect(res.body.items.map((i: { slug: string }) => i.slug)).toEqual(['producto-uno']);
  });

  it('sort=price returns ascending by priceCents', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/storefront/products?sort=price')
      .set('x-tenant-domain', 'sf-prod-sort.ventia.localhost');
    expect(res.status).toBe(200);
    expect(res.body.items.map((i: { slug: string }) => i.slug)).toEqual(['producto-tres', 'producto-uno', 'producto-dos']);
  });

  it('sort=newest returns descending by createdAt', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/storefront/products?sort=newest')
      .set('x-tenant-domain', 'sf-prod-sort.ventia.localhost');
    expect(res.status).toBe(200);
    expect(res.body.items.map((i: { slug: string }) => i.slug)).toEqual(['producto-tres', 'producto-dos', 'producto-uno']);
  });

  it('reports the real total on an out-of-range page instead of 0 (Finding 1)', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/storefront/products?page=2&pageSize=5')
      .set('x-tenant-domain', 'sf-prod-page.ventia.localhost');
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
    expect(res.body.total).toBe(5);
  });

  it('rejects a non-numeric page with 400 VALIDATION_FAILED (Finding 2)', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/storefront/products?page=abc')
      .set('x-tenant-domain', 'sf-prod.ventia.localhost');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_FAILED');
    expect(res.body.details.page).toBeTruthy();
  });

  it('rejects a fractional page with 400 VALIDATION_FAILED', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/storefront/products?page=1.5')
      .set('x-tenant-domain', 'sf-prod.ventia.localhost');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_FAILED');
    expect(res.body.details.page).toBeTruthy();
  });

  it('rejects a fractional pageSize with 400 VALIDATION_FAILED', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/storefront/products?pageSize=2.5')
      .set('x-tenant-domain', 'sf-prod.ventia.localhost');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_FAILED');
    expect(res.body.details.pageSize).toBeTruthy();
  });

  it('accepts a fractional priceMax (a peso amount, not required to be integer cents)', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/storefront/products?priceMax=100000.5')
      .set('x-tenant-domain', 'sf-prod.ventia.localhost');
    expect(res.status).toBe(200);
  });
});

describe('GET /v1/storefront/products/:slug', () => {
  it('returns full detail for an active product', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/storefront/products/camiseta-basica')
      .set('x-tenant-domain', 'sf-prod.ventia.localhost');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'Camiseta Básica', slug: 'camiseta-basica', inStock: true });
    expect(Array.isArray(res.body.related)).toBe(true);
  });

  it('404s a draft product by slug', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/storefront/products/borrador')
      .set('x-tenant-domain', 'sf-prod.ventia.localhost');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('PRODUCT_NOT_FOUND');
  });

  // The brief's version of this test assumes a 'ropa' category already
  // exists under the same tenant as 'camiseta-basica' — but in this file's
  // fixtures 'ropa' belongs to the separate `sf-prod-sort` tenant (see
  // beforeAll), while 'camiseta-basica' lives under `liveTenantId`
  // (`sf-prod`). Rather than borrow a category across tenants, this test
  // creates its own category under `liveTenantId` so the relation stays
  // tenant-scoped like the real feature would require.
  it('related products exclude self and other-category items, cap at 4', async () => {
    const cat = await prisma.category.create({
      data: { tenantId: liveTenantId, name: 'Ropa Detalle', slug: 'ropa-detalle', position: 0 },
    });
    const target = await prisma.product.findFirstOrThrow({ where: { tenantId: liveTenantId, slug: 'camiseta-basica' } });
    await prisma.productCategory.create({ data: { tenantId: liveTenantId, productId: target.id, categoryId: cat.id } });
    for (let i = 0; i < 5; i += 1) {
      const p = await prisma.product.create({
        data: { tenantId: liveTenantId, name: `Relacionado ${i}`, slug: `relacionado-${i}`, priceCents: 10000, status: 'active' },
      });
      await prisma.productCategory.create({ data: { tenantId: liveTenantId, productId: p.id, categoryId: cat.id } });
    }
    const res = await request(app.getHttpServer())
      .get('/v1/storefront/products/camiseta-basica')
      .set('x-tenant-domain', 'sf-prod.ventia.localhost');
    expect(res.body.related.length).toBeLessThanOrEqual(4);
    expect(res.body.related.every((r: { slug: string }) => r.slug !== 'camiseta-basica')).toBe(true);
  });
});
