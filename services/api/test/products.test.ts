import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient as PrismaClientType } from '@ventia/db';
import { startTestDb } from './helpers';
import type { signUpWithTenant as SignUpWithTenant } from './admin-helpers';

let db: Awaited<ReturnType<typeof startTestDb>>;
let redisContainer: StartedTestContainer;
let app: INestApplication;
let signUpWithTenant: typeof SignUpWithTenant;
let platformDb: PrismaClientType;

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
}, 120_000);

afterAll(async () => {
  await app.close();
  await redisContainer.stop();
  await db.stop();
});

function minimalProduct(overrides: Record<string, unknown> = {}) {
  return { name: 'Camiseta', priceCents: 50_000, ...overrides };
}

async function createProduct(cookie: string, overrides: Record<string, unknown> = {}) {
  return request(app.getHttpServer())
    .post('/v1/admin/products')
    .set('cookie', cookie)
    .send(minimalProduct(overrides));
}

describe('/v1/admin/products', () => {
  it('creates a minimal product: 201, auto slug, defaults applied', async () => {
    const { cookie, tenantId } = await signUpWithTenant('prod-create@demo.co', 'owner');

    const res = await createProduct(cookie, { name: 'Gorra Deportiva' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      tenantId,
      name: 'Gorra Deportiva',
      slug: 'gorra-deportiva',
      priceCents: 50_000,
      status: 'draft',
      taxRate: '19',
      stock: 0,
      trackInventory: true,
      descriptionMd: '',
    });
    expect(res.body.images).toEqual([]);
    expect(res.body.variants).toEqual([]);
  });

  it('dedups slugs on collision: camiseta, then camiseta-2', async () => {
    const { cookie } = await signUpWithTenant('prod-slugdup@demo.co', 'owner');

    const first = await createProduct(cookie, { name: 'Camiseta' });
    const second = await createProduct(cookie, { name: 'Camiseta' });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(first.body.slug).toBe('camiseta');
    expect(second.body.slug).toBe('camiseta-2');
  });

  it('lists with search filter (name and sku), status filter, and pagination', async () => {
    const { cookie } = await signUpWithTenant('prod-list@demo.co', 'owner');

    await createProduct(cookie, { name: 'Camiseta Azul', sku: 'CAM-001' });
    await createProduct(cookie, { name: 'Pantalón Corto', sku: 'ZAPATO-999', status: 'active' });
    await createProduct(cookie, { name: 'Zapato Deportivo', sku: 'ZAP-777', status: 'active' });

    // search hits both a name match and a sku match, case-insensitively
    const bySearch = await request(app.getHttpServer())
      .get('/v1/admin/products?search=ZAPATO')
      .set('cookie', cookie);
    expect(bySearch.status).toBe(200);
    expect(bySearch.body.items.map((p: { name: string }) => p.name).sort()).toEqual([
      'Pantalón Corto',
      'Zapato Deportivo',
    ]);

    // status filter
    const byStatus = await request(app.getHttpServer())
      .get('/v1/admin/products?status=active')
      .set('cookie', cookie);
    expect(byStatus.status).toBe(200);
    expect(byStatus.body.total).toBe(2);
    expect(byStatus.body.items.map((p: { status: string }) => p.status)).toEqual(['active', 'active']);

    const draftOnly = await request(app.getHttpServer())
      .get('/v1/admin/products?status=draft')
      .set('cookie', cookie);
    expect(draftOnly.body.total).toBe(1);

    // pagination: 3 total, pageSize 2 -> page 1 has 2 items, page 2 has 1
    const page1 = await request(app.getHttpServer())
      .get('/v1/admin/products?pageSize=2&page=1')
      .set('cookie', cookie);
    expect(page1.body.total).toBe(3);
    expect(page1.body.page).toBe(1);
    expect(page1.body.pageSize).toBe(2);
    expect(page1.body.items).toHaveLength(2);

    const page2 = await request(app.getHttpServer())
      .get('/v1/admin/products?pageSize=2&page=2')
      .set('cookie', cookie);
    expect(page2.body.total).toBe(3);
    expect(page2.body.items).toHaveLength(1);

    // default order: createdAt desc -> most-recently created first
    const defaultList = await request(app.getHttpServer())
      .get('/v1/admin/products')
      .set('cookie', cookie);
    expect(defaultList.body.items[0].name).toBe('Zapato Deportivo');
    expect(defaultList.body.pageSize).toBe(20);

    // pageSize is clamped to 100, not rejected
    const clamped = await request(app.getHttpServer())
      .get('/v1/admin/products?pageSize=500')
      .set('cookie', cookie);
    expect(clamped.status).toBe(200);
    expect(clamped.body.pageSize).toBe(100);
  });

  it('enforces the plan product limit: 402 PLAN_LIMIT_EXCEEDED on the third create', async () => {
    const { cookie, tenantId } = await signUpWithTenant('prod-limit@demo.co', 'owner');
    await platformDb.tenantLimits.create({
      data: { tenantId, productsMax: 2, aiMessagesMonth: 1000, staffSeats: 3 },
    });

    const first = await createProduct(cookie, { name: 'Producto Uno' });
    const second = await createProduct(cookie, { name: 'Producto Dos' });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);

    const third = await createProduct(cookie, { name: 'Producto Tres' });
    expect(third.status).toBe(402);
    expect(third.body).toEqual({ error: 'PLAN_LIMIT_EXCEEDED', details: { limit: 2 } });
  });

  it('archives instead of hard-deleting; archived products are excluded from status=active and do not count toward the plan limit', async () => {
    const { cookie, tenantId } = await signUpWithTenant('prod-archive@demo.co', 'owner');
    await platformDb.tenantLimits.create({
      data: { tenantId, productsMax: 2, aiMessagesMonth: 1000, staffSeats: 3 },
    });

    const a = await createProduct(cookie, { name: 'Producto A', status: 'active' });
    const b = await createProduct(cookie, { name: 'Producto B', status: 'active' });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);

    // at the limit: a third create is rejected
    const blocked = await createProduct(cookie, { name: 'Producto Blocked', status: 'active' });
    expect(blocked.status).toBe(402);

    // archive product A
    const del = await request(app.getHttpServer())
      .delete(`/v1/admin/products/${a.body.id}`)
      .set('cookie', cookie);
    expect(del.status).toBe(204);

    // GET /:id still 200, now archived
    const getA = await request(app.getHttpServer())
      .get(`/v1/admin/products/${a.body.id}`)
      .set('cookie', cookie);
    expect(getA.status).toBe(200);
    expect(getA.body.status).toBe('archived');

    // list status=active no longer includes A
    const activeList = await request(app.getHttpServer())
      .get('/v1/admin/products?status=active')
      .set('cookie', cookie);
    expect(activeList.body.items.map((p: { id: string }) => p.id)).not.toContain(a.body.id);
    expect(activeList.body.total).toBe(1);

    // archived products don't count toward the limit -> this create now succeeds
    const c = await createProduct(cookie, { name: 'Producto C', status: 'active' });
    expect(c.status).toBe(201);
  });

  it('allows the staff role to create products', async () => {
    const { cookie } = await signUpWithTenant('prod-staff@demo.co', 'staff');

    const res = await createProduct(cookie, { name: 'Producto de Staff' });
    expect(res.status).toBe(201);
  });

  it('connects categoryIds on create and replaces them on patch', async () => {
    const { cookie } = await signUpWithTenant('prod-categories@demo.co', 'owner');

    const catA = await request(app.getHttpServer())
      .post('/v1/admin/categories')
      .set('cookie', cookie)
      .send({ name: 'Category A' });
    const catB = await request(app.getHttpServer())
      .post('/v1/admin/categories')
      .set('cookie', cookie)
      .send({ name: 'Category B' });
    const catC = await request(app.getHttpServer())
      .post('/v1/admin/categories')
      .set('cookie', cookie)
      .send({ name: 'Category C' });

    const created = await createProduct(cookie, {
      name: 'Producto Con Categorias',
      categoryIds: [catA.body.id, catB.body.id],
    });
    expect(created.status).toBe(201);

    const afterCreate = await request(app.getHttpServer())
      .get(`/v1/admin/products/${created.body.id}`)
      .set('cookie', cookie);
    expect(afterCreate.status).toBe(200);
    expect(afterCreate.body.categoryIds.sort()).toEqual([catA.body.id, catB.body.id].sort());

    const patched = await request(app.getHttpServer())
      .patch(`/v1/admin/products/${created.body.id}`)
      .set('cookie', cookie)
      .send({ categoryIds: [catC.body.id] });
    expect(patched.status).toBe(200);

    const afterPatch = await request(app.getHttpServer())
      .get(`/v1/admin/products/${created.body.id}`)
      .set('cookie', cookie);
    expect(afterPatch.body.categoryIds).toEqual([catC.body.id]);
  });

  it('atomic update: a slug-collision PATCH that also carries categoryIds rolls back the category change (409, categories unchanged)', async () => {
    const { cookie } = await signUpWithTenant('prod-atomic-slug@demo.co', 'owner');

    const catA = await request(app.getHttpServer())
      .post('/v1/admin/categories')
      .set('cookie', cookie)
      .send({ name: 'Atomic Category A' });
    const catB = await request(app.getHttpServer())
      .post('/v1/admin/categories')
      .set('cookie', cookie)
      .send({ name: 'Atomic Category B' });

    const other = await createProduct(cookie, { name: 'Producto Otro', slug: 'producto-otro' });
    expect(other.status).toBe(201);

    const target = await createProduct(cookie, {
      name: 'Producto Objetivo',
      categoryIds: [catA.body.id],
    });
    expect(target.status).toBe(201);

    const patched = await request(app.getHttpServer())
      .patch(`/v1/admin/products/${target.body.id}`)
      .set('cookie', cookie)
      .send({ slug: 'producto-otro', categoryIds: [catB.body.id] });
    expect(patched.status).toBe(409);
    expect(patched.body).toEqual({ error: 'SLUG_TAKEN' });

    const after = await request(app.getHttpServer())
      .get(`/v1/admin/products/${target.body.id}`)
      .set('cookie', cookie);
    expect(after.status).toBe(200);
    expect(after.body.slug).not.toBe('producto-otro');
    expect(after.body.categoryIds).toEqual([catA.body.id]);
  });

  it('atomic update: a bogus categoryId -> 400 VALIDATION_FAILED, product untouched', async () => {
    const { cookie } = await signUpWithTenant('prod-atomic-fk@demo.co', 'owner');

    const created = await createProduct(cookie, { name: 'Producto FK' });
    expect(created.status).toBe(201);

    const patched = await request(app.getHttpServer())
      .patch(`/v1/admin/products/${created.body.id}`)
      .set('cookie', cookie)
      .send({ categoryIds: ['00000000-0000-0000-0000-000000000099'] });
    expect(patched.status).toBe(400);
    expect(patched.body).toEqual({
      error: 'VALIDATION_FAILED',
      details: { categoryIds: 'categoría inexistente' },
    });

    const after = await request(app.getHttpServer())
      .get(`/v1/admin/products/${created.body.id}`)
      .set('cookie', cookie);
    expect(after.status).toBe(200);
    expect(after.body.categoryIds).toEqual([]);
  });

  it('PATCH sending a product its own current slug is a no-op, not a collision: 200', async () => {
    const { cookie } = await signUpWithTenant('prod-self-slug@demo.co', 'owner');

    const created = await createProduct(cookie, { name: 'Producto Propio', slug: 'producto-propio' });
    expect(created.status).toBe(201);

    const patched = await request(app.getHttpServer())
      .patch(`/v1/admin/products/${created.body.id}`)
      .set('cookie', cookie)
      .send({ slug: 'producto-propio', name: 'Producto Propio Renombrado' });

    expect(patched.status).toBe(200);
    expect(patched.body.slug).toBe('producto-propio');
    expect(patched.body.name).toBe('Producto Propio Renombrado');
  });

  it('is invisible across tenants: GET /:id of another tenant product -> 404', async () => {
    const tenantA = await signUpWithTenant('prod-tenant-a@demo.co', 'owner');
    const tenantB = await signUpWithTenant('prod-tenant-b@demo.co', 'owner');

    const created = await createProduct(tenantA.cookie, { name: 'Producto Tenant A' });
    expect(created.status).toBe(201);

    const getAsB = await request(app.getHttpServer())
      .get(`/v1/admin/products/${created.body.id}`)
      .set('cookie', tenantB.cookie);
    expect(getAsB.status).toBe(404);
    expect(getAsB.body).toEqual({ error: 'NOT_FOUND' });

    const patchAsB = await request(app.getHttpServer())
      .patch(`/v1/admin/products/${created.body.id}`)
      .set('cookie', tenantB.cookie)
      .send({ name: 'Hijacked' });
    expect(patchAsB.status).toBe(404);
    expect(patchAsB.body).toEqual({ error: 'NOT_FOUND' });
  });

  it('writes audit rows for create, update, and archive', async () => {
    const { cookie, tenantId } = await signUpWithTenant('prod-audit@demo.co', 'owner');

    const created = await createProduct(cookie, { name: 'Producto Auditado' });
    expect(created.status).toBe(201);

    const patched = await request(app.getHttpServer())
      .patch(`/v1/admin/products/${created.body.id}`)
      .set('cookie', cookie)
      .send({ name: 'Producto Auditado Renamed' });
    expect(patched.status).toBe(200);

    const archived = await request(app.getHttpServer())
      .delete(`/v1/admin/products/${created.body.id}`)
      .set('cookie', cookie);
    expect(archived.status).toBe(204);

    const actions = await platformDb.auditLog.findMany({
      where: { tenantId, entityId: created.body.id },
      select: { action: true },
    });
    expect(actions.map((a) => a.action)).toEqual(
      expect.arrayContaining(['product.create', 'product.update', 'product.archive']),
    );
  });
});
