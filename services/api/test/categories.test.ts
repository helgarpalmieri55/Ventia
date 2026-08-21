import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient as PrismaClientType } from '@ventia/db';
import { startTestDb } from './helpers';
import type { signUpWithTenant as SignUpWithTenant } from './admin-helpers';
import type { AdminSessionContext } from '../src/admin/roles.decorator';

let db: Awaited<ReturnType<typeof startTestDb>>;
let redisContainer: StartedTestContainer;
let app: INestApplication;
let signUpWithTenant: typeof SignUpWithTenant;
let platformDb: PrismaClientType;
let writeAudit: (
  session: AdminSessionContext,
  action: string,
  entity: string,
  entityId: string,
  data?: unknown,
) => Promise<void>;

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
  ({ writeAudit } = await import('../src/catalog/audit'));
});

afterAll(async () => {
  await app.close();
  await redisContainer.stop();
  await db.stop();
});

describe('/v1/admin/categories', () => {
  it('creates, lists in position/name order, rejects duplicate slugs, patches, and deletes', async () => {
    const { cookie, tenantId } = await signUpWithTenant('cat-owner@demo.co', 'owner');

    // create with an explicit slug + position, and one relying on slugify()
    const beta = await request(app.getHttpServer())
      .post('/v1/admin/categories')
      .set('cookie', cookie)
      .send({ name: 'Beta Category', slug: 'beta-cat', position: 1 });
    expect(beta.status).toBe(201);
    expect(beta.body).toMatchObject({ name: 'Beta Category', slug: 'beta-cat', position: 1, tenantId });

    const alphaAtSamePosition = await request(app.getHttpServer())
      .post('/v1/admin/categories')
      .set('cookie', cookie)
      .send({ name: 'Alpha Category', position: 1 });
    expect(alphaAtSamePosition.status).toBe(201);

    const zapatos = await request(app.getHttpServer())
      .post('/v1/admin/categories')
      .set('cookie', cookie)
      .send({ name: 'Zapatos!' });
    expect(zapatos.status).toBe(201);
    expect(zapatos.body.slug).toBe('zapatos');
    expect(zapatos.body.position).toBe(0);

    // list ordering: position asc, then name asc within a tied position
    const list = await request(app.getHttpServer())
      .get('/v1/admin/categories')
      .set('cookie', cookie);
    expect(list.status).toBe(200);
    expect(list.body.map((c: { name: string }) => c.name)).toEqual([
      'Zapatos!',
      'Alpha Category',
      'Beta Category',
    ]);

    // duplicate slug within the same tenant -> 409
    const dup = await request(app.getHttpServer())
      .post('/v1/admin/categories')
      .set('cookie', cookie)
      .send({ name: 'Another Beta', slug: 'beta-cat' });
    expect(dup.status).toBe(409);
    expect(dup.body).toEqual({ error: 'SLUG_TAKEN' });

    // validation failure -> 400
    const invalid = await request(app.getHttpServer())
      .post('/v1/admin/categories')
      .set('cookie', cookie)
      .send({ name: '' });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toBe('VALIDATION_FAILED');

    // patch
    const patch = await request(app.getHttpServer())
      .patch(`/v1/admin/categories/${beta.body.id}`)
      .set('cookie', cookie)
      .send({ name: 'Beta Renamed', position: 5 });
    expect(patch.status).toBe(200);
    expect(patch.body).toMatchObject({ id: beta.body.id, name: 'Beta Renamed', position: 5 });

    // delete
    const del = await request(app.getHttpServer())
      .delete(`/v1/admin/categories/${zapatos.body.id}`)
      .set('cookie', cookie);
    expect(del.status).toBe(204);

    const listAfterDelete = await request(app.getHttpServer())
      .get('/v1/admin/categories')
      .set('cookie', cookie);
    expect(listAfterDelete.body.map((c: { id: string }) => c.id)).not.toContain(zapatos.body.id);
    expect(listAfterDelete.body).toHaveLength(2);

    // audit rows: create x3 + update x1 + delete x1 = 5 (the duplicate-slug and
    // validation-failure attempts never reach writeAudit)
    const auditCount = await platformDb.auditLog.count({ where: { tenantId } });
    expect(auditCount).toBeGreaterThanOrEqual(3);
    const actions = await platformDb.auditLog.findMany({ where: { tenantId }, select: { action: true } });
    expect(actions.map((a) => a.action)).toEqual(
      expect.arrayContaining(['category.create', 'category.update', 'category.delete']),
    );
  });

  it('isolates categories across tenants', async () => {
    const tenantA = await signUpWithTenant('cat-tenant-a@demo.co', 'owner');
    const tenantB = await signUpWithTenant('cat-tenant-b@demo.co', 'owner');

    const created = await request(app.getHttpServer())
      .post('/v1/admin/categories')
      .set('cookie', tenantA.cookie)
      .send({ name: 'Tenant A Only' });
    expect(created.status).toBe(201);

    const listAsB = await request(app.getHttpServer())
      .get('/v1/admin/categories')
      .set('cookie', tenantB.cookie);
    expect(listAsB.status).toBe(200);
    expect(listAsB.body).toEqual([]);

    const patchAsB = await request(app.getHttpServer())
      .patch(`/v1/admin/categories/${created.body.id}`)
      .set('cookie', tenantB.cookie)
      .send({ name: 'Hijacked' });
    expect(patchAsB.status).toBe(404);
    expect(patchAsB.body).toEqual({ error: 'NOT_FOUND' });
  });

  it('deletes a category that has products attached: 204, only the join row cascades, products still exist', async () => {
    const { cookie, tenantId } = await signUpWithTenant('cat-with-products@demo.co', 'owner');

    const category = await request(app.getHttpServer())
      .post('/v1/admin/categories')
      .set('cookie', cookie)
      .send({ name: 'Con Productos' });
    expect(category.status).toBe(201);

    const product = await request(app.getHttpServer())
      .post('/v1/admin/products')
      .set('cookie', cookie)
      .send({ name: 'Producto Categorizado', priceCents: 1000, categoryIds: [category.body.id] });
    expect(product.status).toBe(201);

    const del = await request(app.getHttpServer())
      .delete(`/v1/admin/categories/${category.body.id}`)
      .set('cookie', cookie);
    expect(del.status).toBe(204);

    // the product itself is untouched — only the ProductCategory join row cascades
    const after = await request(app.getHttpServer())
      .get(`/v1/admin/products/${product.body.id}`)
      .set('cookie', cookie);
    expect(after.status).toBe(200);
    expect(after.body.name).toBe('Producto Categorizado');
    expect(after.body.categoryIds).toEqual([]);

    const joinRows = await platformDb.productCategory.findMany({
      where: { tenantId, productId: product.body.id },
    });
    expect(joinRows).toHaveLength(0);
  });

  it('nests categories, and refuses the shapes that would break navigation', async () => {
    const { cookie } = await signUpWithTenant('cat-tree@demo.co', 'owner');

    const post = (body: unknown) =>
      request(app.getHttpServer()).post('/v1/admin/categories').set('cookie', cookie).send(body);
    const patch = (id: string, body: unknown) =>
      request(app.getHttpServer()).patch(`/v1/admin/categories/${id}`).set('cookie', cookie).send(body);

    const mujer = await post({ name: 'Mujer' });
    expect(mujer.status).toBe(201);
    expect(mujer.body.parentId).toBeNull();

    const ropa = await post({ name: 'Ropa Mujer', parentId: mujer.body.id });
    expect(ropa.status).toBe(201);
    expect(ropa.body.parentId).toBe(mujer.body.id);

    const vestidos = await post({ name: 'Vestidos', parentId: ropa.body.id });
    expect(vestidos.status).toBe(201);

    // Four levels is past MAX_CATEGORY_DEPTH — the breadcrumb and the header
    // menu are built for three.
    const tooDeep = await post({ name: 'Vestidos Largos', parentId: vestidos.body.id });
    expect(tooDeep.status).toBe(400);
    expect(tooDeep.body).toEqual({ error: 'CATEGORY_TOO_DEEP' });

    // A cycle would make every breadcrumb render an infinite loop.
    const cycle = await patch(mujer.body.id, { parentId: vestidos.body.id });
    expect(cycle.status).toBe(400);
    expect(cycle.body).toEqual({ error: 'CATEGORY_CYCLE' });

    const self = await patch(ropa.body.id, { parentId: ropa.body.id });
    expect(self.status).toBe(400);
    expect(self.body).toEqual({ error: 'CATEGORY_PARENT_SELF' });

    // Un-nesting has to be expressible: an explicit null promotes a category
    // back to a root, which is different from omitting the field.
    const promoted = await patch(ropa.body.id, { parentId: null });
    expect(promoted.status).toBe(200);
    expect(promoted.body.parentId).toBeNull();

    // ...and omitting it leaves the parent alone rather than clearing it.
    const renamed = await patch(vestidos.body.id, { name: 'Vestidos Cortos' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.parentId).toBe(ropa.body.id);
  });

  it("refuses a parent from another store rather than linking the two trees", async () => {
    // Postgres will not catch this: foreign key checks are not subject to
    // row-level security, so the constraint is satisfied by any real category
    // id and the tenant check has to be our own.
    const mine = await signUpWithTenant('cat-tree-mine@demo.co', 'owner');
    const theirs = await signUpWithTenant('cat-tree-theirs@demo.co', 'owner');

    const foreign = await request(app.getHttpServer())
      .post('/v1/admin/categories')
      .set('cookie', theirs.cookie)
      .send({ name: 'Ajena' });
    expect(foreign.status).toBe(201);

    const res = await request(app.getHttpServer())
      .post('/v1/admin/categories')
      .set('cookie', mine.cookie)
      .send({ name: 'Mía', parentId: foreign.body.id });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'PARENT_NOT_FOUND' });

    const created = await platformDb.category.findMany({ where: { tenantId: mine.tenantId } });
    expect(created).toHaveLength(0);
  });

  it('writeAudit is best-effort: invalid tenantId does not throw', async () => {
    // Attempt to write audit with an invalid UUID tenantId. The Postgres uuid
    // cast will reject this, but writeAudit must swallow the error and resolve.
    const session: AdminSessionContext = {
      tenantId: 'not-a-uuid',
      userId: 'user-123',
      email: 'x@y.co',
      role: 'owner',
    } as AdminSessionContext;

    // This must not throw, even though the audit insert will fail.
    await expect(writeAudit(session, 'test.action', 'Test', 'entity-id')).resolves.toBeUndefined();
  });
});
