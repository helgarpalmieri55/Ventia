import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient as PrismaClientType } from '@ventia/db';
import { startTestDb } from './helpers';
import type { signUpAndGetCookie as SignUpAndGetCookie, signUpWithTenant as SignUpWithTenant } from './admin-helpers';

let db: Awaited<ReturnType<typeof startTestDb>>;
let redisContainer: StartedTestContainer;
let app: INestApplication;
let signUpAndGetCookie: typeof SignUpAndGetCookie;
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

  ({ signUpAndGetCookie, signUpWithTenant } = await import('./admin-helpers'));
  ({ platformDb } = await import('@ventia/db'));
}, 120_000);

afterAll(async () => {
  await app.close();
  await redisContainer.stop();
  await db.stop();
});

function provisionTenant(cookie: string, body: Record<string, unknown>) {
  return request(app.getHttpServer()).post('/v1/admin/onboarding/tenant').set('cookie', cookie).send(body);
}

describe('POST /v1/admin/onboarding/tenant', () => {
  it('401 without a session', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/admin/onboarding/tenant')
      .send({ storeName: 'Mi Tienda' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHENTICATED');
  });

  it('provisions a tenant end to end: Tenant, TenantLimits, TenantDomain, Membership, then /v1/admin/me works', async () => {
    const cookie = await signUpAndGetCookie('provision-happy@demo.co');

    const res = await provisionTenant(cookie, { storeName: 'Tienda Feliz' });

    expect(res.status).toBe(201);
    expect(res.body.role).toBe('owner');
    expect(res.body.tenant).toMatchObject({ slug: 'tienda-feliz', name: 'Tienda Feliz', status: 'draft' });
    const tenantId = res.body.tenant.tenantId as string;

    const tenant = await platformDb.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    expect(tenant).toMatchObject({ slug: 'tienda-feliz', name: 'Tienda Feliz', status: 'draft', plan: 'emprende' });

    const limits = await platformDb.tenantLimits.findUniqueOrThrow({ where: { tenantId } });
    // The Emprende limits, spelled out rather than compared against
    // `PLANS.emprende`: this asserts that signup writes the numbers the plan
    // page promises, and reading them from the same constant the code writes
    // would assert only that a variable equals itself.
    expect(limits).toMatchObject({
      productsMax: 300,
      aiCreditsMonth: 500,
      staffSeats: 1,
      customDomain: false,
      humanHandoff: false,
      // WhatsApp is in the entry plan: the product is sold as a salesperson on
      // WhatsApp, so gating it behind an upgrade sold something else.
      whatsappChannel: true,
      instagramChannel: false,
    });

    const domain = await platformDb.tenantDomain.findFirstOrThrow({ where: { tenantId } });
    expect(domain).toMatchObject({ domain: 'tienda-feliz.ventia.localhost', isPrimary: true });
    expect(domain.verifiedAt).toBeTruthy();

    const membership = await platformDb.membership.findFirstOrThrow({ where: { tenantId } });
    expect(membership.role).toBe('owner');

    const me = await request(app.getHttpServer()).get('/v1/admin/me').set('cookie', cookie);
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ tenantId, role: 'owner' });
  });

  it('409 ALREADY_HAS_TENANT for a session that already has a membership', async () => {
    const { cookie } = await signUpWithTenant('provision-already@demo.co', 'owner');

    const res = await provisionTenant(cookie, { storeName: 'Otra Tienda' });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'ALREADY_HAS_TENANT' });
  });

  it('409 ALREADY_HAS_TENANT for a platform_admin with no tenantId', async () => {
    const cookie = await signUpAndGetCookie('provision-platform-admin@demo.co');

    // Create a user via signup helper
    const user = await platformDb.user.findFirstOrThrow({
      where: { email: 'provision-platform-admin@demo.co' }
    });

    // Create a platform_admin membership (tenantId: null)
    await platformDb.membership.create({
      data: { userId: user.id, tenantId: null, role: 'platform_admin' },
    });

    // Attempt to provision should fail with 409
    const res = await provisionTenant(cookie, { storeName: 'Admin Tenant' });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'ALREADY_HAS_TENANT' });

    // Verify no tenant was created with this slug
    const tenantCount = await platformDb.tenant.count({ where: { slug: 'admin-tenant' } });
    expect(tenantCount).toBe(0);
  });

  it('dedups the slug across tenants: same storeName from two users gets x, then x-2', async () => {
    const cookieA = await signUpAndGetCookie('provision-dedup-a@demo.co');
    const cookieB = await signUpAndGetCookie('provision-dedup-b@demo.co');

    const resA = await provisionTenant(cookieA, { storeName: 'Tienda Duplicada' });
    const resB = await provisionTenant(cookieB, { storeName: 'Tienda Duplicada' });

    expect(resA.status).toBe(201);
    expect(resB.status).toBe(201);
    expect(resA.body.tenant.slug).toBe('tienda-duplicada');
    expect(resB.body.tenant.slug).toBe('tienda-duplicada-2');
  });

  it('400 VALIDATION_FAILED for an explicit reserved slug', async () => {
    const cookie = await signUpAndGetCookie('provision-reserved-slug@demo.co');

    const res = await provisionTenant(cookie, { storeName: 'Mi Tienda', slug: 'admin' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'VALIDATION_FAILED', details: { slug: 'slug reservado' } });
  });

  it('400 VALIDATION_FAILED for an explicit malformed slug (uppercase, dots)', async () => {
    const cookie = await signUpAndGetCookie('provision-malformed-slug@demo.co');

    const res = await provisionTenant(cookie, { storeName: 'Mi Tienda', slug: 'Mi.Tienda' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_FAILED');
  });

  it('a store named "Admin" auto-resolves its slug past the reserved word (admin -> admin-2)', async () => {
    const cookie = await signUpAndGetCookie('provision-auto-reserved@demo.co');

    const res = await provisionTenant(cookie, { storeName: 'Admin' });

    expect(res.status).toBe(201);
    expect(res.body.tenant.slug).not.toBe('admin');
    expect(res.body.tenant.slug).toBe('admin-2');

    const reservedCount = await platformDb.tenant.count({ where: { slug: 'admin' } });
    expect(reservedCount).toBe(0);
  });
});

describe('onboarding wizard state', () => {
  it('GET returns an empty steps object and a fully-false checklist for a brand new tenant', async () => {
    const { cookie } = await signUpWithTenant('wizard-fresh@demo.co', 'owner');

    const res = await request(app.getHttpServer()).get('/v1/admin/onboarding').set('cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body.steps).toEqual({});
    expect(res.body.checklist).toMatchObject({
      storeInfo: false,
      emailVerified: false,
      hasActiveProduct: false,
      paymentsReady: false,
      ready: false,
    });
  });

  it('staff cannot PATCH onboarding: 403 FORBIDDEN_ROLE', async () => {
    const { cookie } = await signUpWithTenant('wizard-staff@demo.co', 'staff');

    const res = await request(app.getHttpServer())
      .patch('/v1/admin/onboarding')
      .set('cookie', cookie)
      .send({ step: 'store_info', data: { contactEmail: 'a@b.co' } });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'FORBIDDEN_ROLE' });
  });

  it('400 VALIDATION_FAILED for an invalid contactEmail', async () => {
    const { cookie } = await signUpWithTenant('wizard-bad-email@demo.co', 'owner');

    const res = await request(app.getHttpServer())
      .patch('/v1/admin/onboarding')
      .set('cookie', cookie)
      .send({ step: 'store_info', data: { contactEmail: 'not-an-email' } });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_FAILED');
  });

  it('two PATCHes of different steps both persist, and store_info data lands in settings.storeInfo', async () => {
    const { cookie, tenantId } = await signUpWithTenant('wizard-two-steps@demo.co', 'owner');

    const storeInfoRes = await request(app.getHttpServer())
      .patch('/v1/admin/onboarding')
      .set('cookie', cookie)
      .send({ step: 'store_info', data: { contactEmail: 'owner@wizard-two-steps.co', category: 'moda' } });
    expect(storeInfoRes.status).toBe(200);

    const paymentsRes = await request(app.getHttpServer())
      .patch('/v1/admin/onboarding')
      .set('cookie', cookie)
      .send({ step: 'payments', data: { codEnabled: true } });
    expect(paymentsRes.status).toBe(200);

    const res = await request(app.getHttpServer()).get('/v1/admin/onboarding').set('cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.steps.store_info).toMatchObject({ done: true });
    expect(res.body.steps.payments).toMatchObject({ done: true });
    expect(res.body.steps.store_info.completedAt).toBeTruthy();

    const tenant = await platformDb.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    const settings = tenant.settings as Record<string, unknown>;
    expect(settings.storeInfo).toMatchObject({ contactEmail: 'owner@wizard-two-steps.co', category: 'moda' });
    expect(settings.payments).toMatchObject({ codEnabled: true });

    // audit row recorded for the mutation
    const audits = await platformDb.auditLog.findMany({ where: { tenantId, action: 'onboarding.step' } });
    expect(audits.length).toBe(2);
  });

  it('checklist flags flip live as fixtures change: storeInfo, hasActiveProduct, paymentsReady, emailVerified, ready', async () => {
    const { cookie, tenantId, userId } = await signUpWithTenant('wizard-checklist@demo.co', 'owner');

    const initial = await request(app.getHttpServer()).get('/v1/admin/onboarding').set('cookie', cookie);
    expect(initial.body.checklist).toMatchObject({
      storeInfo: false,
      emailVerified: false,
      hasActiveProduct: false,
      paymentsReady: false,
      ready: false,
    });

    await request(app.getHttpServer())
      .patch('/v1/admin/onboarding')
      .set('cookie', cookie)
      .send({ step: 'store_info', data: { contactEmail: 'checklist@demo.co' } });

    const afterStoreInfo = await request(app.getHttpServer()).get('/v1/admin/onboarding').set('cookie', cookie);
    expect(afterStoreInfo.body.checklist.storeInfo).toBe(true);
    expect(afterStoreInfo.body.checklist.ready).toBe(false);

    await platformDb.product.create({
      data: { tenantId, name: 'Producto Activo', slug: 'producto-activo', priceCents: 10_000, status: 'active' },
    });

    const afterProduct = await request(app.getHttpServer()).get('/v1/admin/onboarding').set('cookie', cookie);
    expect(afterProduct.body.checklist.hasActiveProduct).toBe(true);
    expect(afterProduct.body.checklist.ready).toBe(false);

    await request(app.getHttpServer())
      .patch('/v1/admin/onboarding')
      .set('cookie', cookie)
      .send({ step: 'payments', data: { codEnabled: true } });

    const afterPayments = await request(app.getHttpServer()).get('/v1/admin/onboarding').set('cookie', cookie);
    expect(afterPayments.body.checklist.paymentsReady).toBe(true);
    expect(afterPayments.body.checklist.ready).toBe(false);

    await platformDb.user.update({ where: { id: userId }, data: { emailVerified: true } });

    const finalRes = await request(app.getHttpServer()).get('/v1/admin/onboarding').set('cookie', cookie);
    expect(finalRes.body.checklist).toMatchObject({
      storeInfo: true,
      emailVerified: true,
      hasActiveProduct: true,
      paymentsReady: true,
      ready: true,
    });
  });
});
