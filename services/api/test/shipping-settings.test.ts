import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { startTestDb } from './helpers';
import type { signUpWithTenant as SignUpWithTenant } from './admin-helpers';

let db: Awaited<ReturnType<typeof startTestDb>>;
let app: INestApplication;
let signUpWithTenant: typeof SignUpWithTenant;

const validShipping = {
  methods: [
    { id: 'm1', type: 'flat', label: 'Envío estándar', priceCents: 12000, enabled: true },
    {
      id: 'm2',
      type: 'zone',
      label: 'Envío por zona',
      ratesByDepartamento: { '11': 8000 },
      defaultPriceCents: 15000,
      enabled: true,
    },
    { id: 'm3', type: 'pickup', label: 'Recoger en tienda', enabled: true },
  ],
  codRestrictedDepartamentos: ['91'],
};

beforeAll(async () => {
  db = await startTestDb();
  // Reuses the already-running dev Redis (docker/compose.yaml), same as
  // cart.test.ts — this file exercises admin/settings routes only, no cart
  // cookie flow, so a dedicated container per settings.test.ts isn't needed.
  process.env.DATABASE_URL = db.url;
  process.env.REDIS_URL = 'redis://localhost:6379';

  const { createApp } = await import('../src/main');
  app = await createApp();
  await app.init();

  ({ signUpWithTenant } = await import('./admin-helpers'));
}, 120_000);

afterAll(async () => {
  await app.close();
  await db.stop();
});

describe('PATCH /v1/admin/settings/shipping', () => {
  it('owner can replace settings.shipping wholesale and it round-trips via GET', async () => {
    const { cookie } = await signUpWithTenant('shipping-owner@demo.co', 'owner');

    const res = await request(app.getHttpServer())
      .patch('/v1/admin/settings/shipping')
      .set('cookie', cookie)
      .send(validShipping);
    expect(res.status).toBe(200);
    expect(res.body.shipping).toMatchObject(validShipping);

    const getRes = await request(app.getHttpServer()).get('/v1/admin/settings').set('cookie', cookie);
    expect(getRes.status).toBe(200);
    expect(getRes.body.shipping).toMatchObject(validShipping);
  });

  it('replaces wholesale: a second PATCH without a previously-set method drops it', async () => {
    const { cookie } = await signUpWithTenant('shipping-replace@demo.co', 'owner');

    const first = await request(app.getHttpServer())
      .patch('/v1/admin/settings/shipping')
      .set('cookie', cookie)
      .send(validShipping);
    expect(first.status).toBe(200);

    const onlyFlat = {
      methods: [{ id: 'm1', type: 'flat', label: 'Envío estándar', priceCents: 9000, enabled: true }],
    };
    const second = await request(app.getHttpServer())
      .patch('/v1/admin/settings/shipping')
      .set('cookie', cookie)
      .send(onlyFlat);
    expect(second.status).toBe(200);

    const getRes = await request(app.getHttpServer()).get('/v1/admin/settings').set('cookie', cookie);
    expect(getRes.body.shipping.methods).toHaveLength(1);
    expect(getRes.body.shipping.methods[0]).toMatchObject({ id: 'm1', priceCents: 9000 });
    expect(getRes.body.shipping.codRestrictedDepartamentos).toBeUndefined();
  });

  it('403 FORBIDDEN_ROLE for a staff session', async () => {
    const { cookie } = await signUpWithTenant('shipping-staff@demo.co', 'staff');

    const res = await request(app.getHttpServer())
      .patch('/v1/admin/settings/shipping')
      .set('cookie', cookie)
      .send(validShipping);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'FORBIDDEN_ROLE' });
  });

  it('400 VALIDATION_FAILED for a method missing its required label', async () => {
    const { cookie } = await signUpWithTenant('shipping-bad-shape@demo.co', 'owner');

    const res = await request(app.getHttpServer())
      .patch('/v1/admin/settings/shipping')
      .set('cookie', cookie)
      .send({ methods: [{ id: 'm1', type: 'flat', priceCents: 1000, enabled: true }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_FAILED');
  });
});
