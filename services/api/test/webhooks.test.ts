import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash, createHmac, randomUUID } from 'node:crypto';
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

// Same shape as packages/payments/test/epayco.test.ts's own `cfg` fixture —
// duplicated here for the same cross-package-import-friction reason
// documented on buildSignedWebhookPayload below.
const FAKE_EPAYCO_CREDS = {
  publicKey: 'pub_test_epayco_abc123',
  privateKey: 'priv_test_epayco_abc123',
  eventsSecret: 'test_epayco_p_key_secret',
  epaycoCustomerId: '1234567',
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
  /** `data.transaction.currency`; defaults to `'COP'`, `null` omits the field.
   * Deliberately NOT part of the checksum — Wompi's `signature.properties`
   * never lists it, so an attacker can set it freely on an otherwise valid
   * payload. See the currency describe block below. */
  currency?: string | null;
}) {
  const properties = opts.properties ?? [
    'transaction.id',
    'transaction.status',
    'transaction.amount_in_cents',
    'transaction.reference',
  ];
  const currency = opts.currency === undefined ? 'COP' : opts.currency;
  const data = {
    transaction: {
      id: opts.transactionId,
      status: opts.status,
      amount_in_cents: opts.amountInCents,
      reference: opts.reference,
      ...(currency === null ? {} : { currency }),
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

/** Builds a validly-signed, form-urlencoded ePayco confirmation and POSTs it
 * to the REAL running app (not JSON — see epayco.ts's own module doc comment
 * on ePayco's real content-type). Same signing formula as
 * packages/payments/test/epayco.test.ts's own `buildSignedWebhookRequest`,
 * recomputed independently here rather than imported (same cross-package
 * test-helper-duplication convention as buildSignedWebhookPayload above). */
async function postEpaycoWebhook(
  tenantId: string,
  opts: {
    xRefPayco: string;
    xTransactionId: string;
    xAmount: string;
    xCurrencyCode: string;
    xResponse: string;
    xExtra1: string;
    epaycoCustomerId: string;
    eventsSecret: string;
  },
) {
  const signature = sha256Hex(
    `${opts.epaycoCustomerId}^${opts.eventsSecret}^${opts.xRefPayco}^${opts.xTransactionId}^${opts.xAmount}^${opts.xCurrencyCode}`,
  );
  const fields = {
    x_ref_payco: opts.xRefPayco,
    x_transaction_id: opts.xTransactionId,
    x_amount: opts.xAmount,
    x_currency_code: opts.xCurrencyCode,
    x_response: opts.xResponse,
    x_extra1: opts.xExtra1,
    x_signature: signature,
  };
  const rawBody = new URLSearchParams(fields).toString();
  return request(app.getHttpServer())
    .post(`/webhooks/payments/epayco/${tenantId}`)
    .set('Content-Type', 'application/x-www-form-urlencoded')
    .send(rawBody);
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

/** Seeds a bare PENDING/PENDING order with an EXPLICIT number and total —
 * `seedOrderWithProduct` above always uses a global sequence and derives the
 * total from a fixed unit price, but the P3 wave-1 security regression tests
 * below need to pin both values exactly (the Wompi checksum-aliasing pair
 * needs the specific numbers `(50000000, 1042)` / `(5000000010, 42)`, and the
 * cross-tenant tests need the SAME order number in two different tenants at
 * two different totals). No product/stock is involved: none of these tests
 * asserts anything about stock, and every one of them expects the order NOT to
 * be settled. */
async function seedOrderWithNumberAndTotal(
  tenantId: string,
  opts: {
    number: number;
    totalCents: number;
    /** Overridable so the "the order was no longer settleable" tests can seed
     * the states `markPaid`/`markFailed` refuse to transition from
     * (CANCELLED/EXPIRED, CONFIRMED/PAID) — every other caller wants the
     * PENDING/PENDING default. */
    status?: string;
    paymentStatus?: string;
    stockReservedUntil?: Date | null;
  },
): Promise<{ orderId: string }> {
  const order = await prisma.order.create({
    data: {
      tenantId,
      number: opts.number,
      status: opts.status ?? 'PENDING',
      paymentStatus: opts.paymentStatus ?? 'PENDING',
      paymentProvider: 'wompi',
      stockReservedUntil:
        opts.stockReservedUntil === undefined ? new Date(Date.now() + 15 * 60_000) : opts.stockReservedUntil,
      email: 'comprador@example.com',
      phone: '3000000000',
      shippingAddress: {},
      subtotalCents: opts.totalCents,
      taxCents: 0,
      totalCents: opts.totalCents,
    },
  });
  return { orderId: order.id };
}

/** Builds a Mercado Pago-shaped, validly-signed webhook delivery for the real
 * HTTP path (MP signs an `x-signature` HEADER over a manifest, not the body —
 * see packages/payments/src/mercadopago.ts). Recomputed here independently of
 * the adapter, same convention as `buildSignedWebhookPayload` above. */
async function postMercadoPagoWebhook(
  tenantId: string,
  opts: { paymentId: string; ts: string; requestId: string; eventsSecret: string },
) {
  const manifest = `id:${opts.paymentId};request-id:${opts.requestId};ts:${opts.ts};`;
  const v1 = createHmac('sha256', opts.eventsSecret).update(manifest, 'utf8').digest('hex');
  return request(app.getHttpServer())
    .post(`/webhooks/payments/mercadopago/${tenantId}`)
    .set('Content-Type', 'application/json')
    .set('x-signature', `ts=${opts.ts},v1=${v1}`)
    .set('x-request-id', opts.requestId)
    .send(JSON.stringify({ type: 'payment', data: { id: opts.paymentId } }));
}

/** Stubs the global `fetch` the adapters use for their gateway lookups (both
 * Mercado Pago's mandatory payment lookup and ePayco's re-verification call
 * default to it). The API under test runs in THIS process, so a plain
 * `vi.spyOn(globalThis, 'fetch')` reaches it; `afterEach`'s
 * `vi.restoreAllMocks()` puts the real one back. */
function stubGatewayFetch(handler: (url: string) => unknown) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return new Response(JSON.stringify(handler(url)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
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

  it('malformed/nonexistent :tenantId -> 401 WEBHOOK_INVALID_SIGNATURE, not an uncaught 500', async () => {
    // Reviewer-found gap: getTenantProviderConfig resolves the tenant via
    // tenantDb(tenantId).tenant.findUniqueOrThrow, which throws Prisma's
    // NotFoundError for a UUID-shaped-but-nonexistent id (or a UUID cast
    // error for outright garbage) — before this fix, neither case was
    // caught, so this public, unauthenticated, internet-facing route (bound
    // to see scanner/garbage traffic in production) 500'd instead of
    // responding the same way a real "no provider configured" case already
    // does. Two shapes of bad id, both must degrade the same way.
    const payload = buildSignedWebhookPayload({
      transactionId: 'txn-bad-tenant',
      status: 'APPROVED',
      amountInCents: 30_000,
      reference: '1',
      timestamp: 1_700_000_150,
      eventsSecret: 'whatever-secret-nobody-saved',
    });

    const wellFormedButNonexistent = await postWebhook('00000000-0000-0000-0000-000000000000', payload);
    expect(wellFormedButNonexistent.status).toBe(401);
    expect(wellFormedButNonexistent.body).toEqual({ error: 'WEBHOOK_INVALID_SIGNATURE' });

    const outrightGarbage = await postWebhook('not-a-uuid-at-all', payload);
    expect(outrightGarbage.status).toBe(401);
    expect(outrightGarbage.body).toEqual({ error: 'WEBHOOK_INVALID_SIGNATURE' });
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

  // Regression coverage for a real bug found live during P3b Task 7's smoke
  // test: every prior test in this file posts a JSON body (Wompi's real
  // shape) — ePayco's real confirmation POST is
  // application/x-www-form-urlencoded (see epayco.ts's own module doc
  // comment), which the controller's unconditional
  // `JSON.parse(rawBody.toString('utf8'))` (building the durable
  // WebhookEvent.payload audit record) 500'd on for every genuine ePayco
  // delivery, even after a fully valid signature check. No test caught this
  // before now because this file — the only full-HTTP-path webhook
  // controller suite — never exercised ePayco at all; packages/payments/
  // test/epayco.test.ts only calls `verifyAndParseWebhook` directly, never
  // through this controller.
  describe('epayco form-urlencoded confirmation (regression: full HTTP path, not just verifyAndParseWebhook in isolation)', () => {
    it('validly-signed form-urlencoded confirmation -> 200 (not 500), order CONFIRMED/PAID, stock not decremented again', async () => {
      const { tenantId } = await signUpWithTenant('webhooks-epayco-happy@demo.co', 'owner');
      await paymentsService.saveProviderCredentials(tenantId, 'epayco', FAKE_EPAYCO_CREDS);
      const { orderId, orderNumber, productId, stockAfterReservation } = await seedOrderWithProduct(tenantId);

      // TWO deliberate changes to this pre-existing test, both forced by real
      // fixes rather than by test convenience:
      //  1. `xAmount` is now '300.00', not '30000.00'. ePayco's x_amount is
      //     in PESOS and this order's total is 30.000 CENTS = 300 pesos, so
      //     the original fixture described a payment 100x the order's value.
      //     Nothing read `amountCents` before, so it went unnoticed; the new
      //     unconditional amount check (fix 1) rejects it — correctly.
      //  2. ePayco's adapter now re-verifies every confirmation against the
      //     gateway's own record of the signed x_ref_payco (fix 1), so that
      //     lookup has to be stubbed. It agrees with the confirmation here;
      //     the disagreement cases have their own tests below.
      stubGatewayFetch(() => ({
        data: { x_response: 'Aceptada', x_extra1: String(orderNumber), x_amount: 300 },
      }));

      const res = await postEpaycoWebhook(tenantId, {
        xRefPayco: 'ref-epayco-happy-1',
        xTransactionId: 'txn-epayco-happy-1',
        xAmount: '300.00',
        xCurrencyCode: 'COP',
        xResponse: 'Aceptada',
        xExtra1: String(orderNumber),
        epaycoCustomerId: FAKE_EPAYCO_CREDS.epaycoCustomerId,
        eventsSecret: FAKE_EPAYCO_CREDS.eventsSecret,
      });

      expect(res.status).toBe(200);

      const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      expect(order.status).toBe('CONFIRMED');
      expect(order.paymentStatus).toBe('PAID');
      expect(order.stockReservedUntil).toBeNull();

      const product = await prisma.product.findUniqueOrThrow({ where: { id: productId } });
      expect(product.stock).toBe(stockAfterReservation);

      const webhookEvents = await prisma.webhookEvent.findMany({
        // eventId now composes the RESOLVED status too — see epayco.ts's
        // own comment (same reasoning as mercadopago.ts's fix 3).
        where: { provider: 'epayco', eventId: 'ref-epayco-happy-1:txn-epayco-happy-1:PAID' },
      });
      expect(webhookEvents).toHaveLength(1);
      expect(webhookEvents[0].result).toBe('confirmed');
      // The durable audit payload is the parsed FORM FIELDS (this fix's own
      // fallback path), not a JSON-parse failure swallowed into some other
      // shape — proves the fallback actually ran, not just that the request
      // happened to succeed some other way.
      expect(webhookEvents[0].payload).toMatchObject({ x_ref_payco: 'ref-epayco-happy-1', x_response: 'Aceptada' });
    });

    it('tampered x_signature -> 401, order untouched (form-urlencoded path still verifies correctly)', async () => {
      const { tenantId } = await signUpWithTenant('webhooks-epayco-tampered@demo.co', 'owner');
      await paymentsService.saveProviderCredentials(tenantId, 'epayco', FAKE_EPAYCO_CREDS);
      const { orderId, orderNumber } = await seedOrderWithProduct(tenantId);

      const goodSig = sha256Hex(
        `${FAKE_EPAYCO_CREDS.epaycoCustomerId}^${FAKE_EPAYCO_CREDS.eventsSecret}^ref-epayco-tampered-1^txn-epayco-tampered-1^30000.00^COP`,
      );
      const badSig = goodSig.slice(0, -1) + (goodSig.endsWith('0') ? '1' : '0');
      const fields = {
        x_ref_payco: 'ref-epayco-tampered-1',
        x_transaction_id: 'txn-epayco-tampered-1',
        x_amount: '30000.00',
        x_currency_code: 'COP',
        x_response: 'Aceptada',
        x_extra1: String(orderNumber),
        x_signature: badSig,
      };
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const res = await request(app.getHttpServer())
        .post(`/webhooks/payments/epayco/${tenantId}`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send(new URLSearchParams(fields).toString());

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'WEBHOOK_INVALID_SIGNATURE' });
      expect(errorSpy).toHaveBeenCalled();

      const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      expect(order.status).toBe('PENDING');
      expect(order.paymentStatus).toBe('PENDING');
    });
  });
});

// ---------------------------------------------------------------------------
// P3 wave-1 security regression suite.
//
// Every test below was written as a FAILING exploit against the shipped code
// first, then made to pass. They are the point of this change: each one
// reproduces a defect that was demonstrated end-to-end against a real Nest app
// on real Postgres, so a regression that silently reintroduces any of them
// fails here rather than in production.
// ---------------------------------------------------------------------------

describe('webhook settlement is bound to the order amount (fix 1)', () => {
  it('a verified Wompi event whose amount does not match the order total settles NOTHING and is recorded as a mismatch', async () => {
    const { tenantId } = await signUpWithTenant('webhooks-amount-mismatch@demo.co', 'owner');
    await paymentsService.saveProviderCredentials(tenantId, 'wompi', FAKE_CREDS);
    const { orderId } = await seedOrderWithNumberAndTotal(tenantId, { number: 5001, totalCents: 999_999_00 });

    // A perfectly valid, correctly-signed event — for a MUCH smaller amount
    // than the order it names. Before this fix, `amountCents` was computed by
    // every adapter and then read by nothing at all, so this settled.
    const payload = buildSignedWebhookPayload({
      transactionId: 'txn-amount-mismatch',
      status: 'APPROVED',
      amountInCents: 10_000,
      reference: '5001',
      timestamp: 1_700_100_100,
      eventsSecret: FAKE_CREDS.eventsSecret,
    });

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await postWebhook(tenantId, payload);

    // Recorded and acknowledged, never settled — see the controller's own
    // justification for 200-over-4xx here.
    expect(res.status).toBe(200);
    expect(errorSpy).toHaveBeenCalled();

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe('PENDING');
    expect(order.paymentStatus).toBe('PENDING');

    const events = await prisma.webhookEvent.findMany({
      where: { provider: 'wompi', eventId: 'txn-amount-mismatch:1700100100' },
    });
    expect(events).toHaveLength(1);
    expect(events[0].result).toBe('amount_mismatch');
    expect(events[0].processedAt).not.toBeNull();
  });

  it('a FAILED event whose amount does not match settles nothing either (the check is unconditional, not PAID-only)', async () => {
    const { tenantId } = await signUpWithTenant('webhooks-amount-mismatch-failed@demo.co', 'owner');
    await paymentsService.saveProviderCredentials(tenantId, 'wompi', FAKE_CREDS);
    const { orderId } = await seedOrderWithNumberAndTotal(tenantId, { number: 5002, totalCents: 30_000 });

    const payload = buildSignedWebhookPayload({
      transactionId: 'txn-amount-mismatch-failed',
      status: 'DECLINED',
      amountInCents: 999_999,
      reference: '5002',
      timestamp: 1_700_100_150,
      eventsSecret: FAKE_CREDS.eventsSecret,
    });

    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await postWebhook(tenantId, payload);
    expect(res.status).toBe(200);

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.paymentStatus).toBe('PENDING'); // NOT flipped to FAILED
    const events = await prisma.webhookEvent.findMany({
      where: { provider: 'wompi', eventId: 'txn-amount-mismatch-failed:1700100150' },
    });
    expect(events[0].result).toBe('amount_mismatch');
  });

  it("ePayco: a genuine signed 4-tuple replayed with only the two UNSIGNED fields swapped never settles the re-pointed order", async () => {
    // The reported CRITICAL exploit, end to end. ePayco's own signature
    // formula covers x_ref_payco/x_transaction_id/x_amount/x_currency_code —
    // NOT x_response and NOT x_extra1. So this posts a byte-for-byte valid
    // signature for a real 100-COP payment, with x_extra1 re-pointed at a
    // 999,999-COP order. Reproduced before the fix as `200 / PAID /
    // CONFIRMED`.
    const { tenantId } = await signUpWithTenant('webhooks-epayco-swap@demo.co', 'owner');
    await paymentsService.saveProviderCredentials(tenantId, 'epayco', FAKE_EPAYCO_CREDS);
    const { orderId } = await seedOrderWithNumberAndTotal(tenantId, { number: 6001, totalCents: 999_999_00 });

    // WORST CASE, deliberately: ePayco's lookup endpoint is unauthenticated
    // and ignores the config it is handed (a parallel review confirmed any
    // reference resolves globally), so this stub models a gateway that
    // cheerfully echoes back whatever the attacker re-pointed the
    // confirmation at. That removes the adapter's re-verification from the
    // picture entirely and leaves ONLY the controller's amount check standing
    // — which is exactly the property this test exists to pin.
    stubGatewayFetch(() => ({ data: { x_response: 'Aceptada', x_extra1: '6001', x_amount: 100 } }));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await postEpaycoWebhook(tenantId, {
      xRefPayco: 'ref-epayco-swap-1',
      xTransactionId: 'txn-epayco-swap-1',
      xAmount: '100.00', // 100 pesos = 10.000 cents; the order wants 99.999.900
      xCurrencyCode: 'COP',
      xResponse: 'Aceptada',
      xExtra1: '6001',
      epaycoCustomerId: FAKE_EPAYCO_CREDS.epaycoCustomerId,
      eventsSecret: FAKE_EPAYCO_CREDS.eventsSecret,
    });

    expect(res.status).toBe(200);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe('PENDING');
    expect(order.paymentStatus).toBe('PENDING');

    const events = await prisma.webhookEvent.findMany({ where: { provider: 'epayco', tenantId } });
    expect(events).toHaveLength(1);
    expect(events[0].result).toBe('amount_mismatch');
  });

  it('ePayco: when the gateway lookup contradicts the unsigned x_extra1, the delivery is rejected at verification (401)', async () => {
    // The adapter-level half of the same fix: the status and the reference are
    // re-read from ePayco's own record of the SIGNED x_ref_payco, so a
    // re-pointed x_extra1 that the gateway does not corroborate never even
    // reaches the controller.
    const { tenantId } = await signUpWithTenant('webhooks-epayco-lookup-disagrees@demo.co', 'owner');
    await paymentsService.saveProviderCredentials(tenantId, 'epayco', FAKE_EPAYCO_CREDS);
    const { orderId } = await seedOrderWithNumberAndTotal(tenantId, { number: 6002, totalCents: 10_000 });

    // The gateway says this transaction is for order 7777, not 6002.
    stubGatewayFetch(() => ({ data: { x_response: 'Aceptada', x_extra1: '7777', x_amount: 100 } }));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await postEpaycoWebhook(tenantId, {
      xRefPayco: 'ref-epayco-swap-2',
      xTransactionId: 'txn-epayco-swap-2',
      xAmount: '100.00',
      xCurrencyCode: 'COP',
      xResponse: 'Aceptada',
      xExtra1: '6002',
      epaycoCustomerId: FAKE_EPAYCO_CREDS.epaycoCustomerId,
      eventsSecret: FAKE_EPAYCO_CREDS.eventsSecret,
    });

    expect(res.status).toBe(401);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.paymentStatus).toBe('PENDING');
    // Nothing durable is written for a delivery that failed verification —
    // same posture as the existing tampered-checksum test.
    const events = await prisma.webhookEvent.findMany({ where: { provider: 'epayco', tenantId } });
    expect(events).toHaveLength(0);
  });
});

describe('webhook settlement is bound to the order CURRENCY (wave 3)', () => {
  // P3 wave 2 added a currency term to the RECONCILIATION path only, while
  // claiming the currency "now rides on" the settle paths generally. It did
  // not ride on this one: `NormalizedPaymentEvent` had no currency field and
  // this controller compared `amountCents` alone, so a payment of the same
  // NUMBER of units in another currency satisfied the check exactly as well as
  // the real one. Both observations below were reproduced live before the fix.

  it('ePayco: a confirmation whose SIGNED x_currency_code is USD settles nothing on a COP order', async () => {
    // Live observation 1. `x_currency_code` is one of the four fields ePayco's
    // own hash covers, so this is not even a forgery — a genuine, fully-signed
    // USD confirmation for the same NUMBER of units settled a COP order.
    const { tenantId } = await signUpWithTenant('webhooks-epayco-usd@demo.co', 'owner');
    await paymentsService.saveProviderCredentials(tenantId, 'epayco', FAKE_EPAYCO_CREDS);
    const { orderId } = await seedOrderWithNumberAndTotal(tenantId, { number: 6101, totalCents: 25_000 });

    // 250,00 USD — the same 25.000 minor units the order's total is, and
    // roughly 4.000x the money. The lookup corroborates reference and amount
    // and reports no currency of its own, so the adapter passes it through.
    stubGatewayFetch(() => ({ data: { x_response: 'Aceptada', x_extra1: '6101', x_amount: 250 } }));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await postEpaycoWebhook(tenantId, {
      xRefPayco: 'ref-epayco-usd-1',
      xTransactionId: 'txn-epayco-usd-1',
      xAmount: '250.00',
      xCurrencyCode: 'USD',
      xResponse: 'Aceptada',
      xExtra1: '6101',
      epaycoCustomerId: FAKE_EPAYCO_CREDS.epaycoCustomerId,
      eventsSecret: FAKE_EPAYCO_CREDS.eventsSecret,
    });

    expect(res.status).toBe(200);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe('PENDING');
    expect(order.paymentStatus).toBe('PENDING');

    const events = await prisma.webhookEvent.findMany({ where: { provider: 'epayco', tenantId } });
    expect(events).toHaveLength(1);
    expect(events[0].result).toBe('currency_mismatch');
    expect(events[0].processedAt).not.toBeNull();
  });

  it('Wompi: an event whose data.transaction.currency is USD settles nothing on a COP order', async () => {
    // Live observation 2. Worse than ePayco's case in one respect: Wompi's
    // `signature.properties` never covers `transaction.currency`, so this
    // value is FORGEABLE on an otherwise perfectly valid event — the helper
    // above builds exactly that (a valid checksum over the four signed paths,
    // with the currency rewritten). The check still catches it, and the
    // controller's amount check remains the load-bearing defence for Wompi.
    const { tenantId } = await signUpWithTenant('webhooks-wompi-usd@demo.co', 'owner');
    await paymentsService.saveProviderCredentials(tenantId, 'wompi', FAKE_CREDS);
    const { orderId } = await seedOrderWithNumberAndTotal(tenantId, { number: 6102, totalCents: 25_000 });

    const payload = buildSignedWebhookPayload({
      transactionId: 'txn-wompi-usd',
      status: 'APPROVED',
      amountInCents: 25_000,
      reference: '6102',
      timestamp: 1_700_100_200,
      eventsSecret: FAKE_CREDS.eventsSecret,
      currency: 'USD',
    });

    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await postWebhook(tenantId, payload);

    expect(res.status).toBe(200);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe('PENDING');
    expect(order.paymentStatus).toBe('PENDING');

    const events = await prisma.webhookEvent.findMany({
      where: { provider: 'wompi', eventId: 'txn-wompi-usd:1700100200' },
    });
    expect(events).toHaveLength(1);
    expect(events[0].result).toBe('currency_mismatch');
  });

  it('an event carrying NO currency at all settles nothing either (unverifiable is not a pass)', async () => {
    // Same rule the reconciliation path already enforces: a missing currency
    // is a rejection, not a partial pass, because a bare amount is not a
    // quantity of money. Recorded under its own `result` so an operator can
    // tell "wrong currency" from "this gateway stopped sending one" — the
    // second would be a shape regression worth chasing, not an attack.
    const { tenantId } = await signUpWithTenant('webhooks-no-currency@demo.co', 'owner');
    await paymentsService.saveProviderCredentials(tenantId, 'wompi', FAKE_CREDS);
    const { orderId } = await seedOrderWithNumberAndTotal(tenantId, { number: 6103, totalCents: 25_000 });

    const payload = buildSignedWebhookPayload({
      transactionId: 'txn-wompi-no-currency',
      status: 'APPROVED',
      amountInCents: 25_000,
      reference: '6103',
      timestamp: 1_700_100_250,
      eventsSecret: FAKE_CREDS.eventsSecret,
      currency: null,
    });

    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await postWebhook(tenantId, payload);

    expect(res.status).toBe(200);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.paymentStatus).toBe('PENDING');
    const events = await prisma.webhookEvent.findMany({
      where: { provider: 'wompi', eventId: 'txn-wompi-no-currency:1700100250' },
    });
    expect(events[0].result).toBe('currency_unknown');
  });

  it('the currency check is unconditional: a FAILED event in another currency does not flip the order to FAILED either', async () => {
    const { tenantId } = await signUpWithTenant('webhooks-usd-failed@demo.co', 'owner');
    await paymentsService.saveProviderCredentials(tenantId, 'wompi', FAKE_CREDS);
    const { orderId } = await seedOrderWithNumberAndTotal(tenantId, { number: 6104, totalCents: 25_000 });

    const payload = buildSignedWebhookPayload({
      transactionId: 'txn-wompi-usd-declined',
      status: 'DECLINED',
      amountInCents: 25_000,
      reference: '6104',
      timestamp: 1_700_100_300,
      eventsSecret: FAKE_CREDS.eventsSecret,
      currency: 'USD',
    });

    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await postWebhook(tenantId, payload)).status).toBe(200);

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.paymentStatus).toBe('PENDING');
    const events = await prisma.webhookEvent.findMany({
      where: { provider: 'wompi', eventId: 'txn-wompi-usd-declined:1700100300' },
    });
    expect(events[0].result).toBe('currency_mismatch');
  });

  it('a COP event with a matching amount still settles normally (the check does not over-reject)', async () => {
    const { tenantId } = await signUpWithTenant('webhooks-cop-settles@demo.co', 'owner');
    await paymentsService.saveProviderCredentials(tenantId, 'wompi', FAKE_CREDS);
    const { orderId, orderNumber } = await seedOrderWithProduct(tenantId); // totalCents 30_000

    const payload = buildSignedWebhookPayload({
      transactionId: 'txn-wompi-cop-ok',
      status: 'APPROVED',
      amountInCents: 30_000,
      reference: String(orderNumber),
      timestamp: 1_700_100_350,
      eventsSecret: FAKE_CREDS.eventsSecret,
    });

    expect((await postWebhook(tenantId, payload)).status).toBe(200);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe('CONFIRMED');
    expect(order.paymentStatus).toBe('PAID');
  });
});

describe('a valid payment landing on an order that can no longer be settled (wave 3)', () => {
  // The audit trail used to LIE about this, which is the whole point of the
  // `result` column: `markPaid` silently no-ops outside its PENDING
  // precondition, so a genuine PAID webhook for a CANCELLED/EXPIRED order
  // returned 200 and durably recorded `result: 'confirmed'` while the order
  // was untouched and ZERO OrderEvents were written. The shopper is charged,
  // the order is gone, and the one operator-facing string says it went fine.
  it('a genuine PAID webhook on a CANCELLED/EXPIRED order records that it settled NOTHING', async () => {
    const { tenantId } = await signUpWithTenant('webhooks-paid-on-cancelled@demo.co', 'owner');
    await paymentsService.saveProviderCredentials(tenantId, 'wompi', FAKE_CREDS);
    // Exactly what the 15-minute stock-reservation expiry worker leaves behind.
    const { orderId } = await seedOrderWithNumberAndTotal(tenantId, {
      number: 7001,
      totalCents: 30_000,
      status: 'CANCELLED',
      paymentStatus: 'EXPIRED',
      stockReservedUntil: null,
    });

    const payload = buildSignedWebhookPayload({
      transactionId: 'txn-paid-too-late',
      status: 'APPROVED',
      amountInCents: 30_000,
      reference: '7001',
      timestamp: 1_700_200_100,
      eventsSecret: FAKE_CREDS.eventsSecret,
    });

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await postWebhook(tenantId, payload);

    // Still 200 — the delivery WAS received and durably recorded, and no
    // retry could change the outcome (same reasoning as every other
    // recorded-but-not-actionable branch).
    expect(res.status).toBe(200);

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe('CANCELLED');
    expect(order.paymentStatus).toBe('EXPIRED');

    const events = await prisma.webhookEvent.findMany({
      where: { provider: 'wompi', eventId: 'txn-paid-too-late:1700200100' },
    });
    expect(events).toHaveLength(1);
    // The core of the fix: NOT 'confirmed'.
    expect(events[0].result).toBe('paid_order_not_settleable');
    expect(events[0].processedAt).not.toBeNull();
    // And it is loud: a human has to be able to find these, because it means
    // a shopper paid and has nothing.
    expect(errorSpy).toHaveBeenCalled();
  });

  it('a late FAILED webhook on an order that is already CONFIRMED/PAID is recorded as applying nothing', async () => {
    const { tenantId } = await signUpWithTenant('webhooks-failed-on-paid@demo.co', 'owner');
    await paymentsService.saveProviderCredentials(tenantId, 'wompi', FAKE_CREDS);
    const { orderId } = await seedOrderWithNumberAndTotal(tenantId, {
      number: 7002,
      totalCents: 30_000,
      status: 'CONFIRMED',
      paymentStatus: 'PAID',
      stockReservedUntil: null,
    });

    const payload = buildSignedWebhookPayload({
      transactionId: 'txn-failed-too-late',
      status: 'DECLINED',
      amountInCents: 30_000,
      reference: '7002',
      timestamp: 1_700_200_200,
      eventsSecret: FAKE_CREDS.eventsSecret,
    });

    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await postWebhook(tenantId, payload)).status).toBe(200);

    // markFailed's precondition is deliberately NOT widened (a later FAILED
    // must never un-settle a PAID order) — the only thing that changes is
    // that the record no longer claims the order was flipped to FAILED.
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.paymentStatus).toBe('PAID');
    const events = await prisma.webhookEvent.findMany({
      where: { provider: 'wompi', eventId: 'txn-failed-too-late:1700200200' },
    });
    expect(events[0].result).toBe('failed_not_applied');
  });

  it('the ordinary PAID and FAILED paths still record confirmed/failed (the new strings are for the no-op case only)', async () => {
    const { tenantId } = await signUpWithTenant('webhooks-normal-results@demo.co', 'owner');
    await paymentsService.saveProviderCredentials(tenantId, 'wompi', FAKE_CREDS);
    const { orderId } = await seedOrderWithNumberAndTotal(tenantId, { number: 7003, totalCents: 30_000 });

    const declined = buildSignedWebhookPayload({
      transactionId: 'txn-attempt-1',
      status: 'DECLINED',
      amountInCents: 30_000,
      reference: '7003',
      timestamp: 1_700_200_300,
      eventsSecret: FAKE_CREDS.eventsSecret,
    });
    expect((await postWebhook(tenantId, declined)).status).toBe(200);
    expect(
      (await prisma.webhookEvent.findFirstOrThrow({ where: { eventId: 'txn-attempt-1:1700200300' } })).result,
    ).toBe('failed');

    // The shopper retries and the retry goes through (wave-2 FIX 1's flow).
    const approved = buildSignedWebhookPayload({
      transactionId: 'txn-attempt-2',
      status: 'APPROVED',
      amountInCents: 30_000,
      reference: '7003',
      timestamp: 1_700_200_400,
      eventsSecret: FAKE_CREDS.eventsSecret,
    });
    expect((await postWebhook(tenantId, approved)).status).toBe(200);
    expect(
      (await prisma.webhookEvent.findFirstOrThrow({ where: { eventId: 'txn-attempt-2:1700200400' } })).result,
    ).toBe('confirmed');

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe('CONFIRMED');
    expect(order.paymentStatus).toBe('PAID');
  });
});

describe("Wompi's undelimited checksum concatenation cannot be re-split into another order (fix 2)", () => {
  it('the exact reported aliasing pair — (50000000, 1042) vs (5000000010, 42) — shares one valid checksum, and the amount check stops it', async () => {
    const { tenantId } = await signUpWithTenant('webhooks-checksum-aliasing@demo.co', 'owner');
    await paymentsService.saveProviderCredentials(tenantId, 'wompi', FAKE_CREDS);
    // The real, expensive order the genuine event is about...
    const genuine = await seedOrderWithNumberAndTotal(tenantId, { number: 1042, totalCents: 50_000_000 });
    // ...and the cheap order the forged re-split points at (10 COP).
    const victim = await seedOrderWithNumberAndTotal(tenantId, { number: 42, totalCents: 10 });

    const genuinePayload = buildSignedWebhookPayload({
      transactionId: 'txn-alias',
      status: 'APPROVED',
      amountInCents: 50_000_000,
      reference: '1042',
      timestamp: 1_700_200_100,
      eventsSecret: FAKE_CREDS.eventsSecret,
    });

    // Re-split: `join('')` over id + status + amount + reference means
    // "50000000" + "1042" and "5000000010" + "42" are the SAME BYTES, so the
    // genuine checksum is copied over verbatim and still verifies. This is
    // Wompi's documented formula, so the hash is deliberately NOT changed —
    // the sanity assertion below proves the aliasing is real, and the order
    // assertions prove the amount check is what neutralizes it.
    const forgedPayload = buildSignedWebhookPayload({
      transactionId: 'txn-alias',
      status: 'APPROVED',
      amountInCents: 5_000_000_010,
      reference: '42',
      timestamp: 1_700_200_100,
      eventsSecret: FAKE_CREDS.eventsSecret,
    });
    expect(forgedPayload.signature.checksum).toBe(genuinePayload.signature.checksum);

    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await postWebhook(tenantId, forgedPayload);

    // NOT a 401: the signature genuinely verifies. The defense is the amount.
    expect(res.status).toBe(200);
    const victimOrder = await prisma.order.findUniqueOrThrow({ where: { id: victim.orderId } });
    expect(victimOrder.status).toBe('PENDING');
    expect(victimOrder.paymentStatus).toBe('PENDING');
    const genuineOrder = await prisma.order.findUniqueOrThrow({ where: { id: genuine.orderId } });
    expect(genuineOrder.paymentStatus).toBe('PENDING'); // untouched too — this delivery named order 42

    const events = await prisma.webhookEvent.findMany({ where: { provider: 'wompi', tenantId } });
    expect(events).toHaveLength(1);
    expect(events[0].result).toBe('amount_mismatch');
  });
});

describe('Mercado Pago fires one notification per status change (fix 3)', () => {
  it('the later APPROVED notification for a payment first delivered as pending still settles the order', async () => {
    const { tenantId } = await signUpWithTenant('webhooks-mp-status-change@demo.co', 'owner');
    await paymentsService.saveProviderCredentials(tenantId, 'mercadopago', FAKE_CREDS);
    const { orderId, orderNumber } = await seedOrderWithProduct(tenantId); // totalCents 30_000

    // Delivery 1: MP notifies while the payment is still pending.
    stubGatewayFetch(() => ({
      id: 555000111,
      status: 'pending',
      transaction_amount: 300, // pesos -> 30.000 cents, matches the order
      external_reference: String(orderNumber),
      // A real MP payment resource always reports the currency its
      // `transaction_amount` is denominated in; these stubs predate the
      // webhook path reading one, and the controller now (correctly) refuses
      // to settle an event whose currency it cannot verify.
      currency_id: 'COP',
    }));
    const first = await postMercadoPagoWebhook(tenantId, {
      paymentId: '555000111',
      ts: '1742505638683',
      requestId: 'req-mp-1',
      eventsSecret: FAKE_CREDS.eventsSecret,
    });
    expect(first.status).toBe(200);
    let order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.paymentStatus).toBe('PENDING');

    vi.restoreAllMocks();

    // Delivery 2: the SAME payment id, now approved. Before this fix, both
    // deliveries composed eventId `555000111`, so this one hit the unique
    // constraint and returned 200 without ever settling — reproduced as
    // `r1=200 r2=200`, order stuck PENDING/PENDING, one event row.
    stubGatewayFetch(() => ({
      id: 555000111,
      status: 'approved',
      transaction_amount: 300,
      external_reference: String(orderNumber),
      currency_id: 'COP',
    }));
    const second = await postMercadoPagoWebhook(tenantId, {
      paymentId: '555000111',
      ts: '1742505699999',
      requestId: 'req-mp-2',
      eventsSecret: FAKE_CREDS.eventsSecret,
    });
    expect(second.status).toBe(200);

    order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe('CONFIRMED');
    expect(order.paymentStatus).toBe('PAID');

    const events = await prisma.webhookEvent.findMany({ where: { provider: 'mercadopago', tenantId } });
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.result).sort()).toEqual(['confirmed', 'noop_pending']);
  });

  it('a genuine redelivery of the SAME notification still dedupes to one state transition', async () => {
    const { tenantId } = await signUpWithTenant('webhooks-mp-redelivery@demo.co', 'owner');
    await paymentsService.saveProviderCredentials(tenantId, 'mercadopago', FAKE_CREDS);
    const { orderId, orderNumber } = await seedOrderWithProduct(tenantId);

    stubGatewayFetch(() => ({
      id: 555000222,
      status: 'approved',
      transaction_amount: 300,
      external_reference: String(orderNumber),
      currency_id: 'COP',
    }));

    // Same notification, twice — with the per-delivery values (x-request-id,
    // signature ts) DIFFERENT, which is what a real MP retry looks like.
    const r1 = await postMercadoPagoWebhook(tenantId, {
      paymentId: '555000222',
      ts: '1742505638683',
      requestId: 'req-mp-original',
      eventsSecret: FAKE_CREDS.eventsSecret,
    });
    const r2 = await postMercadoPagoWebhook(tenantId, {
      paymentId: '555000222',
      ts: '1742509999999',
      requestId: 'req-mp-retry',
      eventsSecret: FAKE_CREDS.eventsSecret,
    });
    expect([r1.status, r2.status]).toEqual([200, 200]);

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.paymentStatus).toBe('PAID');
    const events = await prisma.webhookEvent.findMany({ where: { provider: 'mercadopago', tenantId } });
    expect(events).toHaveLength(1);
    const orderEvents = await prisma.orderEvent.findMany({ where: { orderId, type: 'payment_confirmed' } });
    expect(orderEvents).toHaveLength(1);
  });
});

describe('idempotency is scoped per tenant (fix 4)', () => {
  it('one delivery sent to two tenants sharing a gateway account: the wrong tenant settles nothing, the real owner is NOT swallowed', async () => {
    // Two tenants on ONE gateway merchant account — an explicitly supported
    // shape — therefore sharing that account's eventsSecret, so the same
    // signed delivery verifies at EITHER tenant's webhook URL. `Order.number`
    // is per-tenant, so the same reference legitimately exists in both.
    const a = await signUpWithTenant('webhooks-shared-acct-a@demo.co', 'owner');
    const b = await signUpWithTenant('webhooks-shared-acct-b@demo.co', 'owner');
    await paymentsService.saveProviderCredentials(a.tenantId, 'wompi', FAKE_CREDS);
    await paymentsService.saveProviderCredentials(b.tenantId, 'wompi', FAKE_CREDS);

    const ownerOrder = await seedOrderWithNumberAndTotal(a.tenantId, { number: 8080, totalCents: 100_000 });
    const otherOrder = await seedOrderWithNumberAndTotal(b.tenantId, { number: 8080, totalCents: 7_000_000 });

    // Tenant A's genuine 1.000-COP payment.
    const payload = buildSignedWebhookPayload({
      transactionId: 'txn-shared-acct',
      status: 'APPROVED',
      amountInCents: 100_000,
      reference: '8080',
      timestamp: 1_700_300_100,
      eventsSecret: FAKE_CREDS.eventsSecret,
    });
    const raw = JSON.stringify(payload);
    const send = (tenantId: string) =>
      request(app.getHttpServer())
        .post(`/webhooks/payments/wompi/${tenantId}`)
        .set('Content-Type', 'application/json')
        .send(raw);

    vi.spyOn(console, 'error').mockImplementation(() => {});

    // (a) Delivered to tenant B FIRST — B's order 8080 is a 70.000-COP order,
    // so the amount check refuses. Before the fix this settled B's order.
    const toB = await send(b.tenantId);
    expect(toB.status).toBe(200);
    let bOrder = await prisma.order.findUniqueOrThrow({ where: { id: otherOrder.orderId } });
    expect(bOrder.status).toBe('PENDING');
    expect(bOrder.paymentStatus).toBe('PENDING');

    // (b) Then delivered to its REAL owner, tenant A. Before the fix, the
    // global `@@unique([provider, eventId])` had already been claimed by B's
    // row, so this — the legitimate delivery — was permanently swallowed as a
    // "replay" and A's order never settled.
    const toA = await send(a.tenantId);
    expect(toA.status).toBe(200);
    const aOrder = await prisma.order.findUniqueOrThrow({ where: { id: ownerOrder.orderId } });
    expect(aOrder.status).toBe('CONFIRMED');
    expect(aOrder.paymentStatus).toBe('PAID');

    bOrder = await prisma.order.findUniqueOrThrow({ where: { id: otherOrder.orderId } });
    expect(bOrder.paymentStatus).toBe('PENDING'); // still untouched

    // One row PER TENANT for the same (provider, eventId) — that is the
    // widened unique key doing its job.
    const rows = await prisma.webhookEvent.findMany({
      where: { provider: 'wompi', eventId: 'txn-shared-acct:1700300100' },
      orderBy: { createdAt: 'asc' },
    });
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.tenantId))).toEqual(new Set([a.tenantId, b.tenantId]));
    expect(rows.map((r) => r.result).sort()).toEqual(['amount_mismatch', 'confirmed']);
  });

  it('replays are still deduped WITHIN a tenant (the widened key did not weaken idempotency)', async () => {
    const { tenantId } = await signUpWithTenant('webhooks-tenant-scoped-replay@demo.co', 'owner');
    await paymentsService.saveProviderCredentials(tenantId, 'wompi', FAKE_CREDS);
    const { orderId, orderNumber } = await seedOrderWithProduct(tenantId);

    const payload = buildSignedWebhookPayload({
      transactionId: 'txn-scoped-replay',
      status: 'APPROVED',
      amountInCents: 30_000,
      reference: String(orderNumber),
      timestamp: 1_700_300_200,
      eventsSecret: FAKE_CREDS.eventsSecret,
    });
    const raw = JSON.stringify(payload);
    for (let i = 0; i < 5; i++) {
      const res = await request(app.getHttpServer())
        .post(`/webhooks/payments/wompi/${tenantId}`)
        .set('Content-Type', 'application/json')
        .send(raw);
      expect(res.status).toBe(200);
    }
    const rows = await prisma.webhookEvent.findMany({
      where: { provider: 'wompi', eventId: 'txn-scoped-replay:1700300200' },
    });
    expect(rows).toHaveLength(1);
    const orderEvents = await prisma.orderEvent.findMany({ where: { orderId, type: 'payment_confirmed' } });
    expect(orderEvents).toHaveLength(1);
  });
});

describe('a delivery whose processing threw is retried, not swallowed (fix 5)', () => {
  it('after markPaid throws, the gateway retry reprocesses the event instead of short-circuiting on P2002', async () => {
    const { tenantId } = await signUpWithTenant('webhooks-retry-after-throw@demo.co', 'owner');
    await paymentsService.saveProviderCredentials(tenantId, 'wompi', FAKE_CREDS);
    const { orderId, orderNumber } = await seedOrderWithProduct(tenantId);

    const payload = buildSignedWebhookPayload({
      transactionId: 'txn-throwing',
      status: 'APPROVED',
      amountInCents: 30_000,
      reference: String(orderNumber),
      timestamp: 1_700_400_100,
      eventsSecret: FAKE_CREDS.eventsSecret,
    });
    const raw = JSON.stringify(payload);

    // Simulate the DB blip / lock timeout the review describes.
    const markPaidSpy = vi
      .spyOn(paymentsService, 'markPaid')
      .mockRejectedValueOnce(new Error('simulated lock timeout'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const first = await request(app.getHttpServer())
      .post(`/webhooks/payments/wompi/${tenantId}`)
      .set('Content-Type', 'application/json')
      .send(raw);
    expect(first.status).toBe(500);

    // The idempotency row exists but was never marked processed.
    const afterFailure = await prisma.webhookEvent.findMany({
      where: { provider: 'wompi', eventId: 'txn-throwing:1700400100' },
    });
    expect(afterFailure).toHaveLength(1);
    expect(afterFailure[0].processedAt).toBeNull();

    markPaidSpy.mockRestore();

    // The gateway retries. Before this fix, the P2002 branch returned
    // `{ok:true}` without ever checking `processedAt`, so a genuinely paid
    // order stayed PENDING/PENDING forever.
    const retry = await request(app.getHttpServer())
      .post(`/webhooks/payments/wompi/${tenantId}`)
      .set('Content-Type', 'application/json')
      .send(raw);
    expect(retry.status).toBe(200);

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe('CONFIRMED');
    expect(order.paymentStatus).toBe('PAID');

    const rows = await prisma.webhookEvent.findMany({
      where: { provider: 'wompi', eventId: 'txn-throwing:1700400100' },
    });
    expect(rows).toHaveLength(1); // still exactly one row — no second insert
    expect(rows[0].processedAt).not.toBeNull();
    expect(rows[0].result).toBe('confirmed');

    // And a third delivery, now that it IS processed, short-circuits again.
    const third = await request(app.getHttpServer())
      .post(`/webhooks/payments/wompi/${tenantId}`)
      .set('Content-Type', 'application/json')
      .send(raw);
    expect(third.status).toBe(200);
    const orderEvents = await prisma.orderEvent.findMany({ where: { orderId, type: 'payment_confirmed' } });
    expect(orderEvents).toHaveLength(1);
  });
});

describe('reference parsing is strict and happens before the idempotency row is written (fix 6)', () => {
  it('a non-numeric reference no longer 500s after durably recording an unprocessable event', async () => {
    const { tenantId } = await signUpWithTenant('webhooks-bad-reference@demo.co', 'owner');
    await paymentsService.saveProviderCredentials(tenantId, 'wompi', FAKE_CREDS);

    const payload = buildSignedWebhookPayload({
      transactionId: 'txn-bad-ref',
      status: 'APPROVED',
      amountInCents: 30_000,
      reference: 'ORD-not-a-number',
      timestamp: 1_700_500_100,
      eventsSecret: FAKE_CREDS.eventsSecret,
    });

    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await postWebhook(tenantId, payload);

    // Before the fix: `Number('ORD-not-a-number')` -> NaN -> Prisma throws ->
    // 500, with the idempotency row ALREADY written, so every retry
    // short-circuited to 200 and a real payment could never be credited.
    expect(res.status).toBe(200);
    const rows = await prisma.webhookEvent.findMany({
      where: { provider: 'wompi', eventId: 'txn-bad-ref:1700500100' },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].result).toBe('invalid_reference');
    expect(rows[0].processedAt).not.toBeNull();
  });

  it('an all-digits reference too large for the int4 Order.number column is rejected, not 500d', async () => {
    // Same failure mode as the non-numeric case: Prisma THROWS when an Int
    // filter gets a value outside int4, so without the range half of the
    // guard this 500'd *after* the idempotency row was written and every
    // retry then short-circuited to 200.
    const { tenantId } = await signUpWithTenant('webhooks-huge-reference@demo.co', 'owner');
    await paymentsService.saveProviderCredentials(tenantId, 'wompi', FAKE_CREDS);

    const payload = buildSignedWebhookPayload({
      transactionId: 'txn-huge-ref',
      status: 'APPROVED',
      amountInCents: 30_000,
      reference: '99999999999999',
      timestamp: 1_700_500_300,
      eventsSecret: FAKE_CREDS.eventsSecret,
    });

    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await postWebhook(tenantId, payload);
    expect(res.status).toBe(200);

    const rows = await prisma.webhookEvent.findMany({
      where: { provider: 'wompi', eventId: 'txn-huge-ref:1700500300' },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].result).toBe('invalid_reference');
  });

  it.each([' 4242 ', '4242.0', '4.242e3', '0x1092', '+4242', ''])(
    'the coercible-but-wrong reference %j never resolves to order 4242',
    async (reference) => {
      const { tenantId } = await signUpWithTenant(
        `webhooks-coercible-${Buffer.from(reference).toString('hex')}@demo.co`,
        'owner',
      );
      await paymentsService.saveProviderCredentials(tenantId, 'wompi', FAKE_CREDS);
      const { orderId } = await seedOrderWithNumberAndTotal(tenantId, { number: 4242, totalCents: 30_000 });

      const payload = buildSignedWebhookPayload({
        transactionId: `txn-coercible-${Buffer.from(reference).toString('hex')}`,
        status: 'APPROVED',
        amountInCents: 30_000,
        reference,
        timestamp: 1_700_500_200,
        eventsSecret: FAKE_CREDS.eventsSecret,
      });

      vi.spyOn(console, 'error').mockImplementation(() => {});
      const res = await postWebhook(tenantId, payload);
      expect(res.status).toBe(200);

      const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      expect(order.status).toBe('PENDING');
      expect(order.paymentStatus).toBe('PENDING');

      const rows = await prisma.webhookEvent.findMany({ where: { provider: 'wompi', tenantId } });
      expect(rows).toHaveLength(1);
      expect(rows[0].result).toBe('invalid_reference');
    },
  );
});
