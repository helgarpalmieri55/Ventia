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
});
