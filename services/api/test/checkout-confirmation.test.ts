import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateOrderReference } from '@ventia/core';
import request from 'supertest';
import Redis from 'ioredis';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient as PrismaClientType } from '@ventia/db';
import { startTestDb } from './helpers';

const CONFIRMATION_TEST_DOMAINS = [
  'confirm-a.ventia.localhost',
  'confirm-b.ventia.localhost',
];

let db: Awaited<ReturnType<typeof startTestDb>>;
let prisma: PrismaClientType;
let app: INestApplication;

// tenantId fixtures, populated in beforeAll.
let tenantAId: string;
let tenantBId: string;

const TENANT_A_ADDRESS = {
  nombreCompleto: 'Ana Ejemplo',
  telefono: '3001234567',
  departamentoCode: '11',
  municipioName: 'Bogotá, D.C.',
  direccion: 'Calle 1 # 2-34',
  complemento: 'Apto 501',
  barrio: 'Chapinero',
  notas: 'Tocar el timbre dos veces',
};

// Different departamento so tenant A's and tenant B's expected departamento
// names can never accidentally match each other in an assertion.
const TENANT_B_ADDRESS = {
  nombreCompleto: 'Beto Ejemplo',
  telefono: '3009998877',
  departamentoCode: '05', // Antioquia
  municipioName: 'Medellín',
  direccion: 'Carrera 50 # 10-20',
};

beforeAll(async () => {
  db = await startTestDb();
  process.env.DATABASE_URL = db.url;
  process.env.REDIS_URL = 'redis://localhost:6379';

  // DomainResolver caches resolved tenants by domain in the shared dev Redis
  // for 60s (see checkout.test.ts's identical comment) — flush this file's
  // fixed domains up front so a stale entry from a previous local run can't
  // point at a tenantId that doesn't exist in this run's fresh Postgres
  // container.
  const cacheBuster = new Redis(process.env.REDIS_URL);
  await cacheBuster.del(...CONFIRMATION_TEST_DOMAINS.map((d) => `tenant:domain:${d}`));
  await cacheBuster.quit();

  const { PrismaClient } = (await import('@ventia/db')) as { PrismaClient: typeof PrismaClientType };
  prisma = new PrismaClient({ datasources: { db: { url: db.url } } });

  const tenantA = await prisma.tenant.create({
    data: { slug: 'confirm-a', name: 'Confirm A', status: 'live' },
  });
  tenantAId = tenantA.id;
  await prisma.tenantDomain.create({
    data: { tenantId: tenantAId, domain: 'confirm-a.ventia.localhost', isPrimary: true },
  });

  const tenantB = await prisma.tenant.create({
    data: { slug: 'confirm-b', name: 'Confirm B', status: 'live' },
  });
  tenantBId = tenantB.id;
  await prisma.tenantDomain.create({
    data: { tenantId: tenantBId, domain: 'confirm-b.ventia.localhost', isPrimary: true },
  });

  // Order rows are seeded directly via Prisma — this endpoint doesn't care
  // how an order was created, so driving a real checkout through the full
  // cart/shipping/payment flow just to get an Order row would be needless
  // overhead for what this file is actually testing.
  //
  // Tenant A and tenant B both get an order numbered `1` — the SAME number,
  // on purpose: this is the fixture the cross-tenant isolation test below
  // depends on.
  const orderA = await prisma.order.create({
    data: {
      tenantId: tenantAId,
      number: 1,
      reference: generateOrderReference(),
      status: 'PENDING',
      paymentStatus: 'COD',
      email: 'ana@example.com',
      phone: TENANT_A_ADDRESS.telefono,
      shippingAddress: TENANT_A_ADDRESS,
      shippingMethod: 'flat-1',
      shippingCents: 12000,
      subtotalCents: 91800,
      taxCents: 14657,
      totalCents: 118457,
      source: 'web',
    },
  });
  await prisma.orderItem.createMany({
    data: [
      {
        tenantId: tenantAId,
        orderId: orderA.id,
        nameSnapshot: 'Camiseta',
        priceCentsSnapshot: 45900,
        qty: 2,
        taxRateSnapshot: 'NINETEEN',
      },
      {
        tenantId: tenantAId,
        orderId: orderA.id,
        nameSnapshot: 'Gorra',
        priceCentsSnapshot: 20000,
        qty: 1,
        taxRateSnapshot: 'NINETEEN',
      },
    ],
  });

  const orderB = await prisma.order.create({
    data: {
      tenantId: tenantBId,
      number: 1, // colliding with orderA's number on purpose
      // ...but NOT colliding on `reference`, which is globally unique. That is
      // the point of the column: the number may repeat across tenants, the
      // gateway-facing reference never does.
      reference: generateOrderReference(),
      status: 'PENDING',
      paymentStatus: 'COD',
      email: 'beto@example.com',
      phone: TENANT_B_ADDRESS.telefono,
      shippingAddress: TENANT_B_ADDRESS,
      shippingMethod: 'flat-1',
      shippingCents: 8000,
      subtotalCents: 30000,
      taxCents: 4790,
      totalCents: 42790,
      source: 'web',
    },
  });
  await prisma.orderItem.create({
    data: {
      tenantId: tenantBId,
      orderId: orderB.id,
      nameSnapshot: 'Pantalón',
      priceCentsSnapshot: 30000,
      qty: 1,
      taxRateSnapshot: 'NINETEEN',
    },
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

describe('GET /v1/storefront/checkout/confirmacion/:orderNumber — happy path', () => {
  it('returns the narrow confirmation DTO for a real order', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/storefront/checkout/confirmacion/1')
      .set('x-tenant-domain', 'confirm-a.ventia.localhost');

    expect(res.status).toBe(200);
    expect(res.body.orderNumber).toBe(1);
    expect(res.body.totalCents).toBe(118457);
    expect(typeof res.body.createdAt).toBe('string');
    expect(new Date(res.body.createdAt).toString()).not.toBe('Invalid Date');
    expect(res.body.shippingCiudad).toBe('Bogotá, D.C.');
    expect(res.body.shippingDepartamento).toBe('Bogotá, D.C.');

    expect(res.body.items).toHaveLength(2);
    expect(res.body.items).toEqual(
      expect.arrayContaining([
        { nameSnapshot: 'Camiseta', qty: 2, priceCentsSnapshot: 45900 },
        { nameSnapshot: 'Gorra', qty: 1, priceCentsSnapshot: 20000 },
      ]),
    );
  });
});

describe('GET /v1/storefront/checkout/confirmacion/:orderNumber — not found', () => {
  it('404s with ORDER_NOT_FOUND for a nonexistent order number', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/storefront/checkout/confirmacion/999999')
      .set('x-tenant-domain', 'confirm-a.ventia.localhost');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('ORDER_NOT_FOUND');
  });

  it('404s with ORDER_NOT_FOUND for a non-numeric order number param (parses to NaN, rejected by the controller\'s own guard before ever reaching Prisma — a bare NaN where-clause value throws PrismaClientValidationError rather than matching no row)', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/storefront/checkout/confirmacion/not-a-number')
      .set('x-tenant-domain', 'confirm-a.ventia.localhost');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('ORDER_NOT_FOUND');
  });
});

describe('GET /v1/storefront/checkout/confirmacion/:orderNumber — cross-tenant isolation', () => {
  it('the SAME order number on two different tenants never leaks the other tenant\'s order', async () => {
    const resA = await request(app.getHttpServer())
      .get('/v1/storefront/checkout/confirmacion/1')
      .set('x-tenant-domain', 'confirm-a.ventia.localhost');
    const resB = await request(app.getHttpServer())
      .get('/v1/storefront/checkout/confirmacion/1')
      .set('x-tenant-domain', 'confirm-b.ventia.localhost');

    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);

    // Both resolve order #1, but to their OWN tenant's order — never to each
    // other's. Tenant A's fixture totals/items/departamento are all distinct
    // from tenant B's specifically so any cross-contamination is impossible
    // to miss.
    expect(resA.body.totalCents).toBe(118457);
    expect(resB.body.totalCents).toBe(42790);

    expect(resA.body.shippingCiudad).toBe('Bogotá, D.C.');
    expect(resB.body.shippingCiudad).toBe('Medellín');
    expect(resA.body.shippingDepartamento).toBe('Bogotá, D.C.');
    expect(resB.body.shippingDepartamento).toBe('Antioquia');

    expect(resA.body.items).toHaveLength(2);
    expect(resB.body.items).toHaveLength(1);
    expect(resB.body.items[0]).toEqual({ nameSnapshot: 'Pantalón', qty: 1, priceCentsSnapshot: 30000 });

    // Neither tenant's response contains so much as a trace of the other
    // tenant's order content (name snapshot cross-check, on top of the
    // count/total checks above).
    expect(JSON.stringify(resA.body)).not.toContain('Pantalón');
    expect(JSON.stringify(resB.body)).not.toContain('Camiseta');
    expect(JSON.stringify(resB.body)).not.toContain('Gorra');
  });
});

describe('GET /v1/storefront/checkout/confirmacion/:orderNumber — DTO never leaks sensitive fields', () => {
  it('the response object itself has no direccion/complemento/barrio/telefono/email keys', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/storefront/checkout/confirmacion/1')
      .set('x-tenant-domain', 'confirm-a.ventia.localhost');

    expect(res.status).toBe(200);

    const keys = Object.keys(res.body);
    expect(keys).not.toContain('direccion');
    expect(keys).not.toContain('complemento');
    expect(keys).not.toContain('barrio');
    expect(keys).not.toContain('telefono');
    expect(keys).not.toContain('email');
    expect(keys).not.toContain('shippingAddress');
    expect(keys).not.toContain('phone');

    expect(res.body.direccion).toBeUndefined();
    expect(res.body.complemento).toBeUndefined();
    expect(res.body.barrio).toBeUndefined();
    expect(res.body.telefono).toBeUndefined();
    expect(res.body.email).toBeUndefined();

    // The DTO's full expected key set — exactly this, nothing extra.
    expect(new Set(keys)).toEqual(
      new Set(['orderNumber', 'totalCents', 'createdAt', 'items', 'shippingCiudad', 'shippingDepartamento']),
    );
  });
});

describe('GET /v1/storefront/checkout/confirmacion/:orderNumber — FIX 6: int4 upper bound', () => {
  // Verified live before the fix: `/confirmacion/99999999999` returned a 500.
  // `Order.number` is a Postgres `int4`, and Prisma REJECTS an out-of-range
  // value for an `Int` filter by THROWING — exactly like the `NaN` the
  // neighbouring guard was written for, in exactly the same place. Wave 1 put
  // this same bound on the webhook route's reference parse; these two
  // storefront routes were the ones it did not reach.
  it.each(['99999999999', '2147483648', '9007199254740993'])(
    '404s (not 500) for the out-of-int4-range order number %s',
    async (orderNumber) => {
      const res = await request(app.getHttpServer())
        .get(`/v1/storefront/checkout/confirmacion/${orderNumber}`)
        .set('x-tenant-domain', 'confirm-a.ventia.localhost');

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('ORDER_NOT_FOUND');
    },
  );

  it('still accepts the largest in-range value (the bound is inclusive, not off by one)', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/storefront/checkout/confirmacion/2147483647')
      .set('x-tenant-domain', 'confirm-a.ventia.localhost');

    // No such order exists, so still a 404 — but it reached Prisma and came
    // back cleanly rather than being rejected by the guard.
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('ORDER_NOT_FOUND');
  });
});

describe('GET /v1/storefront/checkout/confirmacion/:orderNumber — the parse is STRICT, not coercing', () => {
  // `parseOrderNumberParam` used `parseInt`, which stops at the first
  // non-digit and returns whatever prefix it managed to read: `/confirmacion/1abc`
  // returned a 200 carrying order 1's data. Harmless in isolation (the route is
  // read-only and the response is the same order the shopper could have asked
  // for by its plain number), but it is exactly the coercion class wave 1
  // deliberately rejected on the webhook route with `/^\d+$/` — where one order
  // reachable under several spellings meant an idempotency key that saw them as
  // distinct events. The two guards now agree.
  it.each([
    '1abc',
    // Percent-encoded rather than a literal trailing space: superagent trims a
    // trailing space off the URL string before sending, so a literal one never
    // reaches the route at all. `%20` arrives decoded as `'1 '`, which is the
    // spelling `Number('1 ')`/`parseInt('1 ', 10)` would both have folded onto
    // order 1.
    '1%20',
    ' 1',
    '+1',
    '1.0',
    '1e0',
    '0x1',
    '1,000',
    '1%00',
  ])('404s (never 200 with another order\'s data) for the non-plain-digits param %j', async (orderNumber) => {
    const res = await request(app.getHttpServer())
      .get(`/v1/storefront/checkout/confirmacion/${orderNumber}`)
      .set('x-tenant-domain', 'confirm-a.ventia.localhost');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('ORDER_NOT_FOUND');
  });

  it('a plain-digits param still resolves the order (the strictness costs nothing real)', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/storefront/checkout/confirmacion/1')
      .set('x-tenant-domain', 'confirm-a.ventia.localhost');

    expect(res.status).toBe(200);
    expect(res.body.orderNumber).toBe(1);
  });
});
