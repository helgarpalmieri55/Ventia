import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { generateOrderReference } from '@ventia/core';
import { createHash } from 'node:crypto';
import request from 'supertest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient as PrismaClientType, OrderStatus, PaymentStatus } from '@ventia/db';
import type {
  NormalizedStatus,
  PaymentProvider,
  PaymentProviderId,
  TransactionStatusResult,
} from '@ventia/payments';
import { startTestDb } from './helpers';
import type { signUpWithTenant as SignUpWithTenant } from './admin-helpers';
import type { reconcilePendingPayments as ReconcilePendingPayments } from '../src/payments/reconciliation.worker';
import type { PaymentsService as PaymentsServiceType } from '../src/payments/payments.service';

/**
 * The `Payment` ledger — the append-only, per-ATTEMPT record of what a payment
 * gateway said about money for one order (docs/SPEC.md §8; see the model's doc
 * comment in packages/db/prisma/schema.prisma for why it exists given `Order`
 * already carries payment state).
 *
 * ## Why this suite covers BOTH settle paths in one file
 *
 * There are exactly two things in this system that ever learn a gateway's
 * verdict on a payment: the signature-verified webhook receiver, and the
 * reconciliation sweep that pulls the same verdict out of the gateway's own API
 * when the webhook never arrived. A ledger only one of them wrote would be
 * worse than no ledger: silently incomplete while looking authoritative, and
 * missing precisely the rows from whichever path recovered a payment the other
 * one lost. Splitting these assertions across two files would let exactly that
 * regression pass, because each file would still be green. So the "both paths
 * write it" property is asserted here, side by side, against the same schema.
 *
 * Everything real except the gateway edge: real Postgres (testcontainers, real
 * migrations, real RLS/grants), the real Nest app from `createApp()`, real
 * webhook signature verification over real raw request bytes, real advisory
 * locks. Only the outbound HTTP to a gateway is faked — the same posture
 * webhooks.test.ts and reconciliation-worker.test.ts already take.
 */

let db: Awaited<ReturnType<typeof startTestDb>>;
let redisContainer: StartedTestContainer;
let app: INestApplication;
let signUpWithTenant: typeof SignUpWithTenant;
let prisma: PrismaClientType;
let paymentsService: PaymentsServiceType;
let reconcilePendingPayments: typeof ReconcilePendingPayments;

beforeAll(async () => {
  db = await startTestDb();
  redisContainer = await new GenericContainer('redis:7-alpine')
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
    .start();

  // Env vars must be set BEFORE the first import of @ventia/db / ../src/main /
  // ./admin-helpers — same pattern as webhooks.test.ts.
  process.env.DATABASE_URL = db.url;
  process.env.REDIS_URL = `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`;
  process.env.PAYMENTS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

  const { createApp } = await import('../src/main');
  app = await createApp();
  await app.init();

  ({ signUpWithTenant } = await import('./admin-helpers'));
  ({ platformDb: prisma } = (await import('@ventia/db')) as unknown as { platformDb: PrismaClientType });
  ({ reconcilePendingPayments } = await import('../src/payments/reconciliation.worker'));
  const { PaymentsService } = await import('../src/payments/payments.service');
  paymentsService = app.get(PaymentsService);
}, 180_000);

afterAll(async () => {
  await app.close();
  await redisContainer.stop();
  await db.stop();
});

afterEach(async () => {
  vi.restoreAllMocks();
  // Same hygiene as reconciliation-worker.test.ts: the sweep is deliberately
  // cross-tenant, so an order left PENDING with a live `stockReservedUntil`
  // would be picked up by every LATER test's sweep too and fed to that test's
  // scripted provider. Clearing the hold retires previous fixtures from the
  // candidate query without touching status/paymentStatus. Runs AFTER each
  // test's own assertions, so it can never mask a failure.
  await prisma.order.updateMany({ data: { stockReservedUntil: null } });
});

const FAKE_WOMPI_CREDS = {
  publicKey: 'pub_test_ABCDEFGHIJKLMNOPQRSTUV',
  privateKey: 'prv_test_ZYXWVUTSRQPONMLKJIHGFEDCBA0123456789',
  integritySecret: 'test_integrity_abc123def456',
  eventsSecret: 'test_events_ghi789jkl012',
  sandbox: true,
};

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** A Wompi-shaped, validly-signed webhook payload. Same algorithm as
 * webhooks.test.ts's own helper and packages/payments/test/wompi.test.ts's —
 * duplicated rather than imported, per this repo's established convention for
 * small cross-package/cross-file test helpers (see test/helpers.ts's own doc
 * comment). Wompi's `eventId` is `${transaction.id}:${timestamp}`, so two
 * attempts with different transaction ids are two different events and neither
 * is swallowed by the idempotency key. */
function buildSignedWebhookPayload(opts: {
  transactionId: string;
  status: string;
  amountInCents: number;
  reference: string;
  timestamp: number;
  eventsSecret: string;
  currency?: string;
}) {
  const properties = [
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
      currency: opts.currency ?? 'COP',
    },
  };
  const concatenated =
    `${data.transaction.id}${data.transaction.status}${data.transaction.amount_in_cents}${data.transaction.reference}` +
    String(opts.timestamp) +
    opts.eventsSecret;
  return {
    event: 'transaction.updated',
    data,
    signature: { properties, checksum: sha256Hex(concatenated) },
    timestamp: opts.timestamp,
    sent_at: new Date(opts.timestamp * 1000).toISOString(),
  };
}

/** POSTs the EXACT JSON.stringify'd string as the body (not an object), so the
 * checksum is verified against the same bytes a real gateway would have sent —
 * superagent re-serializes object payloads but sends string ones byte-for-byte. */
async function postWompiWebhook(tenantId: string, payload: unknown) {
  return request(app.getHttpServer())
    .post(`/webhooks/payments/wompi/${tenantId}`)
    .set('Content-Type', 'application/json')
    .send(JSON.stringify(payload));
}

let orderNumberSeq = 7000;

interface SeedOpts {
  totalCents?: number;
  status?: OrderStatus;
  paymentStatus?: PaymentStatus;
  provider?: string | null;
  providerRef?: string | null;
  /** Minutes in the PAST — real timestamps, so the reconciliation sweep's
   * 5-minute floor is exercised for real rather than against a faked clock. */
  ageMinutes?: number;
  /** Minutes in the FUTURE the 15-minute stock hold still runs; `null` = no
   * active reservation, which takes the order out of the sweep entirely. */
  reservedForMinutes?: number | null;
}

async function seedOrder(tenantId: string, opts: SeedOpts = {}) {
  const now = Date.now();
  const reference = generateOrderReference();
  const totalCents = opts.totalCents ?? 25_000;
  const order = await prisma.order.create({
    data: {
      tenantId,
      number: orderNumberSeq++,
      reference,
      status: opts.status ?? 'PENDING',
      paymentStatus: opts.paymentStatus ?? 'PENDING',
      paymentProvider: opts.provider === undefined ? 'wompi' : opts.provider,
      providerRef: opts.providerRef ?? null,
      providerRefSource: opts.providerRef ? 'verified' : null,
      stockReservedUntil:
        opts.reservedForMinutes === null || opts.reservedForMinutes === undefined
          ? null
          : new Date(now + opts.reservedForMinutes * 60_000),
      createdAt: new Date(now - (opts.ageMinutes ?? 0) * 60_000),
      email: 'comprador@example.com',
      phone: '3000000000',
      shippingAddress: {},
      subtotalCents: totalCents,
      taxCents: 0,
      totalCents,
    },
  });
  return { orderId: order.id, reference, totalCents };
}

/** The ledger rows for ONE order, oldest first. Read through `platformDb`
 * because these tests assert on rows across tenants and outside any tenant
 * context; a merchant's own read path goes through `tenantDb` and is covered
 * by packages/db/test/rls.test.ts. */
async function ledgerFor(orderId: string) {
  return prisma.payment.findMany({ where: { orderId }, orderBy: { createdAt: 'asc' } });
}

/** Same shape as reconciliation-worker.test.ts's fake: only the methods the
 * sweep may call are scripted, every other member throws if touched. */
function fakeProvider(
  id: PaymentProviderId,
  scripted: {
    getTransactionStatus?: PaymentProvider['getTransactionStatus'];
    searchByReference?: PaymentProvider['searchByReference'];
  },
): PaymentProvider {
  return {
    id,
    createCheckoutSession: () => {
      throw new Error('fakeProvider: createCheckoutSession must never be called here');
    },
    verifyAndParseWebhook: () => {
      throw new Error('fakeProvider: verifyAndParseWebhook must never be called here');
    },
    getTransactionStatus:
      scripted.getTransactionStatus ??
      (() => {
        throw new Error('fakeProvider: getTransactionStatus was not expected to be called');
      }),
    ...(scripted.searchByReference ? { searchByReference: scripted.searchByReference } : {}),
  } as PaymentProvider;
}

function status(s: NormalizedStatus, extra: Partial<TransactionStatusResult> = {}): TransactionStatusResult {
  return { status: s, currency: 'COP', ...extra };
}

// ---------------------------------------------------------------------------
// Path 1 — the webhook receiver
// ---------------------------------------------------------------------------
describe('the payment ledger — webhook settle path', () => {
  it('records the gateway statement, with the gateway amount and a pointer to the WebhookEvent', async () => {
    const { tenantId } = await signUpWithTenant('ledger-wh-paid@demo.co', 'owner');
    await paymentsService.saveProviderCredentials(tenantId, 'wompi', FAKE_WOMPI_CREDS);
    const { orderId, reference } = await seedOrder(tenantId, { totalCents: 25_000 });

    const timestamp = Math.floor(Date.now() / 1000);
    const res = await postWompiWebhook(
      tenantId,
      buildSignedWebhookPayload({
        transactionId: 'wompi_txn_ledger_paid',
        status: 'APPROVED',
        amountInCents: 25_000,
        reference,
        timestamp,
        eventsSecret: FAKE_WOMPI_CREDS.eventsSecret,
      }),
    );
    expect(res.status).toBe(200);

    const rows = await ledgerFor(orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tenantId).toBe(tenantId);
    expect(rows[0]!.provider).toBe('wompi');
    expect(rows[0]!.providerRef).toBe('wompi_txn_ledger_paid');
    expect(rows[0]!.amountCents).toBe(25_000);
    // The NORMALIZED status, not Wompi's own 'APPROVED' vocabulary.
    expect(rows[0]!.status).toBe('PAID');
    // `raw` points at the WebhookEvent row that already holds the verified
    // payload byte-for-byte, rather than storing a second copy that could
    // later disagree with it. The pointer must actually resolve.
    expect(rows[0]!.raw).toMatchObject({ source: 'webhook', provider: 'wompi' });
    const eventId = (rows[0]!.raw as { eventId: string }).eventId;
    const event = await prisma.webhookEvent.findUnique({
      where: { provider_tenantId_eventId: { provider: 'wompi', tenantId, eventId } },
    });
    expect(event?.orderId).toBe(orderId);
    expect(event?.result).toBe('confirmed');
  });

  it('keeps BOTH attempts when a first card declines and a second succeeds', async () => {
    // The scenario the whole table exists for. `Order` has one slot for payment
    // state, so after the retry settles it says PAID with the SECOND attempt's
    // transaction id and the declined attempt is gone from it entirely. The
    // ledger is what remembers that a card was actually declined.
    const { tenantId } = await signUpWithTenant('ledger-wh-retry@demo.co', 'owner');
    await paymentsService.saveProviderCredentials(tenantId, 'wompi', FAKE_WOMPI_CREDS);
    const { orderId, reference } = await seedOrder(tenantId, { totalCents: 25_000 });

    const base = Math.floor(Date.now() / 1000);
    const declined = await postWompiWebhook(
      tenantId,
      buildSignedWebhookPayload({
        transactionId: 'wompi_txn_attempt_1',
        status: 'DECLINED',
        amountInCents: 25_000,
        reference,
        timestamp: base,
        eventsSecret: FAKE_WOMPI_CREDS.eventsSecret,
      }),
    );
    expect(declined.status).toBe(200);

    const approved = await postWompiWebhook(
      tenantId,
      buildSignedWebhookPayload({
        transactionId: 'wompi_txn_attempt_2',
        status: 'APPROVED',
        amountInCents: 25_000,
        reference,
        timestamp: base + 60,
        eventsSecret: FAKE_WOMPI_CREDS.eventsSecret,
      }),
    );
    expect(approved.status).toBe(200);

    const rows = await ledgerFor(orderId);
    expect(rows.map((r) => [r.providerRef, r.status])).toEqual([
      ['wompi_txn_attempt_1', 'FAILED'],
      ['wompi_txn_attempt_2', 'PAID'],
    ]);

    // `Order` stays authoritative and stays one slot — the ledger did not
    // change what it says, and the declined attempt is invisible on it.
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    expect(order?.paymentStatus).toBe('PAID');
    expect(order?.status).toBe('CONFIRMED');
    expect(order?.providerRef).toBe('wompi_txn_attempt_2');
  });

  it('records nothing for an event the amount check refused', async () => {
    // The refused branches must not write. An `amount_mismatch` event has, by
    // the very check that refused it, NOT been established to be about this
    // order's money — writing its number into this order's ledger would put
    // the forged amount into the one table whose purpose is to be believed.
    // The refusal itself is not lost: it is on `WebhookEvent.result`.
    const { tenantId } = await signUpWithTenant('ledger-wh-mismatch@demo.co', 'owner');
    await paymentsService.saveProviderCredentials(tenantId, 'wompi', FAKE_WOMPI_CREDS);
    const { orderId, reference } = await seedOrder(tenantId, { totalCents: 999_999 });

    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await postWompiWebhook(
      tenantId,
      buildSignedWebhookPayload({
        transactionId: 'wompi_txn_cheap',
        status: 'APPROVED',
        amountInCents: 100,
        reference,
        timestamp: Math.floor(Date.now() / 1000),
        eventsSecret: FAKE_WOMPI_CREDS.eventsSecret,
      }),
    );
    expect(res.status).toBe(200);

    expect(await ledgerFor(orderId)).toHaveLength(0);
    const events = await prisma.webhookEvent.findMany({ where: { orderId } });
    expect(events).toHaveLength(1);
    expect(events[0]!.result).toBe('amount_mismatch');

    const order = await prisma.order.findUnique({ where: { id: orderId } });
    expect(order?.paymentStatus).toBe('PENDING');
  });

  it('records nothing for an event the currency check refused', async () => {
    const { tenantId } = await signUpWithTenant('ledger-wh-currency@demo.co', 'owner');
    await paymentsService.saveProviderCredentials(tenantId, 'wompi', FAKE_WOMPI_CREDS);
    const { orderId, reference } = await seedOrder(tenantId, { totalCents: 25_000 });

    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await postWompiWebhook(
      tenantId,
      buildSignedWebhookPayload({
        transactionId: 'wompi_txn_usd',
        status: 'APPROVED',
        amountInCents: 25_000,
        reference,
        timestamp: Math.floor(Date.now() / 1000),
        eventsSecret: FAKE_WOMPI_CREDS.eventsSecret,
        currency: 'USD',
      }),
    );
    expect(res.status).toBe(200);

    expect(await ledgerFor(orderId)).toHaveLength(0);
    const events = await prisma.webhookEvent.findMany({ where: { orderId } });
    expect(events[0]!.result).toBe('currency_mismatch');
  });

  it('records what the gateway said even when the order could no longer be settled', async () => {
    // The `paid_order_not_settleable` case: a shopper was charged and the
    // expiry worker had already cancelled their order. The ledger records the
    // gateway's statement (a real PAID) because that is what happened at the
    // gateway; `Order` correctly records that nothing was settled. The ledger
    // is history, not a second opinion about the order's state.
    const { tenantId } = await signUpWithTenant('ledger-wh-unsettleable@demo.co', 'owner');
    await paymentsService.saveProviderCredentials(tenantId, 'wompi', FAKE_WOMPI_CREDS);
    const { orderId, reference } = await seedOrder(tenantId, {
      totalCents: 25_000,
      status: 'CANCELLED',
      paymentStatus: 'EXPIRED',
    });

    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await postWompiWebhook(
      tenantId,
      buildSignedWebhookPayload({
        transactionId: 'wompi_txn_too_late',
        status: 'APPROVED',
        amountInCents: 25_000,
        reference,
        timestamp: Math.floor(Date.now() / 1000),
        eventsSecret: FAKE_WOMPI_CREDS.eventsSecret,
      }),
    );
    expect(res.status).toBe(200);

    const rows = await ledgerFor(orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('PAID');

    const order = await prisma.order.findUnique({ where: { id: orderId } });
    expect(order?.status).toBe('CANCELLED');
    expect(order?.paymentStatus).toBe('EXPIRED');
    const events = await prisma.webhookEvent.findMany({ where: { orderId } });
    expect(events[0]!.result).toBe('paid_order_not_settleable');
  });

  it('does not duplicate a row when the same delivery is replayed', async () => {
    // Gateways retry. The idempotency key on `WebhookEvent` stops most replays
    // before they reach the ledger at all, but a delivery whose processing
    // previously threw is DELIBERATELY reprocessed (fix 5 in
    // webhooks.controller.ts) — so the ledger needs its own dedupe, and this
    // asserts it end to end by replaying the identical delivery ten times.
    const { tenantId } = await signUpWithTenant('ledger-wh-replay@demo.co', 'owner');
    await paymentsService.saveProviderCredentials(tenantId, 'wompi', FAKE_WOMPI_CREDS);
    const { orderId, reference } = await seedOrder(tenantId, { totalCents: 25_000 });

    const payload = buildSignedWebhookPayload({
      transactionId: 'wompi_txn_replayed',
      status: 'APPROVED',
      amountInCents: 25_000,
      reference,
      timestamp: Math.floor(Date.now() / 1000),
      eventsSecret: FAKE_WOMPI_CREDS.eventsSecret,
    });
    for (let i = 0; i < 10; i += 1) {
      expect((await postWompiWebhook(tenantId, payload)).status).toBe(200);
    }

    expect(await ledgerFor(orderId)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Path 2 — the reconciliation sweep
// ---------------------------------------------------------------------------
describe('the payment ledger — reconciliation settle path', () => {
  it('records the gateway statement, with the lookup that produced it', async () => {
    const { tenantId } = await signUpWithTenant('ledger-recon-paid@demo.co', 'owner');
    await paymentsService.saveProviderCredentials(tenantId, 'wompi', FAKE_WOMPI_CREDS);
    const { orderId, reference } = await seedOrder(tenantId, {
      providerRef: 'wompi_txn_recon_paid',
      ageMinutes: 6,
      reservedForMinutes: 9,
      totalCents: 25_000,
    });

    await reconcilePendingPayments(paymentsService, () =>
      fakeProvider('wompi', {
        getTransactionStatus: async () => status('PAID', { reference, amountCents: 25_000 }),
      }),
    );

    const rows = await ledgerFor(orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.providerRef).toBe('wompi_txn_recon_paid');
    expect(rows[0]!.status).toBe('PAID');
    expect(rows[0]!.amountCents).toBe(25_000);
    // This path produces no `WebhookEvent` row, so `raw` carries the normalized
    // lookup result itself — the only place that answer is ever persisted —
    // plus WHICH lookup produced it, since a by-id answer and a
    // by-our-reference answer carry different guarantees.
    expect(rows[0]!.raw).toMatchObject({
      source: 'reconciliation',
      via: 'by-id',
      gateway: { status: 'PAID', reference, amountCents: 25_000, currency: 'COP' },
    });

    const order = await prisma.order.findUnique({ where: { id: orderId } });
    expect(order?.paymentStatus).toBe('PAID');
  });

  it('records the search-by-reference lookup under its own `via`', async () => {
    const { tenantId } = await signUpWithTenant('ledger-recon-search@demo.co', 'owner');
    await paymentsService.saveProviderCredentials(tenantId, 'mercadopago', {
      publicKey: 'APP_USR-mp-public-key-1234567890',
      privateKey: 'APP_USR-mp-ACCESS-TOKEN-secret-abcdefghijk',
      eventsSecret: 'mp-events-secret-webhook-signing-key-0987',
      sandbox: true,
    });
    const { orderId, reference } = await seedOrder(tenantId, {
      provider: 'mercadopago',
      providerRef: null,
      ageMinutes: 6,
      reservedForMinutes: 9,
      totalCents: 25_000,
    });

    await reconcilePendingPayments(paymentsService, () =>
      fakeProvider('mercadopago', {
        searchByReference: async () => ({
          providerRef: 'mp_payment_77',
          status: 'PAID' as NormalizedStatus,
          reference,
          amountCents: 25_000,
          currency: 'COP',
        }),
      }),
    );

    const rows = await ledgerFor(orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.providerRef).toBe('mp_payment_77');
    expect(rows[0]!.raw).toMatchObject({ source: 'reconciliation', via: 'search-by-reference' });
  });

  it('records nothing when the gateway result is not bound to this order', async () => {
    // The binding check is what stops a truthful gateway answer about SOMEONE
    // ELSE'S transaction settling this order. A result it rejects has not been
    // established to be about this order's money, so it must not enter this
    // order's ledger either — same rule as the webhook path's refused branches.
    const { tenantId } = await signUpWithTenant('ledger-recon-unbound@demo.co', 'owner');
    await paymentsService.saveProviderCredentials(tenantId, 'wompi', FAKE_WOMPI_CREDS);
    const { orderId } = await seedOrder(tenantId, {
      providerRef: 'wompi_txn_someone_elses',
      ageMinutes: 6,
      reservedForMinutes: 9,
      totalCents: 25_000,
    });

    vi.spyOn(console, 'error').mockImplementation(() => {});
    await reconcilePendingPayments(paymentsService, () =>
      fakeProvider('wompi', {
        getTransactionStatus: async () =>
          status('PAID', { reference: 'vr_a_completely_different_order', amountCents: 25_000 }),
      }),
    );

    expect(await ledgerFor(orderId)).toHaveLength(0);
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    expect(order?.paymentStatus).toBe('PENDING');
  });

  it('does not append a row per sweep for an order that keeps answering FAILED', async () => {
    // An order in PENDING/FAILED whose gateway answer is still FAILED is a
    // candidate on EVERY 2-minute pass, by design (wave-2 FIX 1 keeps it in the
    // candidate set so a lost retry webhook can still be recovered). Without
    // the ledger's dedupe key that is one row every two minutes, forever, for
    // an order nothing is happening to.
    const { tenantId } = await signUpWithTenant('ledger-recon-repeat@demo.co', 'owner');
    await paymentsService.saveProviderCredentials(tenantId, 'wompi', FAKE_WOMPI_CREDS);
    const { orderId, reference } = await seedOrder(tenantId, {
      providerRef: 'wompi_txn_declined_forever',
      ageMinutes: 6,
      reservedForMinutes: 9,
      totalCents: 25_000,
    });

    const gateway = () =>
      fakeProvider('wompi', {
        getTransactionStatus: async () => status('FAILED', { reference, amountCents: 25_000 }),
      });

    for (let i = 0; i < 3; i += 1) {
      await reconcilePendingPayments(paymentsService, gateway);
      // The afterEach hygiene sweep only runs between TESTS, so the order is
      // still a candidate for each of these three passes — which is the point.
      await prisma.order.update({
        where: { id: orderId },
        data: { stockReservedUntil: new Date(Date.now() + 9 * 60_000) },
      });
    }

    const rows = await ledgerFor(orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('FAILED');
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    expect(order?.paymentStatus).toBe('FAILED');
  });

  it('records a gateway "still pending" answer, which settles nothing', async () => {
    // A statement about this order's money that this system deliberately does
    // not act on is still a statement about this order's money. It is also the
    // clearest demonstration that the ledger is not a state machine: a PENDING
    // row exists and the order's state is unchanged.
    const { tenantId } = await signUpWithTenant('ledger-recon-pending@demo.co', 'owner');
    await paymentsService.saveProviderCredentials(tenantId, 'wompi', FAKE_WOMPI_CREDS);
    const { orderId, reference } = await seedOrder(tenantId, {
      providerRef: 'wompi_txn_still_pending',
      ageMinutes: 6,
      reservedForMinutes: 9,
      totalCents: 25_000,
    });

    await reconcilePendingPayments(paymentsService, () =>
      fakeProvider('wompi', {
        getTransactionStatus: async () => status('PENDING', { reference, amountCents: 25_000 }),
      }),
    );

    const rows = await ledgerFor(orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('PENDING');
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    expect(order?.status).toBe('PENDING');
    expect(order?.paymentStatus).toBe('PENDING');
  });
});

// ---------------------------------------------------------------------------
// The property that makes the ledger worth having
// ---------------------------------------------------------------------------
describe('the payment ledger — both settle paths, one order', () => {
  it('joins a webhook-reported decline and a reconciliation-recovered payment into one history', async () => {
    // The end-to-end case that motivates writing from BOTH paths: attempt 1 is
    // declined and its webhook arrives; attempt 2 succeeds and its webhook is
    // LOST, so only the 2-minute sweep ever learns about it. `Order` ends up
    // saying PAID with attempt 2's id, and the complete story — a declined
    // card, then a payment nobody was told about — exists only here.
    const { tenantId } = await signUpWithTenant('ledger-both-paths@demo.co', 'owner');
    await paymentsService.saveProviderCredentials(tenantId, 'wompi', FAKE_WOMPI_CREDS);
    const { orderId, reference } = await seedOrder(tenantId, {
      totalCents: 25_000,
      ageMinutes: 6,
      reservedForMinutes: 9,
    });

    // Attempt 1: declined, webhook delivered.
    const declined = await postWompiWebhook(
      tenantId,
      buildSignedWebhookPayload({
        transactionId: 'wompi_txn_both_1',
        status: 'DECLINED',
        amountInCents: 25_000,
        reference,
        timestamp: Math.floor(Date.now() / 1000),
        eventsSecret: FAKE_WOMPI_CREDS.eventsSecret,
      }),
    );
    expect(declined.status).toBe(200);

    // Attempt 2: approved, webhook LOST. Only the sweep sees it — and it can,
    // because `markFailed` left the order PENDING with its stock hold intact
    // and `markPaid` accepts PENDING/FAILED -> PAID.
    await reconcilePendingPayments(paymentsService, () =>
      fakeProvider('wompi', {
        getTransactionStatus: async () => status('PAID', { reference, amountCents: 25_000 }),
      }),
    );

    const rows = await ledgerFor(orderId);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.status)).toEqual(['FAILED', 'PAID']);
    expect((rows[0]!.raw as { source: string }).source).toBe('webhook');
    expect((rows[1]!.raw as { source: string }).source).toBe('reconciliation');

    const order = await prisma.order.findUnique({ where: { id: orderId } });
    expect(order?.status).toBe('CONFIRMED');
    expect(order?.paymentStatus).toBe('PAID');
  });

  it('is unreachable for writes from tenant-scoped code', async () => {
    // The append-only property, asserted through the same client every request
    // handler in this service uses — not just at the SQL level (which
    // packages/db/test/rls.test.ts covers). A merchant-facing surface that ever
    // tried to amend this ledger would fail loudly here.
    const { tenantId } = await signUpWithTenant('ledger-append-only@demo.co', 'owner');
    const { orderId } = await seedOrder(tenantId, { totalCents: 25_000 });
    const { tenantDb } = (await import('@ventia/db')) as unknown as {
      tenantDb: (t: string) => { payment: { create: (a: unknown) => Promise<unknown> } };
    };

    await expect(
      tenantDb(tenantId).payment.create({
        data: {
          tenantId,
          orderId,
          provider: 'wompi',
          providerRef: 'wompi_txn_forged',
          amountCents: 1,
          status: 'PAID',
        },
      }),
    ).rejects.toThrow(/permission denied/i);
  });
});
