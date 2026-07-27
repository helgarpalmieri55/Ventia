import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient as PrismaClientType, OrderStatus } from '@ventia/db';
import { startTestDb } from './helpers';
import type { signUpWithTenant as SignUpWithTenant } from './admin-helpers';
import { ACTION_TARGET_STATUS, ALLOWED_ACTIONS, type OrderAction } from '../src/orders/transitions';
import { MAILER, type Mailer, type MailMessage } from '../src/mailer/mailer';

let db: Awaited<ReturnType<typeof startTestDb>>;
let redisContainer: StartedTestContainer;
let app: INestApplication;
let signUpWithTenant: typeof SignUpWithTenant;
let prisma: PrismaClientType;
let sentMail: MailMessage[];

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

  // RESEND_API_KEY is unset in this test environment, so MailerModule's
  // factory (see src/mailer/mailer.module.ts) wires MAILER to a ConsoleMailer
  // instance — spying on its `send` method captures every email
  // OrdersService.transition's fire-and-forget sendOrder*Email(...) calls
  // send, same recording-double-via-spy pattern as test/checkout.test.ts.
  sentMail = [];
  const mailer = app.get<Mailer>(MAILER);
  vi.spyOn(mailer, 'send').mockImplementation(async (msg) => {
    sentMail.push(msg);
  });
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

  it('a product with trackInventory=false and stock=0 (the schema default) still confirms — untracked stock is never gated on, matching checkout.service.ts\'s own trackInventory check', async () => {
    const { cookie, tenantId } = await signUpWithTenant('orders-untracked-confirm@demo.co', 'owner');
    // A merchant who disabled inventory tracking has no reason to ever set
    // `stock` away from its schema default (0) — checkout.service.ts already
    // treats trackInventory=false as "don't gate on stock at all" (see its
    // `if (product.trackInventory && stock < item.qty)` check), so the
    // confirm-time decrement must honor the identical flag rather than
    // unconditionally applying a floor check against a stock count the
    // merchant never intended to track.
    const product = await prisma.product.create({
      data: {
        tenantId,
        name: 'Producto sin inventario',
        slug: `producto-sin-inventario-${randomUUID()}`,
        priceCents: 10_000,
        status: 'active',
        stock: 0,
        trackInventory: false,
      },
    });
    const orderId = await seedOrder(tenantId, 'PENDING', [{ productId: product.id, qty: 5 }]);

    const res = await request(app.getHttpServer())
      .patch(`/v1/admin/orders/${orderId}/confirm`)
      .set('cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('CONFIRMED');

    // stock stays untouched — never decremented, never floored, because
    // inventory isn't tracked for this product.
    const updated = await prisma.product.findUnique({ where: { id: product.id } });
    expect(updated?.stock).toBe(0);

    // No InventoryMovement should be written for an untracked product either
    // — there's no real stock change to audit.
    const movements = await prisma.inventoryMovement.count({ where: { orderId } });
    expect(movements).toBe(0);
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

describe('concurrent transitions on the SAME order — advisory lock', () => {
  // Regression coverage for a real, 100%-reproducible bug this task's review
  // found and fixed: transition()'s order read is a plain SELECT under
  // Postgres's default READ COMMITTED, so without a per-order advisory lock
  // (pg_advisory_xact_lock(hashtext(orderId)), mirroring order-number.ts's
  // tenantId-keyed lock), two concurrent transitions on the same order could
  // both read the same pre-mutation status, both pass ALLOWED_ACTIONS, and
  // both commit their own branch — a two-admin-tabs-clicking-the-same-button
  // scenario, not a contrived edge case.

  it('two concurrent cancels from CONFIRMED: exactly one restock, not two', async () => {
    const { cookie, tenantId } = await signUpWithTenant('orders-race-cancel@demo.co', 'owner');
    // Seeded at 6 (not 10): CONFIRMED is a directly-seeded starting point
    // (this file's established convention — see seedOrder's doc comment)
    // standing in for "already decremented by an earlier confirm" — a real
    // CONFIRMED order of qty 4 would already have taken this product's stock
    // from 10 down to 6, so a single legitimate restock must bring it back
    // to exactly 10, not 14.
    const product = await seedProduct(tenantId, 6);
    const orderId = await seedOrder(tenantId, 'CONFIRMED', [{ productId: product.id, qty: 4 }]);

    const [a, b] = await Promise.all([
      request(app.getHttpServer()).patch(`/v1/admin/orders/${orderId}/cancel`).set('cookie', cookie).send(bodyFor('cancel')),
      request(app.getHttpServer()).patch(`/v1/admin/orders/${orderId}/cancel`).set('cookie', cookie).send(bodyFor('cancel')),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]); // one winner, one loser (already CANCELLED — a terminal state, no action is ever allowed from it)

    const productAfter = await prisma.product.findUnique({ where: { id: product.id } });
    expect(productAfter?.stock).toBe(10); // restocked exactly once, not twice (would be 14 if double-restocked)

    const movements = await prisma.inventoryMovement.count({ where: { orderId, reason: 'order_cancelled' } });
    expect(movements).toBe(1);

    const orderAfter = await prisma.order.findUnique({ where: { id: orderId } });
    expect(orderAfter?.status).toBe('CANCELLED');
  });

  it('confirm racing cancel from PENDING: the lock makes the final state deterministic either way', async () => {
    // Unlike the cancel/cancel race above, confirm and cancel are NOT
    // mutually exclusive from PENDING: ALLOWED_ACTIONS['CONFIRMED'] also
    // includes 'cancel' (decision #3 in the design doc — cancel is reachable
    // from every non-terminal status), so if confirm wins the lock first,
    // the racing cancel call is STILL a legitimate transition afterward
    // (CONFIRMED -> CANCELLED, restocking back), not a conflict — this test
    // must not assume a fixed [200, 409] status pair (whichever call wins
    // the lock, the OTHER call's outcome is a genuinely valid 200 too, not
    // an error). What must hold regardless of which order wins the race is
    // the FINAL state: both orderings below converge to the same end point.
    //   (a) confirm wins first: PENDING->CONFIRMED (stock 10->6), then
    //       cancel is now valid from CONFIRMED: CONFIRMED->CANCELLED
    //       (restock 6->10).
    //   (b) cancel wins first: PENDING->CANCELLED directly (no restock —
    //       nothing was ever decremented), then confirm's later attempt
    //       hits CANCELLED, a terminal status with no allowed actions -> 409.
    // Both converge to: order CANCELLED, stock back at 10 — never a
    // CANCELLED order sitting on decremented-but-never-restocked stock,
    // which is the exact silent-corruption bug this test guards against.
    const { cookie, tenantId } = await signUpWithTenant('orders-race-confirm-cancel@demo.co', 'owner');
    const product = await seedProduct(tenantId, 10);
    const orderId = await seedOrder(tenantId, 'PENDING', [{ productId: product.id, qty: 4 }]);

    const [confirmRes, cancelRes] = await Promise.all([
      request(app.getHttpServer()).patch(`/v1/admin/orders/${orderId}/confirm`).set('cookie', cookie),
      request(app.getHttpServer()).patch(`/v1/admin/orders/${orderId}/cancel`).set('cookie', cookie).send(bodyFor('cancel')),
    ]);

    // Neither call ever crashes (no 5xx) and at least the "loser" of the
    // fair race still gets a well-formed rejection, never an unhandled error.
    expect([confirmRes.status, cancelRes.status].every((s) => s === 200 || s === 409)).toBe(true);

    const orderAfter = await prisma.order.findUnique({ where: { id: orderId } });
    expect(orderAfter?.status).toBe('CANCELLED');

    const productAfter = await prisma.product.findUnique({ where: { id: product.id } });
    expect(productAfter?.stock).toBe(10);
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

describe('GET /v1/admin/orders/:id — shippingMethodLabel resolution', () => {
  // Regression coverage for a real bug this task's whole-branch review found:
  // `Order.shippingMethod` is an opaque id (crypto.randomUUID(), per
  // apps/admin/lib/shipping-form.ts's method factories) — not a label — so
  // rendering it raw on the admin order-detail page showed the merchant a
  // meaningless UUID instead of e.g. "Envío estándar". `shippingMethodLabel`
  // resolves it fresh against the tenant's CURRENT shipping settings.
  it('resolves shippingMethod to its current label from settings.shipping.methods', async () => {
    const { cookie, tenantId } = await signUpWithTenant('orders-shipping-label@demo.co', 'owner');
    const product = await seedProduct(tenantId, 10);

    await request(app.getHttpServer())
      .patch('/v1/admin/settings/shipping')
      .set('cookie', cookie)
      .send({
        methods: [{ id: 'flat-1', type: 'flat', label: 'Envío estándar', priceCents: 12000, enabled: true }],
      });

    const orderId = await seedOrder(tenantId, 'PENDING', [{ productId: product.id, qty: 1 }]);
    await prisma.order.update({ where: { id: orderId }, data: { shippingMethod: 'flat-1' } });

    const res = await request(app.getHttpServer())
      .get(`/v1/admin/orders/${orderId}`)
      .set('cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.shippingMethod).toBe('flat-1');
    expect(res.body.shippingMethodLabel).toBe('Envío estándar');
  });

  it('falls back to null (not the raw id) when the merchant has since deleted the method, on both GET and a transition response', async () => {
    const { cookie, tenantId } = await signUpWithTenant('orders-shipping-label-deleted@demo.co', 'owner');
    const product = await seedProduct(tenantId, 10);

    await request(app.getHttpServer())
      .patch('/v1/admin/settings/shipping')
      .set('cookie', cookie)
      .send({
        methods: [{ id: 'flat-1', type: 'flat', label: 'Envío estándar', priceCents: 12000, enabled: true }],
      });

    const orderId = await seedOrder(tenantId, 'PENDING', [{ productId: product.id, qty: 1 }]);
    await prisma.order.update({ where: { id: orderId }, data: { shippingMethod: 'flat-1' } });

    // Merchant deletes the method entirely (replaces the whole methods array).
    await request(app.getHttpServer())
      .patch('/v1/admin/settings/shipping')
      .set('cookie', cookie)
      .send({ methods: [] });

    const getRes = await request(app.getHttpServer())
      .get(`/v1/admin/orders/${orderId}`)
      .set('cookie', cookie);
    expect(getRes.status).toBe(200);
    expect(getRes.body.shippingMethod).toBe('flat-1'); // the order's own record is untouched
    expect(getRes.body.shippingMethodLabel).toBeNull(); // but the label can no longer be resolved

    // A status-transition response carries the same resolved (null) label,
    // not a stale/cached one — findOne() and transition() must agree.
    const confirmRes = await request(app.getHttpServer())
      .patch(`/v1/admin/orders/${orderId}/confirm`)
      .set('cookie', cookie);
    expect(confirmRes.status).toBe(200);
    expect(confirmRes.body.shippingMethodLabel).toBeNull();
  });
});

describe('order status transitions — shopper-facing emails', () => {
  // transition()'s sendOrder*Email(...) calls are fire-and-forget (never
  // awaited by the HTTP response — see orders.service.ts's doc comment),
  // same as checkout.service.ts's sendOrderEmails call, so each assertion
  // below gives that background call a short fixed wait to land before
  // reading `sentMail`, matching test/checkout.test.ts's established pattern.
  const waitForMail = () => new Promise((resolve) => setTimeout(resolve, 50));

  it('confirm -> preparing -> shipped -> delivered fires exactly 1 email each on confirm/shipped/delivered, and 0 on preparing', async () => {
    const { cookie, tenantId } = await signUpWithTenant('orders-email-flow@demo.co', 'owner');
    const product = await seedProduct(tenantId, 10);
    const orderId = await seedOrder(tenantId, 'PENDING', [{ productId: product.id, qty: 1 }]);

    const countBefore = sentMail.length;

    const confirmRes = await request(app.getHttpServer())
      .patch(`/v1/admin/orders/${orderId}/confirm`)
      .set('cookie', cookie);
    expect(confirmRes.status).toBe(200);
    await waitForMail();
    expect(sentMail.length).toBe(countBefore + 1);
    const confirmMail = sentMail[sentMail.length - 1];
    expect(confirmMail.to).toBe('comprador@example.com');
    expect(confirmMail.subject).toContain(`VNT-${confirmRes.body.number}`);

    const preparingRes = await request(app.getHttpServer())
      .patch(`/v1/admin/orders/${orderId}/preparing`)
      .set('cookie', cookie);
    expect(preparingRes.status).toBe(200);
    await waitForMail();
    expect(sentMail.length).toBe(countBefore + 1); // preparing sends nothing

    const shippedRes = await request(app.getHttpServer())
      .patch(`/v1/admin/orders/${orderId}/shipped`)
      .set('cookie', cookie)
      .send({ carrier: 'Servientrega', trackingNumber: 'TRK-1234' });
    expect(shippedRes.status).toBe(200);
    await waitForMail();
    expect(sentMail.length).toBe(countBefore + 2);
    const shippedMail = sentMail[sentMail.length - 1];
    expect(shippedMail.to).toBe('comprador@example.com');
    expect(shippedMail.subject).toContain(`VNT-${shippedRes.body.number}`);
    expect(shippedMail.text).toContain('Servientrega');
    expect(shippedMail.text).toContain('TRK-1234');

    const deliveredRes = await request(app.getHttpServer())
      .patch(`/v1/admin/orders/${orderId}/delivered`)
      .set('cookie', cookie);
    expect(deliveredRes.status).toBe(200);
    await waitForMail();
    expect(sentMail.length).toBe(countBefore + 3);
    const deliveredMail = sentMail[sentMail.length - 1];
    expect(deliveredMail.to).toBe('comprador@example.com');
    expect(deliveredMail.subject).toContain(`VNT-${deliveredRes.body.number}`);
  });

  it('cancel (from a restockable state) fires no email', async () => {
    const { cookie, tenantId } = await signUpWithTenant('orders-email-cancel@demo.co', 'owner');
    const product = await seedProduct(tenantId, 10);
    const orderId = await seedOrder(tenantId, 'CONFIRMED', [{ productId: product.id, qty: 1 }]);

    const countBefore = sentMail.length;

    const res = await request(app.getHttpServer())
      .patch(`/v1/admin/orders/${orderId}/cancel`)
      .set('cookie', cookie)
      .send({ reason: 'Cliente canceló' });
    expect(res.status).toBe(200);

    await waitForMail();
    expect(sentMail.length).toBe(countBefore); // no email for cancel
  });
});
