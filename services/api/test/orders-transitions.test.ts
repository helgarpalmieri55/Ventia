import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient as PrismaClientType, OrderStatus } from '@ventia/db';
import { startTestDb } from './helpers';
import type { signUpWithTenant as SignUpWithTenant } from './admin-helpers';
import { ACTION_TARGET_STATUS, ALLOWED_ACTIONS, type OrderAction } from '../src/orders/transitions';

let db: Awaited<ReturnType<typeof startTestDb>>;
let redisContainer: StartedTestContainer;
let app: INestApplication;
let signUpWithTenant: typeof SignUpWithTenant;
let prisma: PrismaClientType;

const ALL_ACTIONS: OrderAction[] = ['confirm', 'preparing', 'shipped', 'delivered', 'cancel'];

/** Every action's body, for actions that need one (`shipped`/`cancel`) — used
 * across many tests below so each call site doesn't have to re-derive it. */
function bodyFor(action: OrderAction): Record<string, string> | undefined {
  if (action === 'shipped') return { carrier: 'Servientrega', trackingNumber: 'TRK-0001' };
  if (action === 'cancel') return { reason: 'Solicitud del cliente' };
  return undefined;
}

beforeAll(async () => {
  db = await startTestDb();
  redisContainer = await new GenericContainer('redis:7-alpine')
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
    .start();

  // Env vars must be set BEFORE the first import (static or dynamic) of
  // @ventia/db, ../src/main, or ./admin-helpers — same pattern as
  // products.test.ts / variants-images-stock.test.ts.
  process.env.DATABASE_URL = db.url;
  process.env.REDIS_URL = `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`;

  const { createApp } = await import('../src/main');
  app = await createApp();
  await app.init();

  ({ signUpWithTenant } = await import('./admin-helpers'));
  ({ platformDb: prisma } = (await import('@ventia/db')) as unknown as { platformDb: PrismaClientType });
}, 120_000);

afterAll(async () => {
  await app.close();
  await redisContainer.stop();
  await db.stop();
});

let orderNumberSeq = 1;

/** Seeds one Product directly via Prisma (bypassing the HTTP layer, so
 * `stock` can be set to an exact, known value). */
async function seedProduct(tenantId: string, stock: number) {
  return prisma.product.create({
    data: {
      tenantId,
      name: 'Producto de prueba',
      slug: `producto-prueba-${randomUUID()}`,
      priceCents: 10_000,
      status: 'active',
      stock,
    },
  });
}

/** Seeds one Order + its OrderItems directly via Prisma at a given status —
 * this test file needs orders parked at arbitrary statuses (PREPARING,
 * SHIPPED, ...) that the HTTP API itself has no way to reach without first
 * walking the whole state machine, so seeding directly is the only way to
 * exercise "confirm on an order already at CONFIRMED" etc. in isolation. */
async function seedOrder(
  tenantId: string,
  status: OrderStatus,
  items: Array<{ productId: string; qty: number }>,
): Promise<string> {
  const order = await prisma.order.create({
    data: {
      tenantId,
      number: orderNumberSeq++,
      status,
      paymentStatus: 'COD',
      email: 'comprador@example.com',
      phone: '3000000000',
      shippingAddress: {},
      subtotalCents: 0,
      taxCents: 0,
      totalCents: 0,
    },
  });
  for (const item of items) {
    await prisma.orderItem.create({
      data: {
        tenantId,
        orderId: order.id,
        productId: item.productId,
        nameSnapshot: 'Item de prueba',
        priceCentsSnapshot: 10_000,
        qty: item.qty,
        taxRateSnapshot: 'NINETEEN',
      },
    });
  }
  return order.id;
}

describe('order status transitions — allowed edges', () => {
  it('every allowed action in ALLOWED_ACTIONS succeeds once from its valid `from` status', async () => {
    const { cookie, tenantId } = await signUpWithTenant('orders-happy@demo.co', 'owner');
    const product = await seedProduct(tenantId, 1000);

    for (const [status, actions] of Object.entries(ALLOWED_ACTIONS) as Array<[OrderStatus, OrderAction[]]>) {
      for (const action of actions) {
        const orderId = await seedOrder(tenantId, status, [{ productId: product.id, qty: 1 }]);
        const res = await request(app.getHttpServer())
          .patch(`/v1/admin/orders/${orderId}/${action}`)
          .set('cookie', cookie)
          .send(bodyFor(action));
        expect(res.status, `${status} -> ${action} should succeed`).toBe(200);
        expect(res.body.status).toBe(ACTION_TARGET_STATUS[action]);
      }
    }
  });

  it('allows the staff role to transition orders too (operational work, not owner-only)', async () => {
    const { cookie, tenantId } = await signUpWithTenant('orders-staff@demo.co', 'staff');
    const product = await seedProduct(tenantId, 10);
    const orderId = await seedOrder(tenantId, 'PENDING', [{ productId: product.id, qty: 1 }]);

    const res = await request(app.getHttpServer())
      .patch(`/v1/admin/orders/${orderId}/confirm`)
      .set('cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('CONFIRMED');
  });
});

describe('order status transitions — disallowed edges', () => {
  it('every action NOT listed for a status returns 409 INVALID_TRANSITION, leaving the order untouched', async () => {
    const { cookie, tenantId } = await signUpWithTenant('orders-invalid@demo.co', 'owner');
    const product = await seedProduct(tenantId, 1000);

    for (const [status, actions] of Object.entries(ALLOWED_ACTIONS) as Array<[OrderStatus, OrderAction[]]>) {
      const disallowed = ALL_ACTIONS.filter((a) => !actions.includes(a));
      for (const action of disallowed) {
        const orderId = await seedOrder(tenantId, status, [{ productId: product.id, qty: 1 }]);
        const res = await request(app.getHttpServer())
          .patch(`/v1/admin/orders/${orderId}/${action}`)
          .set('cookie', cookie)
          .send(bodyFor(action));
        expect(res.status, `${status} -> ${action} should be rejected`).toBe(409);
        expect(res.body).toMatchObject({ error: 'INVALID_TRANSITION', details: { from: status, action } });

        const stillSameStatus = await prisma.order.findUnique({ where: { id: orderId } });
        expect(stillSameStatus?.status).toBe(status);
      }
    }
  });
});

describe('confirm — stock decrement', () => {
  it('decrements stock by exactly the ordered qty (verified via a direct DB read)', async () => {
    const { cookie, tenantId } = await signUpWithTenant('orders-confirm-stock@demo.co', 'owner');
    const product = await seedProduct(tenantId, 10);
    const orderId = await seedOrder(tenantId, 'PENDING', [{ productId: product.id, qty: 3 }]);

    const res = await request(app.getHttpServer())
      .patch(`/v1/admin/orders/${orderId}/confirm`)
      .set('cookie', cookie);
    expect(res.status).toBe(200);

    const updated = await prisma.product.findUnique({ where: { id: product.id } });
    expect(updated?.stock).toBe(7);

    const movements = await prisma.inventoryMovement.findMany({ where: { orderId } });
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({
      productId: product.id,
      delta: -3,
      reason: 'order_confirmed',
      orderId,
    });
    expect(typeof movements[0]!.actor).toBe('string');
    expect(movements[0]!.actor.length).toBeGreaterThan(0);
  });

  it('confirming twice: the second attempt is 409 INVALID_TRANSITION and does NOT double-decrement stock', async () => {
    const { cookie, tenantId } = await signUpWithTenant('orders-confirm-twice@demo.co', 'owner');
    const product = await seedProduct(tenantId, 10);
    const orderId = await seedOrder(tenantId, 'PENDING', [{ productId: product.id, qty: 2 }]);

    const first = await request(app.getHttpServer())
      .patch(`/v1/admin/orders/${orderId}/confirm`)
      .set('cookie', cookie);
    expect(first.status).toBe(200);

    const afterFirst = await prisma.product.findUnique({ where: { id: product.id } });
    expect(afterFirst?.stock).toBe(8);

    const second = await request(app.getHttpServer())
      .patch(`/v1/admin/orders/${orderId}/confirm`)
      .set('cookie', cookie);
    expect(second.status).toBe(409);
    expect(second.body.error).toBe('INVALID_TRANSITION');

    const afterSecond = await prisma.product.findUnique({ where: { id: product.id } });
    expect(afterSecond?.stock).toBe(8);

    const movements = await prisma.inventoryMovement.count({ where: { orderId } });
    expect(movements).toBe(1);
  });

  it('a 2-line order where only the SECOND line lacks enough stock: 422 STOCK_BELOW_ZERO, and the FIRST line is unchanged (whole transaction rolls back)', async () => {
    const { cookie, tenantId } = await signUpWithTenant('orders-partial-rollback@demo.co', 'owner');
    const productOk = await seedProduct(tenantId, 10);
    const productShort = await seedProduct(tenantId, 1); // only 1 in stock
    const orderId = await seedOrder(tenantId, 'PENDING', [
      { productId: productOk.id, qty: 2 },
      { productId: productShort.id, qty: 5 }, // would go negative
    ]);

    const res = await request(app.getHttpServer())
      .patch(`/v1/admin/orders/${orderId}/confirm`)
      .set('cookie', cookie);
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ error: 'STOCK_BELOW_ZERO', details: { productId: productShort.id } });

    const okAfter = await prisma.product.findUnique({ where: { id: productOk.id } });
    expect(okAfter?.stock).toBe(10); // UNCHANGED — proves the first line's decrement rolled back too

    const shortAfter = await prisma.product.findUnique({ where: { id: productShort.id } });
    expect(shortAfter?.stock).toBe(1);

    const orderAfter = await prisma.order.findUnique({ where: { id: orderId } });
    expect(orderAfter?.status).toBe('PENDING'); // the status write itself rolled back too

    const movements = await prisma.inventoryMovement.count({ where: { orderId } });
    expect(movements).toBe(0); // neither line's InventoryMovement survived
  });
});

describe('cancel — restock', () => {
  it.each(['CONFIRMED', 'PREPARING', 'SHIPPED'] as const)(
    'cancelling from %s restocks back to the pre-confirm level',
    async (status) => {
      const { cookie, tenantId } = await signUpWithTenant(`orders-cancel-restock-${status.toLowerCase()}@demo.co`, 'owner');
      const product = await seedProduct(tenantId, 10);
      const orderId = await seedOrder(tenantId, status, [{ productId: product.id, qty: 4 }]);
      // This test seeds the order directly at `status` (skipping the actual
      // confirm call), so it must simulate the earlier decrement itself —
      // set stock to what it would already be post-confirm (10 - 4 = 6).
      await prisma.product.update({ where: { id: product.id }, data: { stock: 6 } });

      const res = await request(app.getHttpServer())
        .patch(`/v1/admin/orders/${orderId}/cancel`)
        .set('cookie', cookie)
        .send({ reason: 'Cliente canceló' });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('CANCELLED');

      const updated = await prisma.product.findUnique({ where: { id: product.id } });
      expect(updated?.stock).toBe(10);

      const movements = await prisma.inventoryMovement.findMany({ where: { orderId } });
      expect(movements).toHaveLength(1);
      expect(movements[0]).toMatchObject({ productId: product.id, delta: 4, reason: 'order_cancelled' });
    },
  );

  it('cancelling from PENDING does NOT touch stock at all (nothing was ever decremented)', async () => {
    const { cookie, tenantId } = await signUpWithTenant('orders-cancel-pending@demo.co', 'owner');
    const product = await seedProduct(tenantId, 10);
    const orderId = await seedOrder(tenantId, 'PENDING', [{ productId: product.id, qty: 3 }]);

    const res = await request(app.getHttpServer())
      .patch(`/v1/admin/orders/${orderId}/cancel`)
      .set('cookie', cookie)
      .send({ reason: 'Cliente canceló antes de confirmar' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('CANCELLED');

    const updated = await prisma.product.findUnique({ where: { id: product.id } });
    expect(updated?.stock).toBe(10);

    const movements = await prisma.inventoryMovement.count({ where: { orderId } });
    expect(movements).toBe(0);
  });
});

describe('shipped — carrier/trackingNumber validation', () => {
  it('missing carrier and/or trackingNumber returns 400 VALIDATION_FAILED, order untouched', async () => {
    const { cookie, tenantId } = await signUpWithTenant('orders-shipped-validation@demo.co', 'owner');
    const product = await seedProduct(tenantId, 10);
    const orderId = await seedOrder(tenantId, 'PREPARING', [{ productId: product.id, qty: 1 }]);

    const missingBoth = await request(app.getHttpServer())
      .patch(`/v1/admin/orders/${orderId}/shipped`)
      .set('cookie', cookie)
      .send({});
    expect(missingBoth.status).toBe(400);
    expect(missingBoth.body.error).toBe('VALIDATION_FAILED');
    expect(missingBoth.body.details).toHaveProperty('carrier');
    expect(missingBoth.body.details).toHaveProperty('trackingNumber');

    const missingTracking = await request(app.getHttpServer())
      .patch(`/v1/admin/orders/${orderId}/shipped`)
      .set('cookie', cookie)
      .send({ carrier: 'Servientrega' });
    expect(missingTracking.status).toBe(400);
    expect(missingTracking.body.details).toHaveProperty('trackingNumber');
    expect(missingTracking.body.details).not.toHaveProperty('carrier');

    const orderAfter = await prisma.order.findUnique({ where: { id: orderId } });
    expect(orderAfter?.status).toBe('PREPARING');

    const shipments = await prisma.shipment.count({ where: { orderId } });
    expect(shipments).toBe(0);
  });

  it('valid carrier + trackingNumber creates one Shipment row and moves the order to SHIPPED', async () => {
    const { cookie, tenantId } = await signUpWithTenant('orders-shipped-happy@demo.co', 'owner');
    const product = await seedProduct(tenantId, 10);
    const orderId = await seedOrder(tenantId, 'PREPARING', [{ productId: product.id, qty: 1 }]);

    const res = await request(app.getHttpServer())
      .patch(`/v1/admin/orders/${orderId}/shipped`)
      .set('cookie', cookie)
      .send({ carrier: 'Coordinadora', trackingNumber: 'TRK-9999' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('SHIPPED');

    const shipment = await prisma.shipment.findFirst({ where: { orderId } });
    expect(shipment).toMatchObject({ provider: 'Coordinadora', trackingNumber: 'TRK-9999', status: 'shipped' });
  });
});

describe('cancel — reason validation', () => {
  it('missing or empty reason returns 400 VALIDATION_FAILED, order untouched', async () => {
    const { cookie, tenantId } = await signUpWithTenant('orders-cancel-validation@demo.co', 'owner');
    const product = await seedProduct(tenantId, 10);
    const orderId = await seedOrder(tenantId, 'PENDING', [{ productId: product.id, qty: 1 }]);

    const missing = await request(app.getHttpServer())
      .patch(`/v1/admin/orders/${orderId}/cancel`)
      .set('cookie', cookie)
      .send({});
    expect(missing.status).toBe(400);
    expect(missing.body.error).toBe('VALIDATION_FAILED');

    const empty = await request(app.getHttpServer())
      .patch(`/v1/admin/orders/${orderId}/cancel`)
      .set('cookie', cookie)
      .send({ reason: '   ' });
    expect(empty.status).toBe(400);
    expect(empty.body.error).toBe('VALIDATION_FAILED');

    const orderAfter = await prisma.order.findUnique({ where: { id: orderId } });
    expect(orderAfter?.status).toBe('PENDING');
  });
});

describe('cross-tenant isolation', () => {
  it('a cross-tenant order id 404s ORDER_NOT_FOUND on every action, never mutating the other tenant order', async () => {
    const tenantA = await signUpWithTenant('orders-cross-a@demo.co', 'owner');
    const tenantB = await signUpWithTenant('orders-cross-b@demo.co', 'owner');
    const productA = await seedProduct(tenantA.tenantId, 10);
    const orderId = await seedOrder(tenantA.tenantId, 'PENDING', [{ productId: productA.id, qty: 1 }]);

    for (const action of ALL_ACTIONS) {
      const res = await request(app.getHttpServer())
        .patch(`/v1/admin/orders/${orderId}/${action}`)
        .set('cookie', tenantB.cookie)
        .send(bodyFor(action));
      expect(res.status, `${action} on another tenant's order should 404`).toBe(404);
      expect(res.body).toEqual({ error: 'ORDER_NOT_FOUND' });
    }

    const stillPending = await prisma.order.findUnique({ where: { id: orderId } });
    expect(stillPending?.status).toBe('PENDING');

    const stockUnchanged = await prisma.product.findUnique({ where: { id: productA.id } });
    expect(stockUnchanged?.stock).toBe(10);
  });

  it('GET /:id 404s ORDER_NOT_FOUND for a cross-tenant order id', async () => {
    const tenantA = await signUpWithTenant('orders-cross-get-a@demo.co', 'owner');
    const tenantB = await signUpWithTenant('orders-cross-get-b@demo.co', 'owner');
    const productA = await seedProduct(tenantA.tenantId, 10);
    const orderId = await seedOrder(tenantA.tenantId, 'PENDING', [{ productId: productA.id, qty: 1 }]);

    const res = await request(app.getHttpServer())
      .get(`/v1/admin/orders/${orderId}`)
      .set('cookie', tenantB.cookie);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'ORDER_NOT_FOUND' });
  });

  it('rejects a malformed uuid path param with a typed 404 (not a Prisma P2023 500)', async () => {
    const { cookie } = await signUpWithTenant('orders-bad-uuid@demo.co', 'owner');

    const res = await request(app.getHttpServer())
      .get('/v1/admin/orders/not-a-uuid')
      .set('cookie', cookie);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'NOT_FOUND' });
  });
});

describe('GET /v1/admin/orders — list', () => {
  it('paginates with the same clamping as ProductsService (page<1 -> 1, pageSize>100 -> 100, non-numeric -> defaults)', async () => {
    const { cookie, tenantId } = await signUpWithTenant('orders-list-pagination@demo.co', 'owner');
    const product = await seedProduct(tenantId, 100);
    for (let i = 0; i < 3; i++) {
      await seedOrder(tenantId, 'PENDING', [{ productId: product.id, qty: 1 }]);
    }

    const page1 = await request(app.getHttpServer())
      .get('/v1/admin/orders?pageSize=2&page=1')
      .set('cookie', cookie);
    expect(page1.status).toBe(200);
    expect(page1.body.total).toBe(3);
    expect(page1.body.page).toBe(1);
    expect(page1.body.pageSize).toBe(2);
    expect(page1.body.items).toHaveLength(2);

    const page2 = await request(app.getHttpServer())
      .get('/v1/admin/orders?pageSize=2&page=2')
      .set('cookie', cookie);
    expect(page2.body.total).toBe(3);
    expect(page2.body.items).toHaveLength(1);

    const defaultList = await request(app.getHttpServer())
      .get('/v1/admin/orders')
      .set('cookie', cookie);
    expect(defaultList.body.pageSize).toBe(20);

    // pageSize is clamped to 100, not rejected
    const clamped = await request(app.getHttpServer())
      .get('/v1/admin/orders?pageSize=500')
      .set('cookie', cookie);
    expect(clamped.status).toBe(200);
    expect(clamped.body.pageSize).toBe(100);

    // page < 1 clamps to 1 rather than erroring
    const negativePage = await request(app.getHttpServer())
      .get('/v1/admin/orders?page=-5')
      .set('cookie', cookie);
    expect(negativePage.status).toBe(200);
    expect(negativePage.body.page).toBe(1);

    // non-numeric page/pageSize fall back to defaults
    const garbageParams = await request(app.getHttpServer())
      .get('/v1/admin/orders?page=abc&pageSize=xyz')
      .set('cookie', cookie);
    expect(garbageParams.status).toBe(200);
    expect(garbageParams.body.page).toBe(1);
    expect(garbageParams.body.pageSize).toBe(20);
  });

  it('filters by status; an invalid/garbage status value is silently ignored (matches ProductsService.list() established behavior)', async () => {
    const { cookie, tenantId } = await signUpWithTenant('orders-list-status@demo.co', 'owner');
    const product = await seedProduct(tenantId, 100);
    await seedOrder(tenantId, 'PENDING', [{ productId: product.id, qty: 1 }]);
    await seedOrder(tenantId, 'CONFIRMED', [{ productId: product.id, qty: 1 }]);
    await seedOrder(tenantId, 'CONFIRMED', [{ productId: product.id, qty: 1 }]);

    const byStatus = await request(app.getHttpServer())
      .get('/v1/admin/orders?status=CONFIRMED')
      .set('cookie', cookie);
    expect(byStatus.status).toBe(200);
    expect(byStatus.body.total).toBe(2);
    expect(byStatus.body.items.every((o: { status: string }) => o.status === 'CONFIRMED')).toBe(true);

    const garbage = await request(app.getHttpServer())
      .get('/v1/admin/orders?status=not-a-real-status')
      .set('cookie', cookie);
    expect(garbage.status).toBe(200);
    expect(garbage.body.total).toBe(3); // filter ignored -> all 3 orders returned
  });
});
