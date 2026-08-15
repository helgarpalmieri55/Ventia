import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient as PrismaClientType, OrderStatus, PaymentStatus } from '@ventia/db';
import { startTestDb } from './helpers';
import type { signUpWithTenant as SignUpWithTenant } from './admin-helpers';

let db: Awaited<ReturnType<typeof startTestDb>>;
let redisContainer: StartedTestContainer;
let app: INestApplication;
let signUpWithTenant: typeof SignUpWithTenant;
let prisma: PrismaClientType;

beforeAll(async () => {
  db = await startTestDb();
  redisContainer = await new GenericContainer('redis:7-alpine')
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
    .start();

  // Env before the first (dynamic) import of @ventia/db / ../src/main —
  // same pattern as orders-transitions.test.ts.
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

let orderNumberSeq = 5000;

/** Seeds one Order directly via Prisma at an arbitrary status — the states
 * this feature is about (CANCELLED + paymentStatus PENDING) are reached by
 * the expiry worker, not by anything the admin HTTP API can drive. */
async function seedOrder(
  tenantId: string,
  overrides: Partial<{
    number: number;
    status: OrderStatus;
    paymentStatus: PaymentStatus;
    totalCents: number;
    providerRef: string | null;
    paymentProvider: string | null;
  }> = {},
): Promise<{ id: string; number: number }> {
  const number = overrides.number ?? orderNumberSeq++;
  const order = await prisma.order.create({
    data: {
      tenantId,
      number,
      status: overrides.status ?? 'CANCELLED',
      paymentStatus: overrides.paymentStatus ?? 'PENDING',
      paymentProvider: overrides.paymentProvider ?? 'wompi',
      providerRef: overrides.providerRef ?? null,
      email: 'comprador@example.com',
      phone: '3000000000',
      shippingAddress: {},
      subtotalCents: overrides.totalCents ?? 150_000,
      taxCents: 0,
      totalCents: overrides.totalCents ?? 150_000,
    },
  });
  return { id: order.id, number: order.number };
}

/** Records one WebhookEvent exactly the way webhooks.controller.ts does —
 * `platformDb`, `payload` = the parsed raw delivery body. */
async function seedWebhookEvent(
  tenantId: string | null,
  opts: {
    provider?: string;
    eventId?: string;
    result?: string;
    payload: unknown;
    processedAt?: Date | null;
  },
): Promise<string> {
  const row = await prisma.webhookEvent.create({
    data: {
      provider: opts.provider ?? 'wompi',
      eventId: opts.eventId ?? randomUUID(),
      tenantId,
      payload: opts.payload as never,
      processedAt: opts.processedAt === undefined ? new Date() : opts.processedAt,
      result: opts.result ?? 'paid_order_not_settleable',
    },
  });
  return row.id;
}

function wompiPayload(reference: string, transactionId = `wompi-tx-${randomUUID()}`): unknown {
  return {
    event: 'transaction.updated',
    data: {
      transaction: {
        id: transactionId,
        reference,
        status: 'APPROVED',
        amount_in_cents: 150_000,
        currency: 'COP',
        // Deliberately included: this is exactly the kind of shopper PII a
        // real gateway payload carries, and the endpoint must never echo it.
        customer_email: 'shopper-pii@example.com',
      },
      signature: { checksum: 'deadbeef', properties: ['transaction.id'] },
    },
  };
}

function epaycoPayload(reference: string, refPayco = `epayco-${randomUUID()}`): unknown {
  return {
    x_ref_payco: refPayco,
    x_transaction_id: 'tx-1',
    x_extra1: reference,
    x_amount: '1500.00',
    x_currency_code: 'COP',
    x_signature: 'abc',
    x_customer_email: 'shopper-pii@example.com',
  };
}

function mercadoPagoPayload(paymentId: string): unknown {
  // MP's delivered notification body genuinely carries nothing but the
  // payment id — status/amount/external_reference come from an authenticated
  // follow-up lookup that is never persisted. See the service's doc comment.
  return { type: 'payment', action: 'payment.updated', data: { id: paymentId } };
}

describe('GET /v1/admin/payment-alerts', () => {
  it('lists a paid-but-unsettleable Wompi event with its order, amount and gateway', async () => {
    const { cookie, tenantId } = await signUpWithTenant('alerts-wompi@demo.co', 'owner');
    const order = await seedOrder(tenantId, { totalCents: 150_000 });
    const processedAt = new Date('2026-08-10T15:04:05.000Z');
    await seedWebhookEvent(tenantId, {
      provider: 'wompi',
      eventId: 'evt-wompi-1',
      payload: wompiPayload(String(order.number)),
      processedAt,
    });

    const res = await request(app.getHttpServer()).get('/v1/admin/payment-alerts').set('cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.page).toBe(1);
    expect(res.body.items).toHaveLength(1);

    const alert = res.body.items[0];
    expect(alert.provider).toBe('wompi');
    expect(alert.eventId).toBe('evt-wompi-1');
    expect(alert.occurredAt).toBe(processedAt.toISOString());
    expect(alert.orderNumber).toBe(order.number);
    expect(alert.amountCents).toBe(150_000);
    expect(alert.order).toMatchObject({
      id: order.id,
      number: order.number,
      status: 'CANCELLED',
      paymentStatus: 'PENDING',
    });
  });

  it('NEVER exposes the raw gateway payload', async () => {
    const { cookie, tenantId } = await signUpWithTenant('alerts-nopayload@demo.co', 'owner');
    const order = await seedOrder(tenantId);
    await seedWebhookEvent(tenantId, { payload: wompiPayload(String(order.number)) });

    const res = await request(app.getHttpServer()).get('/v1/admin/payment-alerts').set('cookie', cookie);

    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('payload');
    expect(body).not.toContain('shopper-pii@example.com');
    expect(body).not.toContain('checksum');
    expect(body).not.toContain('deadbeef');
    expect(res.body.items[0]).not.toHaveProperty('payload');
  });

  it('resolves an ePayco event through x_extra1', async () => {
    const { cookie, tenantId } = await signUpWithTenant('alerts-epayco@demo.co', 'owner');
    const order = await seedOrder(tenantId, { totalCents: 89_900, paymentProvider: 'epayco' });
    await seedWebhookEvent(tenantId, {
      provider: 'epayco',
      payload: epaycoPayload(String(order.number)),
    });

    const res = await request(app.getHttpServer()).get('/v1/admin/payment-alerts').set('cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body.items[0].orderNumber).toBe(order.number);
    expect(res.body.items[0].amountCents).toBe(89_900);
    expect(res.body.items[0].provider).toBe('epayco');
  });

  it('resolves a Mercado Pago event through the order providerRef, since its payload carries no reference', async () => {
    const { cookie, tenantId } = await signUpWithTenant('alerts-mp@demo.co', 'owner');
    const paymentId = '1234567890';
    const order = await seedOrder(tenantId, {
      totalCents: 42_000,
      paymentProvider: 'mercadopago',
      providerRef: paymentId,
    });
    await seedWebhookEvent(tenantId, {
      provider: 'mercadopago',
      payload: mercadoPagoPayload(paymentId),
    });

    const res = await request(app.getHttpServer()).get('/v1/admin/payment-alerts').set('cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body.items[0].order?.id).toBe(order.id);
    expect(res.body.items[0].orderNumber).toBe(order.number);
    expect(res.body.items[0].amountCents).toBe(42_000);
  });

  it('refuses to name an order when two of them share the same providerRef', async () => {
    // `Order.providerRef` has no uniqueness constraint and three independent
    // writers, so a collision is possible. Guessing between them would put
    // the WRONG order (and the wrong amount) on an alert about money already
    // taken — worse than admitting we don't know.
    const { cookie, tenantId } = await signUpWithTenant('alerts-ambiguous@demo.co', 'owner');
    const sharedRef = 'shared-provider-ref-1';
    await seedOrder(tenantId, { totalCents: 11_100, providerRef: sharedRef, paymentProvider: 'mercadopago' });
    await seedOrder(tenantId, { totalCents: 22_200, providerRef: sharedRef, paymentProvider: 'mercadopago' });
    await seedWebhookEvent(tenantId, {
      provider: 'mercadopago',
      eventId: 'ambiguous-ref',
      payload: mercadoPagoPayload(sharedRef),
    });

    const res = await request(app.getHttpServer()).get('/v1/admin/payment-alerts').set('cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].order).toBeNull();
    expect(res.body.items[0].amountCents).toBeNull();
    expect(res.body.items[0].eventId).toBe('ambiguous-ref');
  });

  it('still lists an event whose order cannot be resolved, with null order/amount', async () => {
    const { cookie, tenantId } = await signUpWithTenant('alerts-unresolved@demo.co', 'owner');
    await seedWebhookEvent(tenantId, {
      provider: 'mercadopago',
      eventId: 'mp-orphan:approved',
      payload: mercadoPagoPayload('no-such-payment'),
    });

    const res = await request(app.getHttpServer()).get('/v1/admin/payment-alerts').set('cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].order).toBeNull();
    expect(res.body.items[0].orderNumber).toBeNull();
    expect(res.body.items[0].amountCents).toBeNull();
    // The gateway's own event id is what the merchant searches the gateway
    // dashboard with when we cannot name the order — it must survive.
    expect(res.body.items[0].eventId).toBe('mp-orphan:approved');
  });

  it('ignores every other webhook result, including confirmed ones', async () => {
    const { cookie, tenantId } = await signUpWithTenant('alerts-otherresults@demo.co', 'owner');
    const order = await seedOrder(tenantId);
    for (const result of ['confirmed', 'amount_mismatch', 'order_not_found', 'currency_mismatch', 'failed']) {
      await seedWebhookEvent(tenantId, { result, payload: wompiPayload(String(order.number)) });
    }

    const res = await request(app.getHttpServer()).get('/v1/admin/payment-alerts').set('cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
    expect(res.body.items).toEqual([]);
  });

  it('returns a clean, empty page — not an error — for a merchant with no such events', async () => {
    const { cookie } = await signUpWithTenant('alerts-empty@demo.co', 'owner');

    const res = await request(app.getHttpServer()).get('/v1/admin/payment-alerts').set('cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [], total: 0, page: 1, pageSize: 20 });
  });

  it('is reachable by a staff session, not only the owner', async () => {
    const { cookie, tenantId } = await signUpWithTenant('alerts-staff@demo.co', 'staff');
    const order = await seedOrder(tenantId);
    await seedWebhookEvent(tenantId, { payload: wompiPayload(String(order.number)) });

    const res = await request(app.getHttpServer()).get('/v1/admin/payment-alerts').set('cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
  });

  it('rejects an unauthenticated request', async () => {
    const res = await request(app.getHttpServer()).get('/v1/admin/payment-alerts');
    expect(res.status).toBe(401);
  });

  it('paginates newest first and clamps page/pageSize like the orders list does', async () => {
    const { cookie, tenantId } = await signUpWithTenant('alerts-paging@demo.co', 'owner');
    for (let i = 0; i < 3; i += 1) {
      const order = await seedOrder(tenantId);
      await seedWebhookEvent(tenantId, {
        eventId: `paging-${i}`,
        payload: wompiPayload(String(order.number)),
        processedAt: new Date(Date.UTC(2026, 7, 10 + i)),
      });
    }

    const first = await request(app.getHttpServer())
      .get('/v1/admin/payment-alerts?page=1&pageSize=2')
      .set('cookie', cookie);
    expect(first.status).toBe(200);
    expect(first.body.total).toBe(3);
    expect(first.body.items.map((a: { eventId: string }) => a.eventId)).toEqual(['paging-2', 'paging-1']);

    const second = await request(app.getHttpServer())
      .get('/v1/admin/payment-alerts?page=2&pageSize=2')
      .set('cookie', cookie);
    expect(second.body.items.map((a: { eventId: string }) => a.eventId)).toEqual(['paging-0']);

    // Garbage / out-of-range params fall back to the defaults rather than 400,
    // matching OrdersService.list()'s established behavior.
    const clamped = await request(app.getHttpServer())
      .get('/v1/admin/payment-alerts?page=0&pageSize=99999')
      .set('cookie', cookie);
    expect(clamped.body.page).toBe(1);
    expect(clamped.body.pageSize).toBe(100);

    const garbage = await request(app.getHttpServer())
      .get('/v1/admin/payment-alerts?page=abc&pageSize=xyz')
      .set('cookie', cookie);
    expect(garbage.body.page).toBe(1);
    expect(garbage.body.pageSize).toBe(20);
  });
});

describe('payment alerts — tenant isolation', () => {
  it('tenant A cannot see tenant B\'s paid_order_not_settleable events', async () => {
    const a = await signUpWithTenant('alerts-tenant-a@demo.co', 'owner');
    const b = await signUpWithTenant('alerts-tenant-b@demo.co', 'owner');

    // Both tenants have an order with the SAME number (Order.number is
    // per-tenant) — so a leak would not merely show a foreign row, it would
    // silently attach tenant B's payment to tenant A's own order.
    const sharedNumber = 90_001;
    const orderA = await seedOrder(a.tenantId, { number: sharedNumber, totalCents: 10_000 });
    const orderB = await seedOrder(b.tenantId, { number: sharedNumber, totalCents: 777_000 });

    await seedWebhookEvent(b.tenantId, {
      eventId: 'tenant-b-only',
      payload: wompiPayload(String(sharedNumber)),
    });

    const asA = await request(app.getHttpServer()).get('/v1/admin/payment-alerts').set('cookie', a.cookie);
    expect(asA.status).toBe(200);
    expect(asA.body).toEqual({ items: [], total: 0, page: 1, pageSize: 20 });
    expect(JSON.stringify(asA.body)).not.toContain('tenant-b-only');
    expect(JSON.stringify(asA.body)).not.toContain(orderA.id);

    const asB = await request(app.getHttpServer()).get('/v1/admin/payment-alerts').set('cookie', b.cookie);
    expect(asB.body.total).toBe(1);
    expect(asB.body.items[0].eventId).toBe('tenant-b-only');
    // Resolved against B's OWN order, not A's same-numbered one.
    expect(asB.body.items[0].order.id).toBe(orderB.id);
    expect(asB.body.items[0].amountCents).toBe(777_000);
  });

  it('never surfaces a tenant-less webhook event to anyone', async () => {
    const { cookie } = await signUpWithTenant('alerts-tenantless@demo.co', 'owner');
    await seedWebhookEvent(null, { eventId: 'no-tenant-event', payload: wompiPayload('1') });

    const res = await request(app.getHttpServer()).get('/v1/admin/payment-alerts').set('cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
  });

  it('is enforced by Postgres RLS itself, not only by the service\'s where clause', async () => {
    const a = await signUpWithTenant('alerts-rls-a@demo.co', 'owner');
    const b = await signUpWithTenant('alerts-rls-b@demo.co', 'owner');
    await seedWebhookEvent(b.tenantId, { eventId: 'rls-b-only', payload: wompiPayload('1') });

    // Same role + GUC tenantDb switches to, but with NO application-layer
    // tenant filter at all: a deliberately unscoped `SELECT *`. RLS alone
    // must return zero of tenant B's rows under tenant A's context.
    const rows = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE ventia_app');
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${a.tenantId}, true)`;
      return tx.$queryRaw<{ eventId: string }[]>`SELECT "eventId" FROM "WebhookEvent"`;
    });
    expect(rows.map((r) => r.eventId)).not.toContain('rls-b-only');

    const asB = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE ventia_app');
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${b.tenantId}, true)`;
      return tx.$queryRaw<{ eventId: string }[]>`SELECT "eventId" FROM "WebhookEvent"`;
    });
    expect(asB.map((r) => r.eventId)).toContain('rls-b-only');
  });

  it('leaves this table WRITE-protected from tenant-scoped code', async () => {
    const { tenantId } = await signUpWithTenant('alerts-readonly@demo.co', 'owner');
    const { tenantDb } = (await import('@ventia/db')) as unknown as {
      tenantDb: (id: string) => { webhookEvent: { create: (a: unknown) => Promise<unknown> } };
    };

    await expect(
      tenantDb(tenantId).webhookEvent.create({
        data: { provider: 'wompi', eventId: 'forged', payload: {}, result: 'confirmed' },
      }),
    ).rejects.toThrow(/permission denied/i);
  });
});
