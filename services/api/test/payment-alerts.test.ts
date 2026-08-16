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
    providerRefSource: string | null;
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
      // Defaults to NULL — "unknown provenance", which schema.prisma says
      // every consumer must treat exactly like 'hint' (untrusted). Tests that
      // want a providerRef to actually resolve must say 'verified' out loud.
      providerRefSource: overrides.providerRefSource ?? null,
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
 * `platformDb`, `payload` = the parsed raw delivery body, `orderId` = the
 * order that handler resolved the event to.
 *
 * `orderId` is what the alerts list actually reads. `payload` is still seeded
 * on every event because it is still stored in production, and several tests
 * below exist precisely to prove it never escapes into a response — but it no
 * longer decides anything, which is the point of the column. */
async function seedWebhookEvent(
  tenantId: string | null,
  opts: {
    provider?: string;
    eventId?: string;
    result?: string;
    payload: unknown;
    /** Omitted = the handler resolved no order (`order_not_found`), or the row
     * predates this column. Both list as unidentified. */
    orderId?: string | null;
    processedAt?: Date | null;
  },
): Promise<string> {
  const row = await prisma.webhookEvent.create({
    data: {
      provider: opts.provider ?? 'wompi',
      eventId: opts.eventId ?? randomUUID(),
      tenantId,
      payload: opts.payload as never,
      orderId: opts.orderId ?? null,
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
      orderId: order.id, payload: wompiPayload(String(order.number)),
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
    await seedWebhookEvent(tenantId, { orderId: order.id, payload: wompiPayload(String(order.number)) });

    const res = await request(app.getHttpServer()).get('/v1/admin/payment-alerts').set('cookie', cookie);

    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('payload');
    expect(body).not.toContain('shopper-pii@example.com');
    expect(body).not.toContain('checksum');
    expect(body).not.toContain('deadbeef');
    expect(res.body.items[0]).not.toHaveProperty('payload');
  });

  it('resolves an ePayco event through the stored order link', async () => {
    const { cookie, tenantId } = await signUpWithTenant('alerts-epayco@demo.co', 'owner');
    const order = await seedOrder(tenantId, { totalCents: 89_900, paymentProvider: 'epayco' });
    await seedWebhookEvent(tenantId, {
      provider: 'epayco',
      orderId: order.id,
      payload: epaycoPayload(String(order.number)),
    });

    const res = await request(app.getHttpServer()).get('/v1/admin/payment-alerts').set('cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body.items[0].orderNumber).toBe(order.number);
    expect(res.body.items[0].amountCents).toBe(89_900);
    expect(res.body.items[0].provider).toBe('epayco');
  });

  it('resolves a Mercado Pago event, whose payload carries no order reference at all', async () => {
    // The case the stored link exists for. MP's delivered body is
    // `{type, data:{id}}` — no external_reference, no amount. Re-deriving the
    // link from the payload could therefore only ever go through
    // `Order.providerRef`, and only when one had been recorded AND vouched
    // for, so most MP alerts used to list with no order at all. The handler
    // knew the order the whole time; it now records it, so MP resolves like
    // every other provider and needs nothing stamped on the order.
    const { cookie, tenantId } = await signUpWithTenant('alerts-mp@demo.co', 'owner');
    const order = await seedOrder(tenantId, {
      totalCents: 42_000,
      paymentProvider: 'mercadopago',
      providerRef: null,
      providerRefSource: null,
    });
    await seedWebhookEvent(tenantId, {
      provider: 'mercadopago',
      orderId: order.id,
      payload: mercadoPagoPayload('1234567890'),
    });

    const res = await request(app.getHttpServer()).get('/v1/admin/payment-alerts').set('cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body.items[0].order?.id).toBe(order.id);
    expect(res.body.items[0].orderNumber).toBe(order.number);
    expect(res.body.items[0].amountCents).toBe(42_000);
  });

  it('names the linked order even when another order shares its providerRef', async () => {
    // `Order.providerRef` has no uniqueness constraint and three independent
    // writers, so a collision is possible. The old payload-derived lookup had
    // to detect that and deliberately resolve to NOTHING rather than guess.
    // Resolving by primary key cannot be ambiguous, so the collision simply
    // stops mattering — and the alert names the right order instead of
    // degrading to "no identificado".
    const { cookie, tenantId } = await signUpWithTenant('alerts-ambiguous@demo.co', 'owner');
    const sharedRef = 'shared-provider-ref-1';
    const linked = await seedOrder(tenantId, {
      totalCents: 11_100,
      providerRef: sharedRef,
      providerRefSource: 'verified',
      paymentProvider: 'mercadopago',
    });
    const decoy = await seedOrder(tenantId, {
      totalCents: 22_200,
      providerRef: sharedRef,
      providerRefSource: 'verified',
      paymentProvider: 'mercadopago',
    });
    await seedWebhookEvent(tenantId, {
      provider: 'mercadopago',
      eventId: 'ambiguous-ref',
      orderId: linked.id,
      payload: mercadoPagoPayload(sharedRef),
    });

    const res = await request(app.getHttpServer()).get('/v1/admin/payment-alerts').set('cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].order?.id).toBe(linked.id);
    expect(res.body.items[0].order?.id).not.toBe(decoy.id);
    expect(res.body.items[0].amountCents).toBe(11_100);
  });

  it('still lists an event whose order was never resolved, with null order/amount', async () => {
    // A row the handler recorded without ever matching an order — and the same
    // shape a row written before `WebhookEvent.orderId` existed has. It must
    // still LIST: hiding a row about money a shopper was charged is the one
    // outcome this whole feature exists to prevent.
    const { cookie, tenantId } = await signUpWithTenant('alerts-unresolved@demo.co', 'owner');
    await seedWebhookEvent(tenantId, {
      provider: 'mercadopago',
      eventId: 'mp-orphan:approved',
      orderId: null,
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
      await seedWebhookEvent(tenantId, { result, orderId: order.id, payload: wompiPayload(String(order.number)) });
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
    await seedWebhookEvent(tenantId, { orderId: order.id, payload: wompiPayload(String(order.number)) });

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
        orderId: order.id, payload: wompiPayload(String(order.number)),
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

  it('paginates deterministically when every row shares one timestamp', async () => {
    // `processedAt` and `createdAt` are BOTH non-unique and both stamped
    // within one request, so a burst can share a millisecond. Without a
    // unique final tiebreak, Postgres may order the ties differently between
    // the page-1 and page-2 queries — silently duplicating one row across
    // pages and dropping another entirely. On a list of "shoppers who were
    // charged for nothing", a dropped row is a customer nobody refunds.
    const { cookie, tenantId } = await signUpWithTenant('alerts-tiebreak@demo.co', 'owner');
    const sameInstant = new Date('2026-08-12T00:00:00.000Z');
    for (let i = 0; i < 6; i += 1) {
      const order = await seedOrder(tenantId);
      await seedWebhookEvent(tenantId, {
        eventId: `tie-${i}`,
        orderId: order.id, payload: wompiPayload(String(order.number)),
        processedAt: sameInstant,
      });
    }

    const seen: string[] = [];
    for (const page of [1, 2, 3]) {
      const res = await request(app.getHttpServer())
        .get(`/v1/admin/payment-alerts?page=${page}&pageSize=2`)
        .set('cookie', cookie);
      expect(res.status).toBe(200);
      seen.push(...res.body.items.map((a: { eventId: string }) => a.eventId));
    }

    // Every row seen exactly once across the three pages: no duplicates, no
    // gaps.
    expect(seen).toHaveLength(6);
    expect(new Set(seen).size).toBe(6);
    expect([...seen].sort()).toEqual(['tie-0', 'tie-1', 'tie-2', 'tie-3', 'tie-4', 'tie-5']);
  });
});

describe('payment alerts — the link ignores everything except the stored orderId', () => {
  // These tests used to assert a `providerRefSource` gate. That gate existed
  // because the link was RE-DERIVED from the stored payload, which meant it
  // could land on an order via `Order.providerRef` — a column schema.prisma
  // calls "attacker-controlled by assumption", since the unauthenticated hint
  // endpoint writes it. The gate made an untrusted ref resolve to nothing.
  //
  // The link is no longer derived from anything: `WebhookEvent.orderId` is
  // written by the webhook handler from its own authenticated lookup. So the
  // gate is gone, and these tests now assert the stronger property that
  // replaced it — the payload and `providerRef` cannot influence which order
  // an alert names, whatever they contain.

  it('ignores a planted HINT-sourced providerRef entirely', async () => {
    const { cookie, tenantId } = await signUpWithTenant('alerts-hint@demo.co', 'owner');
    const plantedRef = 'mp-planted-99';
    // A DELIVERED/PAID order — the shape a reviewer planted live. Under the
    // old derived link this contradicted the alert's own premise and rendered
    // "refund the duplicate" against a legitimate single payment.
    const planted = await seedOrder(tenantId, {
      status: 'DELIVERED',
      paymentStatus: 'PAID',
      totalCents: 999_000,
      providerRef: plantedRef,
      providerRefSource: 'hint',
      paymentProvider: 'mercadopago',
    });
    // The event names the planted ref in its payload and is linked to NO
    // order, which is what the handler records when it resolved none.
    await seedWebhookEvent(tenantId, {
      provider: 'mercadopago',
      eventId: 'hint-sourced',
      orderId: null,
      payload: mercadoPagoPayload(plantedRef),
    });

    const res = await request(app.getHttpServer()).get('/v1/admin/payment-alerts').set('cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    const alert = res.body.items[0];
    expect(alert.order).toBeNull();
    expect(alert.orderNumber).toBeNull();
    // The money-shaped field is the whole point: no authoritative-looking
    // amount may appear from a link nothing vouched for.
    expect(alert.amountCents).toBeNull();
    expect(alert.amountCents).not.toBe(999_000);
    expect(JSON.stringify(res.body)).not.toContain(planted.id);
    // The alert itself still lists, with the gateway's own id to look up.
    expect(alert.eventId).toBe('hint-sourced');
  });

  it('resolves a linked order regardless of its providerRefSource', async () => {
    // The gate's former cost, now gone: an order whose ref provenance is
    // unknown (NULL) is still named, because the link no longer comes from
    // the ref at all. Under the gate this listed as unidentified.
    const { cookie, tenantId } = await signUpWithTenant('alerts-nullsource@demo.co', 'owner');
    const order = await seedOrder(tenantId, {
      totalCents: 555_000,
      providerRef: 'mp-unknown-provenance',
      providerRefSource: null,
      paymentProvider: 'mercadopago',
    });
    await seedWebhookEvent(tenantId, {
      provider: 'mercadopago',
      eventId: 'null-sourced',
      orderId: order.id,
      payload: mercadoPagoPayload('mp-unknown-provenance'),
    });

    const res = await request(app.getHttpServer()).get('/v1/admin/payment-alerts').set('cookie', cookie);

    expect(res.body.items[0].order?.id).toBe(order.id);
    expect(res.body.items[0].amountCents).toBe(555_000);
  });

  it('names the LINKED order even when the payload names a different one', async () => {
    // The sharpest version of the property: payload and link disagree on
    // purpose. The stored link must win — otherwise the gateway body would
    // still be steering which order a merchant is told to act on.
    const { cookie, tenantId } = await signUpWithTenant('alerts-payloadconflict@demo.co', 'owner');
    const linked = await seedOrder(tenantId, { totalCents: 12_300 });
    const decoy = await seedOrder(tenantId, { totalCents: 987_600 });
    await seedWebhookEvent(tenantId, {
      provider: 'wompi',
      eventId: 'payload-conflict',
      orderId: linked.id,
      // The payload names the DECOY's order number.
      payload: wompiPayload(String(decoy.number)),
    });

    const res = await request(app.getHttpServer()).get('/v1/admin/payment-alerts').set('cookie', cookie);

    expect(res.body.items[0].order?.id).toBe(linked.id);
    expect(res.body.items[0].orderNumber).toBe(linked.number);
    expect(res.body.items[0].amountCents).toBe(12_300);
    expect(res.body.items[0].orderNumber).not.toBe(decoy.number);
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
      orderId: orderB.id,
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

  it('refuses to follow an orderId that points across the tenant boundary', async () => {
    // `WebhookEvent.orderId` deliberately has no foreign key (this table is
    // the system's record of what a gateway said, and must never be made
    // un-writable by the state of an order), so nothing at the schema level
    // stops a row from naming another tenant's order. The order lookup runs
    // through `tenantDb`, which AND-scopes it and runs under RLS, so such a
    // link must resolve to NOTHING rather than reach across.
    //
    // This is the failure that would matter most if it existed: it would
    // attach one merchant's payment — and their customer's email and order
    // total — to another merchant's alerts page.
    const a = await signUpWithTenant('alerts-crosslink-a@demo.co', 'owner');
    const b = await signUpWithTenant('alerts-crosslink-b@demo.co', 'owner');
    const ordersA = await seedOrder(a.tenantId, { totalCents: 424_242 });

    // B's event, linked to A's order.
    await seedWebhookEvent(b.tenantId, {
      eventId: 'cross-tenant-link',
      orderId: ordersA.id,
      payload: wompiPayload(String(ordersA.number)),
    });

    const asB = await request(app.getHttpServer()).get('/v1/admin/payment-alerts').set('cookie', b.cookie);

    expect(asB.status).toBe(200);
    // The alert still LISTS — it is B's own event and hiding it would hide a
    // charge — but names no order and no amount.
    expect(asB.body.total).toBe(1);
    expect(asB.body.items[0].eventId).toBe('cross-tenant-link');
    expect(asB.body.items[0].order).toBeNull();
    expect(asB.body.items[0].orderNumber).toBeNull();
    expect(asB.body.items[0].amountCents).toBeNull();
    expect(JSON.stringify(asB.body)).not.toContain(ordersA.id);
    expect(JSON.stringify(asB.body)).not.toContain('424242');
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

describe('POST /v1/admin/payment-alerts/:id/review', () => {
  it('moves a reviewed alert out of the banner count and into the reviewed list', async () => {
    const { cookie, tenantId } = await signUpWithTenant('review-basic@demo.co', 'owner');
    const order = await seedOrder(tenantId, { totalCents: 120_000 });
    const eventId = await seedWebhookEvent(tenantId, {
      eventId: 'review-basic-evt',
      orderId: order.id, payload: wompiPayload(String(order.number)),
    });

    // Before: the alarm is on.
    const before = await request(app.getHttpServer()).get('/v1/admin/payment-alerts').set('cookie', cookie);
    expect(before.body.total).toBe(1);
    expect(before.body.items[0].review).toBeNull();

    const posted = await request(app.getHttpServer())
      .post(`/v1/admin/payment-alerts/${eventId}/review`)
      .set('cookie', cookie)
      .send({ action: 'refunded', note: 'Devuelto en Wompi, recibo 8891' });
    expect(posted.status).toBe(201);

    // After: gone from the default (pending) list, which is exactly what the
    // shell banner counts.
    const pending = await request(app.getHttpServer()).get('/v1/admin/payment-alerts').set('cookie', cookie);
    expect(pending.body.total).toBe(0);
    expect(pending.body.items).toEqual([]);

    // But NOT gone from existence — it is in "Revisados", with who and what.
    const reviewed = await request(app.getHttpServer())
      .get('/v1/admin/payment-alerts?status=reviewed')
      .set('cookie', cookie);
    expect(reviewed.body.total).toBe(1);
    expect(reviewed.body.items[0].id).toBe(eventId);
    expect(reviewed.body.items[0].review).toMatchObject({
      action: 'refunded',
      note: 'Devuelto en Wompi, recibo 8891',
      reviewedByEmail: 'review-basic@demo.co',
    });
    expect(typeof reviewed.body.items[0].review.reviewedAt).toBe('string');
    // The alert's own facts survive review untouched.
    expect(reviewed.body.items[0].amountCents).toBe(120_000);
  });

  it('accepts a review with no note, and rejects an unknown action', async () => {
    const { cookie, tenantId } = await signUpWithTenant('review-validation@demo.co', 'owner');
    const order = await seedOrder(tenantId);
    const eventId = await seedWebhookEvent(tenantId, { orderId: order.id, payload: wompiPayload(String(order.number)) });

    const bad = await request(app.getHttpServer())
      .post(`/v1/admin/payment-alerts/${eventId}/review`)
      .set('cookie', cookie)
      .send({ action: 'deleted_the_evidence' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('VALIDATION_FAILED');

    const ok = await request(app.getHttpServer())
      .post(`/v1/admin/payment-alerts/${eventId}/review`)
      .set('cookie', cookie)
      .send({ action: 'no_action_needed' });
    expect(ok.status).toBe(201);
  });

  it('undoes a mistaken review by APPENDING a reopened row, never by deleting one', async () => {
    const { cookie, tenantId } = await signUpWithTenant('review-undo@demo.co', 'owner');
    const order = await seedOrder(tenantId);
    const eventId = await seedWebhookEvent(tenantId, {
      eventId: 'review-undo-evt',
      orderId: order.id, payload: wompiPayload(String(order.number)),
    });

    await request(app.getHttpServer())
      .post(`/v1/admin/payment-alerts/${eventId}/review`)
      .set('cookie', cookie)
      .send({ action: 'no_action_needed' });

    const gone = await request(app.getHttpServer()).get('/v1/admin/payment-alerts').set('cookie', cookie);
    expect(gone.body.total).toBe(0);

    // Wrong row. Undo.
    const reopen = await request(app.getHttpServer())
      .post(`/v1/admin/payment-alerts/${eventId}/review`)
      .set('cookie', cookie)
      .send({ action: 'reopened', note: 'Marqué la fila equivocada' });
    expect(reopen.status).toBe(201);

    // Back in the alarm...
    const back = await request(app.getHttpServer()).get('/v1/admin/payment-alerts').set('cookie', cookie);
    expect(back.body.total).toBe(1);
    expect(back.body.items[0].id).toBe(eventId);
    // ...and out of "Revisados".
    const reviewed = await request(app.getHttpServer())
      .get('/v1/admin/payment-alerts?status=reviewed')
      .set('cookie', cookie);
    expect(reviewed.body.total).toBe(0);

    // The mistake itself was never erased: BOTH rows are still on the record.
    const history = await prisma.webhookEventReview.findMany({
      where: { webhookEventId: eventId },
      orderBy: { createdAt: 'asc' },
    });
    expect(history.map((r) => r.action)).toEqual(['no_action_needed', 'reopened']);
  });

  it('takes the LATEST review as current state, so a re-review re-silences it', async () => {
    const { cookie, tenantId } = await signUpWithTenant('review-latest@demo.co', 'owner');
    const order = await seedOrder(tenantId);
    const eventId = await seedWebhookEvent(tenantId, { orderId: order.id, payload: wompiPayload(String(order.number)) });

    for (const action of ['no_action_needed', 'reopened', 'refunded']) {
      const res = await request(app.getHttpServer())
        .post(`/v1/admin/payment-alerts/${eventId}/review`)
        .set('cookie', cookie)
        .send({ action });
      expect(res.status).toBe(201);
    }

    const pending = await request(app.getHttpServer()).get('/v1/admin/payment-alerts').set('cookie', cookie);
    expect(pending.body.total).toBe(0);

    const reviewed = await request(app.getHttpServer())
      .get('/v1/admin/payment-alerts?status=reviewed')
      .set('cookie', cookie);
    expect(reviewed.body.total).toBe(1);
    expect(reviewed.body.items[0].review.action).toBe('refunded');
  });

  it('records the STAFF member who acted, not just the owner', async () => {
    const { cookie, tenantId } = await signUpWithTenant('review-staff@demo.co', 'staff');
    const order = await seedOrder(tenantId);
    const eventId = await seedWebhookEvent(tenantId, { orderId: order.id, payload: wompiPayload(String(order.number)) });

    await request(app.getHttpServer())
      .post(`/v1/admin/payment-alerts/${eventId}/review`)
      .set('cookie', cookie)
      .send({ action: 'order_taken_again' });

    const reviewed = await request(app.getHttpServer())
      .get('/v1/admin/payment-alerts?status=reviewed')
      .set('cookie', cookie);
    expect(reviewed.body.items[0].review.reviewedByEmail).toBe('review-staff@demo.co');
  });

  it('rejects an unauthenticated review', async () => {
    const res = await request(app.getHttpServer())
      .post(`/v1/admin/payment-alerts/${randomUUID()}/review`)
      .send({ action: 'refunded' });
    expect(res.status).toBe(401);
  });

  it('404s on an event that is not a payment alert, and on a non-uuid id', async () => {
    const { cookie, tenantId } = await signUpWithTenant('review-notalert@demo.co', 'owner');
    const order = await seedOrder(tenantId);
    const confirmedId = await seedWebhookEvent(tenantId, {
      result: 'confirmed',
      orderId: order.id, payload: wompiPayload(String(order.number)),
    });

    const notAnAlert = await request(app.getHttpServer())
      .post(`/v1/admin/payment-alerts/${confirmedId}/review`)
      .set('cookie', cookie)
      .send({ action: 'refunded' });
    expect(notAnAlert.status).toBe(404);

    const garbage = await request(app.getHttpServer())
      .post('/v1/admin/payment-alerts/not-a-uuid/review')
      .set('cookie', cookie)
      .send({ action: 'refunded' });
    expect(garbage.status).toBe(404);

    expect(await prisma.webhookEventReview.count({ where: { tenantId } })).toBe(0);
  });
});

describe('WebhookEventReview — append-only, enforced by Postgres', () => {
  /** Files one review row through the real endpoint and hands back its id. */
  async function seedReview(cookie: string, tenantId: string): Promise<string> {
    const order = await seedOrder(tenantId);
    const eventId = await seedWebhookEvent(tenantId, { orderId: order.id, payload: wompiPayload(String(order.number)) });
    await request(app.getHttpServer())
      .post(`/v1/admin/payment-alerts/${eventId}/review`)
      .set('cookie', cookie)
      .send({ action: 'refunded' });
    const row = await prisma.webhookEventReview.findFirstOrThrow({ where: { webhookEventId: eventId } });
    return row.id;
  }

  it('rejects a tenant-scoped UPDATE at the database level', async () => {
    const { cookie, tenantId } = await signUpWithTenant('review-noupdate@demo.co', 'owner');
    const reviewId = await seedReview(cookie, tenantId);

    // Raw SQL under the exact role + GUC tenantDb switches to — i.e. the most
    // privileged thing tenant-scoped code could possibly attempt. The grant,
    // not any application check, is what must stop this.
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL ROLE ventia_app');
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
        return tx.$executeRaw`UPDATE "WebhookEventReview" SET "action" = 'other' WHERE id = ${reviewId}::uuid`;
      }),
    ).rejects.toThrow(/permission denied/i);

    const after = await prisma.webhookEventReview.findFirstOrThrow({ where: { id: reviewId } });
    expect(after.action).toBe('refunded');
  });

  it('rejects a tenant-scoped DELETE at the database level', async () => {
    const { cookie, tenantId } = await signUpWithTenant('review-nodelete@demo.co', 'owner');
    const reviewId = await seedReview(cookie, tenantId);

    await expect(
      prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL ROLE ventia_app');
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
        return tx.$executeRaw`DELETE FROM "WebhookEventReview" WHERE id = ${reviewId}::uuid`;
      }),
    ).rejects.toThrow(/permission denied/i);

    expect(await prisma.webhookEventReview.count({ where: { id: reviewId } })).toBe(1);
  });

  it('rejects UPDATE and DELETE through the tenant Prisma client too', async () => {
    const { cookie, tenantId } = await signUpWithTenant('review-noprisma@demo.co', 'owner');
    const reviewId = await seedReview(cookie, tenantId);
    const { tenantDb } = (await import('@ventia/db')) as unknown as {
      tenantDb: (id: string) => {
        webhookEventReview: {
          update: (a: unknown) => Promise<unknown>;
          delete: (a: unknown) => Promise<unknown>;
        };
      };
    };

    await expect(
      tenantDb(tenantId).webhookEventReview.update({ where: { id: reviewId }, data: { action: 'other' } }),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      tenantDb(tenantId).webhookEventReview.delete({ where: { id: reviewId } }),
    ).rejects.toThrow(/permission denied/i);

    expect(await prisma.webhookEventReview.count({ where: { id: reviewId } })).toBe(1);
  });

  it('still allows the INSERT that the append-only design depends on', async () => {
    const { tenantId } = await signUpWithTenant('review-caninsert@demo.co', 'owner');
    const order = await seedOrder(tenantId);
    const eventId = await seedWebhookEvent(tenantId, { orderId: order.id, payload: wompiPayload(String(order.number)) });
    const { tenantDb } = (await import('@ventia/db')) as unknown as {
      tenantDb: (id: string) => { webhookEventReview: { create: (a: unknown) => Promise<{ id: string }> } };
    };

    const created = await tenantDb(tenantId).webhookEventReview.create({
      data: {
        webhookEventId: eventId,
        action: 'other',
        reviewedByUserId: randomUUID(),
        reviewedByEmail: 'review-caninsert@demo.co',
      },
    });
    expect(created.id).toBeTruthy();
  });
});

describe('WebhookEventReview — tenant isolation', () => {
  it('tenant A cannot see tenant B\'s reviews', async () => {
    const a = await signUpWithTenant('review-iso-a@demo.co', 'owner');
    const b = await signUpWithTenant('review-iso-b@demo.co', 'owner');

    const orderB = await seedOrder(b.tenantId, { totalCents: 640_000 });
    const eventB = await seedWebhookEvent(b.tenantId, {
      eventId: 'review-iso-b-evt',
      payload: wompiPayload(String(orderB.number)),
    });
    await request(app.getHttpServer())
      .post(`/v1/admin/payment-alerts/${eventB}/review`)
      .set('cookie', b.cookie)
      .send({ action: 'refunded', note: 'secreto-de-b' });

    const asA = await request(app.getHttpServer())
      .get('/v1/admin/payment-alerts?status=reviewed')
      .set('cookie', a.cookie);
    expect(asA.status).toBe(200);
    expect(asA.body).toEqual({ items: [], total: 0, page: 1, pageSize: 20 });
    expect(JSON.stringify(asA.body)).not.toContain('secreto-de-b');
    expect(JSON.stringify(asA.body)).not.toContain('review-iso-b@demo.co');

    const asB = await request(app.getHttpServer())
      .get('/v1/admin/payment-alerts?status=reviewed')
      .set('cookie', b.cookie);
    expect(asB.body.total).toBe(1);
    expect(asB.body.items[0].review.note).toBe('secreto-de-b');
  });

  it('tenant A cannot review tenant B\'s alert', async () => {
    const a = await signUpWithTenant('review-cross-a@demo.co', 'owner');
    const b = await signUpWithTenant('review-cross-b@demo.co', 'owner');
    const orderB = await seedOrder(b.tenantId);
    const eventB = await seedWebhookEvent(b.tenantId, {
      eventId: 'review-cross-b-evt',
      payload: wompiPayload(String(orderB.number)),
    });

    const res = await request(app.getHttpServer())
      .post(`/v1/admin/payment-alerts/${eventB}/review`)
      .set('cookie', a.cookie)
      .send({ action: 'no_action_needed' });
    expect(res.status).toBe(404);

    // No row was written under EITHER tenant, and B's alert is still live.
    expect(await prisma.webhookEventReview.count({ where: { webhookEventId: eventB } })).toBe(0);
    const asB = await request(app.getHttpServer()).get('/v1/admin/payment-alerts').set('cookie', b.cookie);
    expect(asB.body.total).toBe(1);
  });

  it('is enforced by Postgres RLS itself, not only by the service\'s where clause', async () => {
    const a = await signUpWithTenant('review-rls-a@demo.co', 'owner');
    const b = await signUpWithTenant('review-rls-b@demo.co', 'owner');
    const orderB = await seedOrder(b.tenantId);
    const eventB = await seedWebhookEvent(b.tenantId, { payload: wompiPayload(String(orderB.number)) });
    await request(app.getHttpServer())
      .post(`/v1/admin/payment-alerts/${eventB}/review`)
      .set('cookie', b.cookie)
      .send({ action: 'refunded', note: 'rls-b-only-note' });

    const read = (tenantId: string) =>
      prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL ROLE ventia_app');
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
        // Deliberately UNSCOPED: RLS alone must do the filtering.
        return tx.$queryRaw<{ note: string | null }[]>`SELECT "note" FROM "WebhookEventReview"`;
      });

    expect((await read(a.tenantId)).map((r) => r.note)).not.toContain('rls-b-only-note');
    expect((await read(b.tenantId)).map((r) => r.note)).toContain('rls-b-only-note');
  });

  it('refuses an INSERT that claims another tenant, via the RLS WITH CHECK', async () => {
    const a = await signUpWithTenant('review-check-a@demo.co', 'owner');
    const b = await signUpWithTenant('review-check-b@demo.co', 'owner');
    const orderB = await seedOrder(b.tenantId);
    const eventB = await seedWebhookEvent(b.tenantId, { payload: wompiPayload(String(orderB.number)) });

    // Tenant A's context, but writing a row stamped with tenant B's id — the
    // shape a service bug (or a future endpoint that forgot to scope) would
    // produce. The policy, not the service, must reject it.
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL ROLE ventia_app');
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${a.tenantId}, true)`;
        return tx.$executeRaw`
          INSERT INTO "WebhookEventReview"
            ("id", "tenantId", "webhookEventId", "action", "reviewedByUserId", "reviewedByEmail")
          VALUES (gen_random_uuid(), ${b.tenantId}::uuid, ${eventB}::uuid, 'refunded', gen_random_uuid(), 'a@evil.co')`;
      }),
    ).rejects.toThrow(/row-level security/i);

    expect(await prisma.webhookEventReview.count({ where: { webhookEventId: eventB } })).toBe(0);
  });
});
