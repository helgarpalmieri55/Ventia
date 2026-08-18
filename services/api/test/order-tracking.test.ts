import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateOrderReference } from '@ventia/core';
import request from 'supertest';
import Redis from 'ioredis';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient as PrismaClientType } from '@ventia/db';
import { startTestDb } from './helpers';
import type { signUpWithTenant as SignUpWithTenant } from './admin-helpers';

const TRACK_TEST_DOMAINS = ['track-a.ventia.localhost', 'track-b.ventia.localhost'];

let db: Awaited<ReturnType<typeof startTestDb>>;
let prisma: PrismaClientType;
let app: INestApplication;
let signUpWithTenant: typeof SignUpWithTenant;

// tenantId fixtures, populated in beforeAll.
let tenantAId: string;
let tenantAAdminCookie: string;
let tenantBId: string;

const PROGRESSIVE_ADDRESS = {
  nombreCompleto: 'Progresiva Ejemplo',
  telefono: '3000000002',
  departamentoCode: '11',
  municipioName: 'Bogotá, D.C.',
  direccion: 'Calle 1 # 2-34',
};

beforeAll(async () => {
  db = await startTestDb();
  process.env.DATABASE_URL = db.url;
  // Shared dev Redis already running via docker compose (see docker/compose.yaml)
  // — same pattern as test/checkout-confirmation.test.ts, rather than spinning
  // up a dedicated testcontainer just for this file's admin-session needs.
  process.env.REDIS_URL = 'redis://localhost:6379';

  // DomainResolver caches resolved tenants by domain in that same shared Redis
  // for 60s (see checkout-confirmation.test.ts's identical comment) — flush
  // this file's fixed domains up front so a stale entry from a previous local
  // run can't point at a tenantId that doesn't exist in this run's fresh
  // Postgres container.
  const cacheBuster = new Redis(process.env.REDIS_URL);
  await cacheBuster.del(...TRACK_TEST_DOMAINS.map((d) => `tenant:domain:${d}`));
  await cacheBuster.quit();

  const { createApp } = await import('../src/main');
  app = await createApp();
  await app.init();

  ({ signUpWithTenant } = await import('./admin-helpers'));
  ({ platformDb: prisma } = (await import('@ventia/db')) as unknown as { platformDb: PrismaClientType });

  // Two tenants, each with an admin session (for driving real transitions
  // through Task 1's admin endpoints as test setup) AND a storefront domain
  // (for hitting this task's new PUBLIC tracking endpoint unauthenticated).
  ({ cookie: tenantAAdminCookie, tenantId: tenantAId } = await signUpWithTenant('track-a-owner@demo.co', 'owner'));
  await prisma.tenantDomain.create({ data: { tenantId: tenantAId, domain: 'track-a.ventia.localhost', isPrimary: true } });

  ({ tenantId: tenantBId } = await signUpWithTenant('track-b-owner@demo.co', 'owner'));
  await prisma.tenantDomain.create({ data: { tenantId: tenantBId, domain: 'track-b.ventia.localhost', isPrimary: true } });
}, 120_000);

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
  await db.stop();
});

/** Seeds one Product directly via Prisma so an order's items can carry a
 * real productId (needed for the `confirm` transition's stock decrement). */
async function seedProduct(tenantId: string, stock: number) {
  return prisma.product.create({
    data: {
      tenantId,
      name: 'Producto de prueba',
      slug: `producto-track-${Math.random().toString(36).slice(2)}`,
      priceCents: 20_000,
      status: 'active',
      stock,
    },
  });
}

/** Seeds one PENDING Order + its single OrderItem directly via Prisma —
 * same "seed directly, don't drive a full checkout" call this task's brief
 * explicitly leaves up to this file's own judgment, matching
 * orders-transitions.test.ts's identical seedOrder helper. */
async function seedOrder(
  tenantId: string,
  number: number,
  email: string,
  phone: string,
  productId: string,
  shippingAddress: Record<string, unknown> = {},
): Promise<{ id: string; number: number }> {
  const order = await prisma.order.create({
    data: {
      tenantId,
      number,
      reference: generateOrderReference(),
      status: 'PENDING',
      paymentStatus: 'COD',
      email,
      phone,
      shippingAddress,
      subtotalCents: 20_000,
      taxCents: 3_800,
      totalCents: 23_800,
    },
  });
  await prisma.orderItem.create({
    data: {
      tenantId,
      orderId: order.id,
      productId,
      nameSnapshot: 'Producto de prueba',
      priceCentsSnapshot: 20_000,
      qty: 1,
      taxRateSnapshot: 'NINETEEN',
    },
  });
  return { id: order.id, number: order.number };
}

describe('GET /v1/storefront/orders/track — happy path (matching contact)', () => {
  it('exact order number + matching email returns 200 with the full DTO shape', async () => {
    const product = await seedProduct(tenantAId, 50);
    const order = await seedOrder(tenantAId, 101, 'happy-email@example.com', '3001110001', product.id, PROGRESSIVE_ADDRESS);

    const res = await request(app.getHttpServer())
      .get('/v1/storefront/orders/track')
      .query({ orderNumber: order.number, contact: 'happy-email@example.com' })
      .set('x-tenant-domain', 'track-a.ventia.localhost');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      orderNumber: 101,
      status: 'PENDING',
      totalCents: 23_800,
      shippingCiudad: 'Bogotá, D.C.',
      shippingDepartamento: 'Bogotá, D.C.',
      shipment: null,
    });
    expect(typeof res.body.createdAt).toBe('string');
    expect(new Date(res.body.createdAt).toString()).not.toBe('Invalid Date');
    expect(res.body.items).toEqual([{ nameSnapshot: 'Producto de prueba', qty: 1, priceCentsSnapshot: 20_000 }]);
    expect(res.body.events).toEqual([]);

    // Exactly the DTO's declared key set, nothing extra leaking through.
    expect(new Set(Object.keys(res.body))).toEqual(
      new Set([
        'orderNumber',
        'status',
        'createdAt',
        'items',
        'totalCents',
        'shippingCiudad',
        'shippingDepartamento',
        'shipment',
        'events',
      ]),
    );
  });

  it('exact order number + matching phone returns 200', async () => {
    const product = await seedProduct(tenantAId, 50);
    const order = await seedOrder(tenantAId, 102, 'phone-owner@example.com', '3001110002', product.id);

    const res = await request(app.getHttpServer())
      .get('/v1/storefront/orders/track')
      .query({ orderNumber: order.number, contact: '3001110002' })
      .set('x-tenant-domain', 'track-a.ventia.localhost');

    expect(res.status).toBe(200);
    expect(res.body.orderNumber).toBe(102);
  });
});

describe('GET /v1/storefront/orders/track — no side-channel between wrong contact and nonexistent order', () => {
  it('matching order number + WRONG contact, and a nonexistent order number, both 404 ORDER_NOT_FOUND, byte-identically', async () => {
    const product = await seedProduct(tenantAId, 50);
    const order = await seedOrder(tenantAId, 103, 'real-owner@example.com', '3001110003', product.id);

    const wrongContactRes = await request(app.getHttpServer())
      .get('/v1/storefront/orders/track')
      .query({ orderNumber: order.number, contact: 'attacker@example.com' })
      .set('x-tenant-domain', 'track-a.ventia.localhost');

    const nonexistentRes = await request(app.getHttpServer())
      .get('/v1/storefront/orders/track')
      .query({ orderNumber: 999_999, contact: 'attacker@example.com' })
      .set('x-tenant-domain', 'track-a.ventia.localhost');

    expect(wrongContactRes.status).toBe(404);
    expect(wrongContactRes.body).toEqual({ error: 'ORDER_NOT_FOUND' });
    expect(nonexistentRes.status).toBe(404);
    expect(nonexistentRes.body).toEqual({ error: 'ORDER_NOT_FOUND' });

    // The actual no-side-channel proof: not just "each is a 404 with this
    // shape" (asserted independently above) but that the two RESPONSES are
    // themselves indistinguishable — same status, byte-identical body — so
    // an attacker holding a real order number + wrong contact gets a
    // response no different from one guessing a nonexistent order number.
    expect(wrongContactRes.status).toBe(nonexistentRes.status);
    expect(JSON.stringify(wrongContactRes.body)).toBe(JSON.stringify(nonexistentRes.body));
  });
});

describe('GET /v1/storefront/orders/track — malformed input', () => {
  it('a non-numeric orderNumber param 404s with ORDER_NOT_FOUND, not 500 or 400 (the NaN-rejected-by-Prisma gotcha)', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/storefront/orders/track')
      .query({ orderNumber: 'abc', contact: 'whoever@example.com' })
      .set('x-tenant-domain', 'track-a.ventia.localhost');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'ORDER_NOT_FOUND' });
  });

  it('a missing contact param 400s with VALIDATION_FAILED', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/storefront/orders/track')
      .query({ orderNumber: 101 })
      .set('x-tenant-domain', 'track-a.ventia.localhost');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_FAILED');
  });

  it('an empty-string contact param also 400s with VALIDATION_FAILED', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/storefront/orders/track')
      .query({ orderNumber: 101, contact: '' })
      .set('x-tenant-domain', 'track-a.ventia.localhost');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_FAILED');
  });
});

describe('GET /v1/storefront/orders/track — shipment + events reflect real admin transitions', () => {
  it('shipment is null before shipping, then carries the carrier/tracking number after the shipped transition; events accumulate in chronological order', async () => {
    const product = await seedProduct(tenantAId, 50);
    const order = await seedOrder(
      tenantAId,
      104,
      'progressive@example.com',
      '3000000002',
      product.id,
      PROGRESSIVE_ADDRESS,
    );

    // Before any transition: no events yet, no shipment yet.
    const beforeRes = await request(app.getHttpServer())
      .get('/v1/storefront/orders/track')
      .query({ orderNumber: order.number, contact: 'progressive@example.com' })
      .set('x-tenant-domain', 'track-a.ventia.localhost');
    expect(beforeRes.status).toBe(200);
    expect(beforeRes.body.status).toBe('PENDING');
    expect(beforeRes.body.shipment).toBeNull();
    expect(beforeRes.body.events).toEqual([]);

    // Drive the order through confirm -> preparing -> shipped via the REAL
    // Task 1 admin HTTP endpoints (not by writing OrderStatus/OrderEvent rows
    // directly), so this test actually exercises the same code path a
    // shopper's tracking page depends on.
    const confirmRes = await request(app.getHttpServer())
      .patch(`/v1/admin/orders/${order.id}/confirm`)
      .set('cookie', tenantAAdminCookie);
    expect(confirmRes.status).toBe(200);

    const preparingRes = await request(app.getHttpServer())
      .patch(`/v1/admin/orders/${order.id}/preparing`)
      .set('cookie', tenantAAdminCookie);
    expect(preparingRes.status).toBe(200);

    const afterTwoRes = await request(app.getHttpServer())
      .get('/v1/storefront/orders/track')
      .query({ orderNumber: order.number, contact: 'progressive@example.com' })
      .set('x-tenant-domain', 'track-a.ventia.localhost');
    expect(afterTwoRes.status).toBe(200);
    expect(afterTwoRes.body.status).toBe('PREPARING');
    expect(afterTwoRes.body.shipment).toBeNull();
    expect(afterTwoRes.body.events).toHaveLength(2);
    // Chronological order: each event's createdAt is >= the previous one's.
    const timestamps = (afterTwoRes.body.events as Array<{ createdAt: string }>).map((e) => new Date(e.createdAt).getTime());
    expect(timestamps[1]).toBeGreaterThanOrEqual(timestamps[0]!);
    for (const event of afterTwoRes.body.events) {
      expect(Object.keys(event).sort()).toEqual(['createdAt', 'type']);
    }

    const shippedRes = await request(app.getHttpServer())
      .patch(`/v1/admin/orders/${order.id}/shipped`)
      .set('cookie', tenantAAdminCookie)
      .send({ carrier: 'Servientrega', trackingNumber: 'TRK-77889900' });
    expect(shippedRes.status).toBe(200);

    const afterShippedRes = await request(app.getHttpServer())
      .get('/v1/storefront/orders/track')
      .query({ orderNumber: order.number, contact: 'progressive@example.com' })
      .set('x-tenant-domain', 'track-a.ventia.localhost');
    expect(afterShippedRes.status).toBe(200);
    expect(afterShippedRes.body.status).toBe('SHIPPED');
    expect(afterShippedRes.body.shipment).toEqual({ carrier: 'Servientrega', trackingNumber: 'TRK-77889900' });
    expect(afterShippedRes.body.events).toHaveLength(3);
    const allTimestamps = (afterShippedRes.body.events as Array<{ createdAt: string }>).map((e) =>
      new Date(e.createdAt).getTime(),
    );
    expect(allTimestamps[1]).toBeGreaterThanOrEqual(allTimestamps[0]!);
    expect(allTimestamps[2]).toBeGreaterThanOrEqual(allTimestamps[1]!);
  });
});

describe('GET /v1/storefront/orders/track — cross-tenant isolation', () => {
  it('the SAME order number on two different tenants never leaks the other tenant\'s order', async () => {
    const productA = await seedProduct(tenantAId, 50);
    const productB = await seedProduct(tenantBId, 50);

    // Colliding order number, on purpose — this is the fixture the
    // isolation assertions below depend on.
    const orderA = await seedOrder(tenantAId, 200, 'cross-a@example.com', '3002220001', productA.id);
    const orderB = await seedOrder(tenantBId, 200, 'cross-b@example.com', '3002220002', productB.id);
    expect(orderA.number).toBe(orderB.number);

    // Querying tenant A's domain with tenant A's own contact resolves A's order.
    const resA = await request(app.getHttpServer())
      .get('/v1/storefront/orders/track')
      .query({ orderNumber: 200, contact: 'cross-a@example.com' })
      .set('x-tenant-domain', 'track-a.ventia.localhost');
    expect(resA.status).toBe(200);
    expect(resA.body.orderNumber).toBe(200);

    // Querying tenant A's domain with tenant B's contact must NOT leak tenant
    // B's order (tenant B's row lives under a different tenantId, so the
    // tenantId-scoped `where` clause never matches it) — same 404 as any
    // other wrong-contact case.
    const resWrongTenantContact = await request(app.getHttpServer())
      .get('/v1/storefront/orders/track')
      .query({ orderNumber: 200, contact: 'cross-b@example.com' })
      .set('x-tenant-domain', 'track-a.ventia.localhost');
    expect(resWrongTenantContact.status).toBe(404);
    expect(resWrongTenantContact.body).toEqual({ error: 'ORDER_NOT_FOUND' });

    // Querying tenant B's domain with tenant B's own contact resolves B's
    // order — the SAME order number, but a totally different Order row.
    const resB = await request(app.getHttpServer())
      .get('/v1/storefront/orders/track')
      .query({ orderNumber: 200, contact: 'cross-b@example.com' })
      .set('x-tenant-domain', 'track-b.ventia.localhost');
    expect(resB.status).toBe(200);
    expect(resB.body.orderNumber).toBe(200);

    // Neither tenant's response contains so much as a trace of the other
    // tenant's contact info.
    expect(JSON.stringify(resA.body)).not.toContain('cross-b@example.com');
    expect(JSON.stringify(resB.body)).not.toContain('cross-a@example.com');
  });
});
