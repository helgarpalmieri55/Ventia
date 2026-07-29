import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import request from 'supertest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import type { INestApplication } from '@nestjs/common';
import type express from 'express';
import type { PrismaClient as PrismaClientType } from '@ventia/db';
import { startTestDb } from './helpers';
import type { signUpWithTenant as SignUpWithTenant } from './admin-helpers';
import type { PaymentsService as PaymentsServiceType } from '../src/payments/payments.service';

let db: Awaited<ReturnType<typeof startTestDb>>;
let redisContainer: StartedTestContainer;
let app: INestApplication;
// A SECOND, independent app instance built from the exact SAME `createApp()`
// production factory — used ONLY by the raw-body-preservation test below.
// It exists purely so a throwaway probe route can be attached directly to
// its underlying Express instance to observe `req.body` after main.ts's real
// middleware chain has run, without adding any test-only code to the shared
// `app` instance every other test in this file (and this suite's own
// business-logic tests) relies on.
let rawProbeApp: INestApplication;
let signUpWithTenant: typeof SignUpWithTenant;
let prisma: PrismaClientType;
let paymentsService: PaymentsServiceType;

beforeAll(async () => {
  db = await startTestDb();
  redisContainer = await new GenericContainer('redis:7-alpine')
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
    .start();

  // Env vars must be set BEFORE the first import of @ventia/db / ../src/main
  // / ./admin-helpers — same pattern as payments-service.test.ts.
  process.env.DATABASE_URL = db.url;
  process.env.REDIS_URL = `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`;
  process.env.PAYMENTS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

  const { createApp } = await import('../src/main');
  app = await createApp();
  await app.init();

  // Second app instance for the raw-body probe test (see comment above).
  // `createApp()` is called a second time so this exercises the REAL,
  // unmodified production middleware wiring from main.ts — nothing about
  // the middleware itself is reimplemented or mocked here, only a throwaway
  // echo route is attached to observe what `req.body` looks like once that
  // real chain has run.
  rawProbeApp = await createApp();
  const rawProbeAdapter = rawProbeApp.getHttpAdapter().getInstance() as express.Express;
  rawProbeAdapter.post('/webhooks/__raw_echo_test', (req, res) => {
    const body = req.body as unknown;
    res.json({ isBuffer: Buffer.isBuffer(body), raw: Buffer.isBuffer(body) ? (body as Buffer).toString('utf8') : null });
  });
  await rawProbeApp.init();

  ({ signUpWithTenant } = await import('./admin-helpers'));
  ({ platformDb: prisma } = (await import('@ventia/db')) as unknown as { platformDb: PrismaClientType });

  const { PaymentsService } = await import('../src/payments/payments.service');
  paymentsService = app.get(PaymentsService);
}, 120_000);

afterAll(async () => {
  await app.close();
  await rawProbeApp.close();
  await redisContainer.stop();
  await db.stop();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const FAKE_CREDS = {
  publicKey: 'pub_test_ABCDEFGHIJKLMNOPQRSTUV',
  privateKey: 'prv_test_ZYXWVUTSRQPONMLKJIHGFEDCBA0123456789',
  integritySecret: 'test_integrity_abc123def456',
  eventsSecret: 'test_events_ghi789jkl012',
  sandbox: true,
};

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Builds a Wompi-shaped, validly-signed webhook payload — same algorithm as
 * packages/payments/test/wompi.test.ts's `buildSignedWebhookPayload` (not
 * imported directly: that helper lives in a different package's test
 * directory, and this codebase's established convention, per
 * test/helpers.ts's own doc comment, is that duplicating a small test helper
 * like this is preferable to fighting cross-package export-map/vitest
 * friction). `reference` here is always the PLAIN STRING form of
 * `Order.number` (e.g. `'42'`), per the contract established on
 * `NormalizedPaymentEvent.reference` (packages/payments/src/index.ts) —
 * never the `VNT-`-prefixed display string. */
function buildSignedWebhookPayload(opts: {
  transactionId: string;
  status: string;
  amountInCents: number;
  reference: string;
  timestamp: number;
  eventsSecret: string;
  properties?: string[];
}) {
  const properties = opts.properties ?? [
    'transaction.id',
    'transaction.status',
    'transaction.amount_in_cents',
    'transaction.reference',
  ];
  const data = {
    transaction: {
      id: opts.transactionId,
      status: opts.status,
      amount_in_cents: opts.amountInCents,
      reference: opts.reference,
      currency: 'COP',
    },
  };
  const valuesByPath: Record<string, unknown> = {
    'transaction.id': data.transaction.id,
    'transaction.status': data.transaction.status,
    'transaction.amount_in_cents': data.transaction.amount_in_cents,
    'transaction.reference': data.transaction.reference,
  };
  const concatenated =
    properties.map((p) => String(valuesByPath[p])).join('') + String(opts.timestamp) + opts.eventsSecret;
  const checksum = sha256Hex(concatenated);
  return {
    event: 'transaction.updated',
    data,
    signature: { properties, checksum },
    timestamp: opts.timestamp,
    sent_at: new Date(opts.timestamp * 1000).toISOString(),
  };
}

/** Posts a webhook payload to the real running app, sending the EXACT
 * JSON.stringify'd string as the request body (not an object) — supertest/
 * superagent only re-serializes object payloads; a string payload with an
 * already-set Content-Type is sent byte-for-byte as-is (verified against
 * superagent's source: `_end()` only calls a serializer `if (typeof data !==
 * 'string')`). This matters for the raw-body test below, and is used
 * uniformly here so every test in this file exercises the same real
 * request-body path. */
async function postWebhook(tenantId: string, payload: unknown, provider = 'wompi') {
  return request(app.getHttpServer())
    .post(`/webhooks/payments/${provider}/${tenantId}`)
    .set('Content-Type', 'application/json')
    .send(JSON.stringify(payload));
}

let orderNumberSeq = 1;

/** Seeds a Product (with stock already reflecting a PRE-EXISTING reservation
 * decrement — simulating what Task 5's checkout wompi branch will do at
 * order-creation time, since that task doesn't exist yet) and a PENDING/
 * PENDING Order with `stockReservedUntil` set, referencing that product.
 * Returns the plain numeric `orderNumber` — the exact string form of this
 * (`String(orderNumber)`) is what a real Wompi webhook's `reference` field
 * would carry, per the contract this task establishes. */
async function seedOrderWithProduct(
  tenantId: string,
  opts?: { initialStock?: number; reservedQty?: number },
): Promise<{ orderId: string; orderNumber: number; productId: string; stockAfterReservation: number }> {
  const initialStock = opts?.initialStock ?? 20;
  const reservedQty = opts?.reservedQty ?? 3;
  const stockAfterReservation = initialStock - reservedQty;

  const product = await prisma.product.create({
    data: {
      tenantId,
      name: 'Producto Webhook',
      slug: `producto-webhook-${randomUUID()}`,
      priceCents: 10_000,
      status: 'active',
      stock: stockAfterReservation,
    },
  });

  const orderNumber = orderNumberSeq++;
  const order = await prisma.order.create({
    data: {
      tenantId,
      number: orderNumber,
      status: 'PENDING',
      paymentStatus: 'PENDING',
      paymentProvider: 'wompi',
      stockReservedUntil: new Date(Date.now() + 15 * 60_000),
      email: 'comprador@example.com',
      phone: '3000000000',
      shippingAddress: {},
      subtotalCents: 10_000 * reservedQty,
      taxCents: 0,
      totalCents: 10_000 * reservedQty,
    },
  });
  await prisma.orderItem.create({
    data: {
      tenantId,
      orderId: order.id,
      productId: product.id,
      nameSnapshot: 'Producto Webhook',
      priceCentsSnapshot: 10_000,
      qty: reservedQty,
      taxRateSnapshot: 'NINETEEN',
    },
  });

  return { orderId: order.id, orderNumber, productId: product.id, stockAfterReservation };
}

describe('Raw-body preservation (main.ts /webhooks express.raw() exception)', () => {
  it('preserves the exact original request bytes (unusual whitespace + key ordering) through the real middleware chain', async () => {
    // Deliberately unusual formatting: irregular indentation, keys NOT in
    // insertion order a hand-rolled JSON.stringify would produce, a
    // trailing newline. Still syntactically valid JSON (this is not a test
    // of malformed-JSON handling), so if this ever came back re-serialized
    // by something upstream (e.g. express.json() parsing it into an object,
    // then something JSON.stringify-ing that object back to a string), the
    // VALUES would be unchanged but the exact bytes would differ — which is
    // precisely what this test needs to catch.
    const weirdJson = '{\n  "b":  2,\n"a":1,\n  "nested": {"y":null,   "x" :true},\n"list":[1,2,   3]\n}\n';
    expect(() => JSON.parse(weirdJson)).not.toThrow(); // sanity: valid JSON

    const res = await request(rawProbeApp.getHttpServer())
      .post('/webhooks/__raw_echo_test')
      .set('Content-Type', 'application/json')
      .send(weirdJson);

    expect(res.status).toBe(200);
    // The middleware handed the controller a raw Buffer, not a parsed object.
    expect(res.body.isBuffer).toBe(true);
    // And converting that Buffer back to a string reproduces the EXACT
    // original bytes — not just an equivalent JSON value.
    expect(res.body.raw).toBe(weirdJson);
  });
});

describe('POST /webhooks/payments/:provider/:tenantId', () => {
  it('unknown provider in the URL -> 404 WEBHOOK_UNKNOWN_PROVIDER', async () => {
    const { tenantId } = await signUpWithTenant('webhooks-unknown-provider@demo.co', 'owner');
    const res = await postWebhook(tenantId, { anything: true }, 'nonsense');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'WEBHOOK_UNKNOWN_PROVIDER' });
  });

  it('provider the tenant never configured credentials for -> 401 WEBHOOK_INVALID_SIGNATURE (not a distinct code)', async () => {
    const { tenantId } = await signUpWithTenant('webhooks-unconfigured@demo.co', 'owner');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const payload = buildSignedWebhookPayload({
      transactionId: 'txn-unconfigured',
      status: 'APPROVED',
      amountInCents: 30_000,
      reference: '1',
      timestamp: 1_700_000_100,
      eventsSecret: 'whatever-secret-nobody-saved',
    });

    const res = await postWebhook(tenantId, payload);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'WEBHOOK_INVALID_SIGNATURE' });
    expect(errorSpy).toHaveBeenCalled();
  });

  describe('valid signed payload', () => {
    it('APPROVED -> 200, order CONFIRMED/PAID, stockReservedUntil cleared, stock NOT decremented again by the webhook', async () => {
      const { tenantId } = await signUpWithTenant('webhooks-happy-path@demo.co', 'owner');
      await paymentsService.saveProviderCredentials(tenantId, 'wompi', FAKE_CREDS);
      const { orderId, orderNumber, productId, stockAfterReservation } = await seedOrderWithProduct(tenantId);

      const payload = buildSignedWebhookPayload({
        transactionId: 'txn-happy-1',
        status: 'APPROVED',
        amountInCents: 30_000,
        reference: String(orderNumber),
        timestamp: 1_700_000_200,
        eventsSecret: FAKE_CREDS.eventsSecret,
      });

      const res = await postWebhook(tenantId, payload);
      expect(res.status).toBe(200);

      const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      expect(order.status).toBe('CONFIRMED');
      expect(order.paymentStatus).toBe('PAID');
      expect(order.stockReservedUntil).toBeNull();

      // Stock-decremented-exactly-once assertion (per this task's own
      // seeding convention): the product's stock already reflects the
      // reservation decrement seeded above — the webhook path must NOT
      // decrement it a second time. This is the real property design
      // decision 3 establishes: markPaid never touches stock itself.
      const product = await prisma.product.findUniqueOrThrow({ where: { id: productId } });
      expect(product.stock).toBe(stockAfterReservation);

      const events = await prisma.orderEvent.findMany({ where: { orderId, type: 'payment_confirmed' } });
      expect(events).toHaveLength(1);

      const webhookEvents = await prisma.webhookEvent.findMany({ where: { provider: 'wompi', eventId: 'txn-happy-1:1700000200' } });
      expect(webhookEvents).toHaveLength(1);
      expect(webhookEvents[0].processedAt).not.toBeNull();
      expect(webhookEvents[0].result).toBe('confirmed');
    });

    it('the exact same payload sent 10x -> exactly ONE state transition, ONE WebhookEvent row, stock unchanged after the first', async () => {
      const { tenantId } = await signUpWithTenant('webhooks-replay-10x@demo.co', 'owner');
      await paymentsService.saveProviderCredentials(tenantId, 'wompi', FAKE_CREDS);
      const { orderId, orderNumber, productId, stockAfterReservation } = await seedOrderWithProduct(tenantId);

      const payload = buildSignedWebhookPayload({
        transactionId: 'txn-replay-1',
        status: 'APPROVED',
        amountInCents: 30_000,
        reference: String(orderNumber),
        timestamp: 1_700_000_300,
        eventsSecret: FAKE_CREDS.eventsSecret,
      });
      // Sent as the identical, already-serialized string 10x — this is
      // deliberately the EXACT SAME payload/bytes each time, not a
      // reconstructed equivalent one, so this genuinely exercises the
      // (provider, eventId) unique-constraint conflict path, not some other
      // coincidental idempotency.
      const rawPayload = JSON.stringify(payload);

      const responses = [];
      for (let i = 0; i < 10; i++) {
        const res = await request(app.getHttpServer())
          .post(`/webhooks/payments/wompi/${tenantId}`)
          .set('Content-Type', 'application/json')
          .send(rawPayload);
        responses.push(res.status);
      }

      // All 10 responses are 200 — a replay is never an error from the
      // gateway's point of view, it's a successfully-acknowledged duplicate.
      expect(responses).toEqual(Array(10).fill(200));

      const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      expect(order.status).toBe('CONFIRMED');
      expect(order.paymentStatus).toBe('PAID');
      expect(order.stockReservedUntil).toBeNull();

      // Exactly ONE OrderEvent of the markPaid-created type — not 10.
      const events = await prisma.orderEvent.findMany({ where: { orderId, type: 'payment_confirmed' } });
      expect(events).toHaveLength(1);

      // Product.stock unchanged from whatever it was after transition #1 —
      // proves markPaid (and this webhook path) never touches stock, on
      // ANY of the 10 deliveries, not just the first.
      const product = await prisma.product.findUniqueOrThrow({ where: { id: productId } });
      expect(product.stock).toBe(stockAfterReservation);

      // Exactly ONE WebhookEvent row for this (provider, eventId) pair —
      // proves the unique-constraint-conflict path was really hit 9 times,
      // not that 10 rows somehow all succeeded some other way.
      const webhookEvents = await prisma.webhookEvent.findMany({
        where: { provider: 'wompi', eventId: 'txn-replay-1:1700000300' },
      });
      expect(webhookEvents).toHaveLength(1);
    });

    it('a DECLINED (FAILED) event -> paymentStatus FAILED, status stays PENDING, stock NOT restocked', async () => {
      const { tenantId } = await signUpWithTenant('webhooks-failed@demo.co', 'owner');
      await paymentsService.saveProviderCredentials(tenantId, 'wompi', FAKE_CREDS);
      const { orderId, orderNumber, productId, stockAfterReservation } = await seedOrderWithProduct(tenantId);

      const payload = buildSignedWebhookPayload({
        transactionId: 'txn-failed-1',
        status: 'DECLINED',
        amountInCents: 30_000,
        reference: String(orderNumber),
        timestamp: 1_700_000_400,
        eventsSecret: FAKE_CREDS.eventsSecret,
      });

      const res = await postWebhook(tenantId, payload);
      expect(res.status).toBe(200);

      const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      expect(order.paymentStatus).toBe('FAILED');
      expect(order.status).toBe('PENDING'); // NOT cancelled — the shopper may retry
      expect(order.stockReservedUntil).not.toBeNull(); // reservation left as-is (expiry job's job, Task 6)

      // Stock is NOT restocked by this path — that's explicitly the expiry
      // job's job (Task 6, not built yet), never the webhook's.
      const product = await prisma.product.findUniqueOrThrow({ where: { id: productId } });
      expect(product.stock).toBe(stockAfterReservation);

      const webhookEvents = await prisma.webhookEvent.findMany({ where: { provider: 'wompi', eventId: 'txn-failed-1:1700000400' } });
      expect(webhookEvents).toHaveLength(1);
      expect(webhookEvents[0].result).toBe('failed');
    });

    it('a late-arriving DECLINED event for an EARLIER attempt does NOT clobber an order already CONFIRMED/PAID by a LATER attempt', async () => {
      // Regression test: a shopper's first checkout attempt is declined, they
      // retry and succeed — Wompi delivers the APPROVED webhook for the
      // retry before the DECLINED webhook for the original attempt (a
      // perfectly ordinary delivery-order race, not a contrived edge case).
      // Both events carry the SAME order `reference` but DIFFERENT
      // transaction ids (two distinct attempts), so neither is a replay of
      // the other — both must be processed as genuinely new events, but the
      // order's final state must reflect reality (paid), not whichever
      // event happened to arrive last.
      const { tenantId } = await signUpWithTenant('webhooks-late-failed@demo.co', 'owner');
      await paymentsService.saveProviderCredentials(tenantId, 'wompi', FAKE_CREDS);
      const { orderId, orderNumber, productId, stockAfterReservation } = await seedOrderWithProduct(tenantId);

      const approvedPayload = buildSignedWebhookPayload({
        transactionId: 'txn-retry-success',
        status: 'APPROVED',
        amountInCents: 30_000,
        reference: String(orderNumber),
        timestamp: 1_700_000_500,
        eventsSecret: FAKE_CREDS.eventsSecret,
      });
      const approvedRes = await postWebhook(tenantId, approvedPayload);
      expect(approvedRes.status).toBe(200);

      let order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      expect(order.status).toBe('CONFIRMED');
      expect(order.paymentStatus).toBe('PAID');

      // The earlier attempt's DECLINED webhook arrives AFTER the order is
      // already confirmed/paid — a different transaction id, so this is a
      // genuinely new event (not caught by the WebhookEvent replay guard),
      // but it must still be a safe no-op on the order itself.
      const declinedPayload = buildSignedWebhookPayload({
        transactionId: 'txn-retry-original-declined',
        status: 'DECLINED',
        amountInCents: 30_000,
        reference: String(orderNumber),
        timestamp: 1_700_000_490,
        eventsSecret: FAKE_CREDS.eventsSecret,
      });
      const declinedRes = await postWebhook(tenantId, declinedPayload);
      expect(declinedRes.status).toBe(200);

      order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      expect(order.status).toBe('CONFIRMED');
      expect(order.paymentStatus).toBe('PAID'); // must NOT have been clobbered back to FAILED

      const product = await prisma.product.findUniqueOrThrow({ where: { id: productId } });
      expect(product.stock).toBe(stockAfterReservation); // untouched by either event

      // Both events were genuinely distinct and both durably recorded.
      const confirmedEvents = await prisma.orderEvent.findMany({ where: { orderId, type: 'payment_confirmed' } });
      expect(confirmedEvents).toHaveLength(1);
      const failedEvents = await prisma.orderEvent.findMany({ where: { orderId, type: 'payment_failed' } });
      expect(failedEvents).toHaveLength(0); // markFailed's precondition made this a no-op — no event written
    });

    it('a verified event whose reference matches no order for this tenant -> 200, no mutation, WebhookEvent.result reflects the anomaly', async () => {
      const { tenantId } = await signUpWithTenant('webhooks-order-not-found@demo.co', 'owner');
      await paymentsService.saveProviderCredentials(tenantId, 'wompi', FAKE_CREDS);

      const payload = buildSignedWebhookPayload({
        transactionId: 'txn-no-order',
        status: 'APPROVED',
        amountInCents: 30_000,
        reference: '999999', // no Order with this number exists for this tenant
        timestamp: 1_700_000_500,
        eventsSecret: FAKE_CREDS.eventsSecret,
      });

      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const res = await postWebhook(tenantId, payload);
      expect(res.status).toBe(200);
      expect(errorSpy).toHaveBeenCalled();

      const webhookEvents = await prisma.webhookEvent.findMany({ where: { provider: 'wompi', eventId: 'txn-no-order:1700000500' } });
      expect(webhookEvents).toHaveLength(1);
      expect(webhookEvents[0].processedAt).not.toBeNull();
      expect(webhookEvents[0].result).toBe('order_not_found');
    });

    it('a PENDING-status event -> 200, WebhookEvent durably recorded with a noop result, no order mutation', async () => {
      const { tenantId } = await signUpWithTenant('webhooks-pending-status@demo.co', 'owner');
      await paymentsService.saveProviderCredentials(tenantId, 'wompi', FAKE_CREDS);
      const { orderId, orderNumber } = await seedOrderWithProduct(tenantId);

      const payload = buildSignedWebhookPayload({
        transactionId: 'txn-pending-status',
        status: 'PENDING',
        amountInCents: 30_000,
        reference: String(orderNumber),
        timestamp: 1_700_000_600,
        eventsSecret: FAKE_CREDS.eventsSecret,
      });

      const res = await postWebhook(tenantId, payload);
      expect(res.status).toBe(200);

      const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      expect(order.status).toBe('PENDING');
      expect(order.paymentStatus).toBe('PENDING');

      const webhookEvents = await prisma.webhookEvent.findMany({
        where: { provider: 'wompi', eventId: 'txn-pending-status:1700000600' },
      });
      expect(webhookEvents).toHaveLength(1);
      expect(webhookEvents[0].result).toBe('noop_pending');
    });
  });

  describe('invalid signature', () => {
    it('tampered checksum -> 401, order untouched, the rejection is logged', async () => {
      const { tenantId } = await signUpWithTenant('webhooks-invalid-sig@demo.co', 'owner');
      await paymentsService.saveProviderCredentials(tenantId, 'wompi', FAKE_CREDS);
      const { orderId, orderNumber } = await seedOrderWithProduct(tenantId);

      const payload = buildSignedWebhookPayload({
        transactionId: 'txn-tampered-1',
        status: 'APPROVED',
        amountInCents: 30_000,
        reference: String(orderNumber),
        timestamp: 1_700_000_700,
        eventsSecret: FAKE_CREDS.eventsSecret,
      });
      payload.signature.checksum =
        payload.signature.checksum.slice(0, -1) + (payload.signature.checksum.endsWith('0') ? '1' : '0');

      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const res = await postWebhook(tenantId, payload);

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'WEBHOOK_INVALID_SIGNATURE' });
      // Per spec's explicit AC: the raw payload is still logged even though
      // it's rejected.
      expect(errorSpy).toHaveBeenCalled();
      const loggedArgs = errorSpy.mock.calls.map((call) => JSON.stringify(call));
      expect(loggedArgs.some((entry) => entry.includes('txn-tampered-1'))).toBe(true);

      const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      expect(order.status).toBe('PENDING');
      expect(order.paymentStatus).toBe('PENDING');

      // A rejected/unverified event is NOT recorded as a WebhookEvent row —
      // WebhookEvent's whole purpose (per its schema and design decision 9)
      // is idempotency tracking for events this handler actually acted on;
      // an event that never passed signature verification was never acted
      // on, so no eventId can even be trusted to attribute a row to.
      // Logging (asserted above) is the durable trace of a rejected
      // delivery, not a DB row.
      const webhookEvents = await prisma.webhookEvent.findMany({
        where: { provider: 'wompi', eventId: 'txn-tampered-1:1700000700' },
      });
      expect(webhookEvents).toHaveLength(0);
    });
  });
});
