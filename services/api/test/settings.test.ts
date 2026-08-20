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

const validTheme = {
  logoUrl: 'https://cdn.example.com/logo.png',
  colors: { primary: '#111111', background: '#ffffff', foreground: '#000000' },
  fontPair: 'inter-lora',
  radius: 'md',
};

beforeAll(async () => {
  db = await startTestDb();
  redisContainer = await new GenericContainer('redis:7-alpine')
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
    .start();

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

describe('GET /v1/admin/settings', () => {
  it('returns sensible empties for a brand new tenant', async () => {
    const { cookie } = await signUpWithTenant('settings-fresh@demo.co', 'owner');

    const res = await request(app.getHttpServer()).get('/v1/admin/settings').set('cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      name: 'settings-fresh@demo.co',
      slug: 'settings-fresh',
      status: 'live',
      storeInfo: {},
      theme: {},
      payments: { codEnabled: false },
    });
  });
});

describe('PATCH /v1/admin/settings/store', () => {
  it('updates Tenant.name and merges settings.storeInfo', async () => {
    const { cookie, tenantId } = await signUpWithTenant('settings-store-happy@demo.co', 'owner');

    const res = await request(app.getHttpServer())
      .patch('/v1/admin/settings/store')
      .set('cookie', cookie)
      .send({ name: 'Nueva Tienda', storeInfo: { category: 'ropa', contactEmail: 'owner@store-happy.co' } });

    expect(res.status).toBe(200);

    const getRes = await request(app.getHttpServer()).get('/v1/admin/settings').set('cookie', cookie);
    expect(getRes.body.name).toBe('Nueva Tienda');
    expect(getRes.body.storeInfo).toMatchObject({ category: 'ropa', contactEmail: 'owner@store-happy.co' });

    const tenant = await platformDb.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    expect(tenant.name).toBe('Nueva Tienda');
    const settings = tenant.settings as Record<string, unknown>;
    expect(settings.storeInfo).toMatchObject({ category: 'ropa', contactEmail: 'owner@store-happy.co' });

    const audits = await platformDb.auditLog.findMany({ where: { tenantId, action: 'settings.store' } });
    expect(audits.length).toBe(1);
  });

  it('merges storeInfo without clobbering onboarding keys already in settings', async () => {
    const { cookie, tenantId } = await signUpWithTenant('settings-store-merge@demo.co', 'owner');

    // Seed settings.onboarding + settings.storeInfo via the wizard first.
    const wizardRes = await request(app.getHttpServer())
      .patch('/v1/admin/onboarding')
      .set('cookie', cookie)
      .send({ step: 'store_info', data: { contactEmail: 'wizard@store-merge.co' } });
    expect(wizardRes.status).toBe(200);

    const res = await request(app.getHttpServer())
      .patch('/v1/admin/settings/store')
      .set('cookie', cookie)
      .send({ storeInfo: { category: 'hogar' } });
    expect(res.status).toBe(200);

    const tenant = await platformDb.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    const settings = tenant.settings as Record<string, unknown>;
    expect(settings.onboarding).toMatchObject({ store_info: { done: true } });
    expect(settings.storeInfo).toMatchObject({ contactEmail: 'wizard@store-merge.co', category: 'hogar' });
  });

  it('accepts the five identidad-legal fields the Ley 1581 policy generator reads, and lets them be cleared', async () => {
    const { cookie, tenantId } = await signUpWithTenant('settings-store-identidad@demo.co', 'owner');

    // The key names are load-bearing: `privacy-policy.service.ts` reads
    // exactly these five off `settings.storeInfo` (note `address`, not
    // `addressLine`), and a schema that accepted differently-named fields
    // would strip them silently and leave the generated policy full of
    // [COMPLETAR: ...] markers with nothing in the UI to explain why.
    const res = await request(app.getHttpServer())
      .patch('/v1/admin/settings/store')
      .set('cookie', cookie)
      .send({
        storeInfo: {
          legalName: 'Distribuidora del Café S.A.S.',
          taxId: 'NIT 901.234.567-8',
          address: 'Carrera 14 # 8-42, local 3',
          municipio: 'Armenia',
          departamento: 'Quindío',
        },
      });
    expect(res.status).toBe(200);

    const tenant = await platformDb.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    expect((tenant.settings as Record<string, unknown>).storeInfo).toMatchObject({
      legalName: 'Distribuidora del Café S.A.S.',
      taxId: 'NIT 901.234.567-8',
      address: 'Carrera 14 # 8-42, local 3',
      municipio: 'Armenia',
      departamento: 'Quindío',
    });

    // All five are plain max-length strings, so an empty one is valid and is
    // what the Tienda tab actually sends to clear a saved value — unlike
    // `contactEmail`, whose `.email()` rule makes it unclearable through this
    // endpoint (a pre-existing, documented gap).
    const cleared = await request(app.getHttpServer())
      .patch('/v1/admin/settings/store')
      .set('cookie', cookie)
      .send({ storeInfo: { legalName: '', taxId: '', address: '', municipio: '', departamento: '' } });
    expect(cleared.status).toBe(200);
    expect(cleared.body.storeInfo).toMatchObject({ legalName: '', taxId: '', municipio: '' });
  });

  it('400 VALIDATION_FAILED for a legalName over its max length, and leaves an existing store untouched', async () => {
    const { cookie } = await signUpWithTenant('settings-store-identidad-long@demo.co', 'owner');
    const res = await request(app.getHttpServer())
      .patch('/v1/admin/settings/store')
      .set('cookie', cookie)
      .send({ storeInfo: { legalName: 'A'.repeat(121) } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_FAILED');
  });

  it('a store that never sets the identidad-legal fields still saves normally', async () => {
    // The "must not break an existing store" rule, stated as a test: all five
    // are optional, so a PATCH that has never heard of them is unaffected.
    const { cookie } = await signUpWithTenant('settings-store-identidad-absent@demo.co', 'owner');
    const res = await request(app.getHttpServer())
      .patch('/v1/admin/settings/store')
      .set('cookie', cookie)
      .send({ name: 'Tienda Sin Identidad', storeInfo: { category: 'moda' } });
    expect(res.status).toBe(200);
    expect(res.body.storeInfo).toMatchObject({ category: 'moda' });
    expect(res.body.storeInfo.legalName).toBeUndefined();
  });

  it('400 VALIDATION_FAILED for an invalid contactEmail', async () => {
    const { cookie } = await signUpWithTenant('settings-store-bad-email@demo.co', 'owner');

    const res = await request(app.getHttpServer())
      .patch('/v1/admin/settings/store')
      .set('cookie', cookie)
      .send({ storeInfo: { contactEmail: 'not-an-email' } });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_FAILED');
  });
});

describe('PUT /v1/admin/settings/theme', () => {
  it('replaces tenants.theme wholesale, dropping keys absent from a later PUT', async () => {
    const { cookie, tenantId } = await signUpWithTenant('settings-theme-replace@demo.co', 'owner');

    const first = await request(app.getHttpServer())
      .put('/v1/admin/settings/theme')
      .set('cookie', cookie)
      .send(validTheme);
    expect(first.status).toBe(200);

    const afterFirst = await request(app.getHttpServer()).get('/v1/admin/settings').set('cookie', cookie);
    expect(afterFirst.body.theme).toMatchObject({ logoUrl: validTheme.logoUrl, fontPair: 'inter-lora' });

    const audits1 = await platformDb.auditLog.findMany({ where: { tenantId, action: 'settings.theme' } });
    expect(audits1.length).toBe(1);

    const withoutLogo = {
      colors: validTheme.colors,
      fontPair: validTheme.fontPair,
      radius: validTheme.radius,
    };
    const second = await request(app.getHttpServer())
      .put('/v1/admin/settings/theme')
      .set('cookie', cookie)
      .send(withoutLogo);
    expect(second.status).toBe(200);

    const afterSecond = await request(app.getHttpServer()).get('/v1/admin/settings').set('cookie', cookie);
    expect(afterSecond.body.theme.logoUrl).toBeUndefined();
    expect(afterSecond.body.theme).toMatchObject({ fontPair: 'inter-lora', radius: 'md' });

    const tenant = await platformDb.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    expect(tenant.theme).toEqual(withoutLogo);
  });

  it('400 VALIDATION_FAILED for an invalid hex color', async () => {
    const { cookie } = await signUpWithTenant('settings-theme-bad-hex@demo.co', 'owner');

    const res = await request(app.getHttpServer())
      .put('/v1/admin/settings/theme')
      .set('cookie', cookie)
      .send({ ...validTheme, colors: { ...validTheme.colors, primary: '#12345g' } });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_FAILED');
  });

  it('400 VALIDATION_FAILED for an unknown fontPair', async () => {
    const { cookie } = await signUpWithTenant('settings-theme-bad-font@demo.co', 'owner');

    const res = await request(app.getHttpServer())
      .put('/v1/admin/settings/theme')
      .set('cookie', cookie)
      .send({ ...validTheme, fontPair: 'comic-sans-only' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_FAILED');
  });
});

describe('PATCH /v1/admin/settings/payments', () => {
  it('merges settings.payments', async () => {
    const { cookie, tenantId } = await signUpWithTenant('settings-payments-happy@demo.co', 'owner');

    const res = await request(app.getHttpServer())
      .patch('/v1/admin/settings/payments')
      .set('cookie', cookie)
      .send({ codEnabled: true });
    expect(res.status).toBe(200);

    const getRes = await request(app.getHttpServer()).get('/v1/admin/settings').set('cookie', cookie);
    // Not `toEqual` any more: P3a Task 3 widened `payments` with a masked
    // `providers.wompi` view (see settings.controller.ts's `toResponse`)
    // alongside the pre-existing `codEnabled` — this test only cares about
    // `codEnabled` here, so `toMatchObject` deliberately ignores the new key.
    expect(getRes.body.payments).toMatchObject({ codEnabled: true });

    const tenant = await platformDb.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    const settings = tenant.settings as Record<string, unknown>;
    expect(settings.payments).toMatchObject({ codEnabled: true });

    const audits = await platformDb.auditLog.findMany({ where: { tenantId, action: 'settings.payments' } });
    expect(audits.length).toBe(1);
  });
});

describe('staff cannot reach settings (M8 acceptance criterion)', () => {
  it('403 FORBIDDEN_ROLE on all four settings routes', async () => {
    const { cookie } = await signUpWithTenant('settings-staff@demo.co', 'staff');

    const probes: Array<() => request.Test> = [
      () => request(app.getHttpServer()).get('/v1/admin/settings').set('cookie', cookie),
      () =>
        request(app.getHttpServer()).patch('/v1/admin/settings/store').set('cookie', cookie).send({ name: 'Nope' }),
      () => request(app.getHttpServer()).put('/v1/admin/settings/theme').set('cookie', cookie).send(validTheme),
      () =>
        request(app.getHttpServer())
          .patch('/v1/admin/settings/payments')
          .set('cookie', cookie)
          .send({ codEnabled: true }),
    ];

    for (const probe of probes) {
      const res = await probe();
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'FORBIDDEN_ROLE' });
    }
  });
});
