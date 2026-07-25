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

function launch(cookie: string) {
  return request(app.getHttpServer()).post('/v1/admin/launch').set('cookie', cookie);
}

describe('POST /v1/admin/launch', () => {
  it('422 LAUNCH_CHECKLIST_INCOMPLETE naming every missing item for a fresh draft tenant', async () => {
    const { cookie, tenantId } = await signUpWithTenant('launch-fresh@demo.co', 'owner');
    await platformDb.tenant.update({ where: { id: tenantId }, data: { status: 'draft' } });

    const res = await launch(cookie);

    expect(res.status).toBe(422);
    expect(res.body).toEqual({
      error: 'LAUNCH_CHECKLIST_INCOMPLETE',
      details: {
        storeInfo: false,
        emailVerified: false,
        hasActiveProduct: false,
        paymentsReady: false,
        ready: false,
      },
    });

    const tenant = await platformDb.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    expect(tenant.status).toBe('draft');
  });

  it('walks the checklist to green, launches, and is idempotent on a second call', async () => {
    const { cookie, tenantId, userId } = await signUpWithTenant('launch-happy@demo.co', 'owner');
    await platformDb.tenant.update({ where: { id: tenantId }, data: { status: 'draft' } });

    // Still incomplete after only storeInfo.
    await request(app.getHttpServer())
      .patch('/v1/admin/settings/store')
      .set('cookie', cookie)
      .send({ storeInfo: { contactEmail: 'launch-happy@demo.co' } });

    const afterStoreInfo = await launch(cookie);
    expect(afterStoreInfo.status).toBe(422);
    expect(afterStoreInfo.body.details).toMatchObject({ storeInfo: true, ready: false });

    // Verify the owner's own email.
    await platformDb.user.update({ where: { id: userId }, data: { emailVerified: true } });

    const afterEmail = await launch(cookie);
    expect(afterEmail.status).toBe(422);
    expect(afterEmail.body.details).toMatchObject({ emailVerified: true, ready: false });

    // Active product.
    await request(app.getHttpServer())
      .post('/v1/admin/products')
      .set('cookie', cookie)
      .send({ name: 'Producto Lanzamiento', priceCents: 20_000, status: 'active' });

    const afterProduct = await launch(cookie);
    expect(afterProduct.status).toBe(422);
    expect(afterProduct.body.details).toMatchObject({ hasActiveProduct: true, ready: false });

    // COD payments.
    await request(app.getHttpServer())
      .patch('/v1/admin/settings/payments')
      .set('cookie', cookie)
      .send({ codEnabled: true });

    const res = await launch(cookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: 'live',
      checklist: {
        storeInfo: true,
        emailVerified: true,
        hasActiveProduct: true,
        paymentsReady: true,
        ready: true,
      },
    });

    const tenant = await platformDb.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    expect(tenant.status).toBe('live');

    const audits = await platformDb.auditLog.findMany({ where: { tenantId, action: 'tenant.launch' } });
    expect(audits.length).toBe(1);

    // Idempotent: launching an already-live tenant just confirms the status,
    // with no checklist recompute and no duplicate audit row.
    const second = await launch(cookie);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ status: 'live' });

    const auditsAfterSecond = await platformDb.auditLog.findMany({ where: { tenantId, action: 'tenant.launch' } });
    expect(auditsAfterSecond.length).toBe(1);
  });

  it('403 FORBIDDEN_ROLE when staff tries to launch', async () => {
    const { cookie } = await signUpWithTenant('launch-staff@demo.co', 'staff');

    const res = await launch(cookie);

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'FORBIDDEN_ROLE' });
  });
});

describe('suspended tenant semantics', () => {
  it('allows GET but rejects mutations with 403 TENANT_SUSPENDED', async () => {
    const { cookie, tenantId } = await signUpWithTenant('launch-suspended@demo.co', 'owner');
    await platformDb.tenant.update({ where: { id: tenantId }, data: { status: 'suspended' } });

    const getProducts = await request(app.getHttpServer()).get('/v1/admin/products').set('cookie', cookie);
    expect(getProducts.status).toBe(200);

    const postProduct = await request(app.getHttpServer())
      .post('/v1/admin/products')
      .set('cookie', cookie)
      .send({ name: 'Bloqueado', priceCents: 1000 });
    expect(postProduct.status).toBe(403);
    expect(postProduct.body).toEqual({ error: 'TENANT_SUSPENDED' });

    const getSettings = await request(app.getHttpServer()).get('/v1/admin/settings').set('cookie', cookie);
    expect(getSettings.status).toBe(200);

    const patchSettings = await request(app.getHttpServer())
      .patch('/v1/admin/settings/store')
      .set('cookie', cookie)
      .send({ name: 'Nuevo Nombre' });
    expect(patchSettings.status).toBe(403);
    expect(patchSettings.body).toEqual({ error: 'TENANT_SUSPENDED' });
  });
});
