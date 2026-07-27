import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import Redis from 'ioredis';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient as PrismaClientType } from '@ventia/db';
import { startTestDb } from './helpers';
import type { ShippingService as ShippingServiceType } from '../src/checkout/shipping.service';

const QUOTE_TEST_DOMAINS = [
  'quote-flat.ventia.localhost',
  'quote-zone.ventia.localhost',
  'quote-disabled.ventia.localhost',
  'quote-unset.ventia.localhost',
  'quote-free-over.ventia.localhost',
];

let db: Awaited<ReturnType<typeof startTestDb>>;
let prisma: PrismaClientType;
let app: INestApplication;
let ShippingService: typeof ShippingServiceType;

// tenantId -> domain fixtures, populated in beforeAll.
let flatTenantId: string;
let zoneTenantId: string;
let disabledTenantId: string;
let unsetTenantId: string;
let freeOverTenantId: string;

beforeAll(async () => {
  db = await startTestDb();
  process.env.DATABASE_URL = db.url;
  process.env.REDIS_URL = 'redis://localhost:6379';

  // DomainResolver caches resolved tenants by domain in the shared dev Redis
  // for 60s (see cart.test.ts's identical comment) — flush this file's fixed
  // domains up front so a stale entry from a previous local run can't point
  // at a tenantId that doesn't exist in this run's fresh Postgres container.
  const cacheBuster = new Redis(process.env.REDIS_URL);
  await cacheBuster.del(...QUOTE_TEST_DOMAINS.map((d) => `tenant:domain:${d}`));
  await cacheBuster.quit();

  const { PrismaClient } = (await import('@ventia/db')) as { PrismaClient: typeof PrismaClientType };
  prisma = new PrismaClient({ datasources: { db: { url: db.url } } });

  const flatTenant = await prisma.tenant.create({
    data: {
      slug: 'quote-flat',
      name: 'Quote Flat',
      status: 'live',
      settings: {
        shipping: {
          methods: [{ id: 'flat-1', type: 'flat', label: 'Envío estándar', priceCents: 12000, enabled: true }],
        },
      },
    },
  });
  flatTenantId = flatTenant.id;
  await prisma.tenantDomain.create({
    data: { tenantId: flatTenantId, domain: 'quote-flat.ventia.localhost', isPrimary: true },
  });

  const zoneTenant = await prisma.tenant.create({
    data: {
      slug: 'quote-zone',
      name: 'Quote Zone',
      status: 'live',
      settings: {
        shipping: {
          methods: [
            {
              id: 'zone-1',
              type: 'zone',
              label: 'Envío por zona',
              // '11' (Bogotá) has a specific rate; no defaultPriceCents, so a
              // departamento not listed here (e.g. '91' Amazonas) has NO rate
              // at all — the "neither specific nor default" case.
              ratesByDepartamento: { '11': 8000 },
              enabled: true,
            },
          ],
          codRestrictedDepartamentos: ['91'],
        },
      },
    },
  });
  zoneTenantId = zoneTenant.id;
  await prisma.tenantDomain.create({
    data: { tenantId: zoneTenantId, domain: 'quote-zone.ventia.localhost', isPrimary: true },
  });

  const disabledTenant = await prisma.tenant.create({
    data: {
      slug: 'quote-disabled',
      name: 'Quote Disabled',
      status: 'live',
      settings: {
        shipping: {
          methods: [
            { id: 'flat-off', type: 'flat', label: 'Deshabilitado', priceCents: 5000, enabled: false },
            { id: 'pickup-on', type: 'pickup', label: 'Recoger en tienda', enabled: true },
          ],
        },
      },
    },
  });
  disabledTenantId = disabledTenant.id;
  await prisma.tenantDomain.create({
    data: { tenantId: disabledTenantId, domain: 'quote-disabled.ventia.localhost', isPrimary: true },
  });

  // settings.shipping entirely unset (settings is null) — must yield [] from
  // quote, not a crash.
  const unsetTenant = await prisma.tenant.create({
    data: { slug: 'quote-unset', name: 'Quote Unset', status: 'live' },
  });
  unsetTenantId = unsetTenant.id;
  await prisma.tenantDomain.create({
    data: { tenantId: unsetTenantId, domain: 'quote-unset.ventia.localhost', isPrimary: true },
  });

  // quote() can't know the real cart subtotal at this stage, so a free_over
  // method shows fallbackPriceCents as a placeholder — see the dedicated
  // quote() test below for the exact assertion this fixture backs.
  const freeOverTenant = await prisma.tenant.create({
    data: {
      slug: 'quote-free-over',
      name: 'Quote Free Over',
      status: 'live',
      settings: {
        shipping: {
          methods: [
            {
              id: 'free-over-1',
              type: 'free_over',
              label: 'Envío gratis desde $100.000',
              thresholdCents: 10_000_00,
              fallbackPriceCents: 15000,
              enabled: true,
            },
          ],
        },
      },
    },
  });
  freeOverTenantId = freeOverTenant.id;
  await prisma.tenantDomain.create({
    data: { tenantId: freeOverTenantId, domain: 'quote-free-over.ventia.localhost', isPrimary: true },
  });

  const { createApp } = await import('../src/main');
  app = await createApp();
  await app.init();

  ({ ShippingService } = await import('../src/checkout/shipping.service'));
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
  await db.stop();
});

describe('GET /v1/storefront/checkout/shipping-quote', () => {
  it('a flat method returns its fixed price for any departamento', async () => {
    for (const departamento of ['11', '05', '91']) {
      const res = await request(app.getHttpServer())
        .get('/v1/storefront/checkout/shipping-quote')
        .query({ departamento })
        .set('x-tenant-domain', 'quote-flat.ventia.localhost');
      expect(res.status).toBe(200);
      expect(res.body).toEqual([{ id: 'flat-1', type: 'flat', label: 'Envío estándar', priceCents: 12000 }]);
    }
  });

  it('a zone method returns the configured rate for a departamento that has one', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/storefront/checkout/shipping-quote')
      .query({ departamento: '11' })
      .set('x-tenant-domain', 'quote-zone.ventia.localhost');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: 'zone-1', type: 'zone', label: 'Envío por zona', priceCents: 8000 }]);
  });

  it('omits (not a 500) a zone method with neither a specific rate nor a defaultPriceCents for this departamento', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/storefront/checkout/shipping-quote')
      .query({ departamento: '91' }) // Amazonas: no rate, no default configured
      .set('x-tenant-domain', 'quote-zone.ventia.localhost');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('disabled methods never appear in results; enabled pickup appears at priceCents 0', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/storefront/checkout/shipping-quote')
      .query({ departamento: '11' })
      .set('x-tenant-domain', 'quote-disabled.ventia.localhost');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: 'pickup-on', type: 'pickup', label: 'Recoger en tienda', priceCents: 0 }]);
  });

  it('a tenant with settings.shipping entirely unset returns [] (not a crash)', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/storefront/checkout/shipping-quote')
      .query({ departamento: '11' })
      .set('x-tenant-domain', 'quote-unset.ventia.localhost');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('a free_over method shows fallbackPriceCents as a placeholder (quote cannot know the real cart subtotal)', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/storefront/checkout/shipping-quote')
      .query({ departamento: '11' })
      .set('x-tenant-domain', 'quote-free-over.ventia.localhost');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { id: 'free-over-1', type: 'free_over', label: 'Envío gratis desde $100.000', priceCents: 15000 },
    ]);
  });

  it('400 VALIDATION_FAILED when departamento is missing or not a real DANE code', async () => {
    const missing = await request(app.getHttpServer())
      .get('/v1/storefront/checkout/shipping-quote')
      .set('x-tenant-domain', 'quote-flat.ventia.localhost');
    expect(missing.status).toBe(400);
    expect(missing.body.error).toBe('VALIDATION_FAILED');

    const bogus = await request(app.getHttpServer())
      .get('/v1/storefront/checkout/shipping-quote')
      .query({ departamento: 'ZZ' })
      .set('x-tenant-domain', 'quote-flat.ventia.localhost');
    expect(bogus.status).toBe(400);
    expect(bogus.body.error).toBe('VALIDATION_FAILED');
  });
});

describe('ShippingService.priceFor (called directly — quote cannot know cart subtotal)', () => {
  it('a free_over method returns 0 at/above threshold and fallbackPriceCents below it', async () => {
    const tenant = await prisma.tenant.create({
      data: {
        slug: 'priceFor-free-over',
        name: 'PriceFor Free Over',
        status: 'live',
        settings: {
          shipping: {
            methods: [
              {
                id: 'free-1',
                type: 'free_over',
                label: 'Gratis sobre umbral',
                thresholdCents: 100000,
                fallbackPriceCents: 9500,
                enabled: true,
              },
            ],
          },
        },
      },
    });

    const service = new ShippingService();
    await expect(service.priceFor(tenant.id, 'free-1', '11', 150000)).resolves.toBe(0);
    await expect(service.priceFor(tenant.id, 'free-1', '11', 100000)).resolves.toBe(0); // >= threshold
    await expect(service.priceFor(tenant.id, 'free-1', '11', 50000)).resolves.toBe(9500);
  });

  it('throws SHIPPING_METHOD_UNAVAILABLE for a zone method with no rate and no default for this departamento', async () => {
    const service = new ShippingService();
    await expect(service.priceFor(zoneTenantId, 'zone-1', '91', 30000)).rejects.toMatchObject({
      response: { error: 'SHIPPING_METHOD_UNAVAILABLE' },
      status: 400,
    });
  });

  it('throws SHIPPING_METHOD_UNAVAILABLE for an unknown/disabled methodId', async () => {
    const service = new ShippingService();
    await expect(service.priceFor(flatTenantId, 'does-not-exist', '11', 30000)).rejects.toMatchObject({
      response: { error: 'SHIPPING_METHOD_UNAVAILABLE' },
      status: 400,
    });
    await expect(service.priceFor(disabledTenantId, 'flat-off', '11', 30000)).rejects.toMatchObject({
      response: { error: 'SHIPPING_METHOD_UNAVAILABLE' },
      status: 400,
    });
  });
});

describe('ShippingService.isCodAllowed', () => {
  it('returns true when codRestrictedDepartamentos is unset', async () => {
    const service = new ShippingService();
    await expect(service.isCodAllowed(flatTenantId, '91')).resolves.toBe(true);
  });

  it('gates on membership when codRestrictedDepartamentos is set', async () => {
    const service = new ShippingService();
    // zoneTenantId has codRestrictedDepartamentos: ['91']
    await expect(service.isCodAllowed(zoneTenantId, '91')).resolves.toBe(false);
    await expect(service.isCodAllowed(zoneTenantId, '11')).resolves.toBe(true);
  });
});
