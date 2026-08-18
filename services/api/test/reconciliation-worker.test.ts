import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { generateOrderReference } from '@ventia/core';
import { randomUUID } from 'node:crypto';
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
import type { expireReservations as ExpireReservations } from '../src/payments/stock-reservation.worker';
import type { PaymentsService as PaymentsServiceType } from '../src/payments/payments.service';

let db: Awaited<ReturnType<typeof startTestDb>>;
let redisContainer: StartedTestContainer;
let app: INestApplication;
let signUpWithTenant: typeof SignUpWithTenant;
let prisma: PrismaClientType;
let reconcilePendingPayments: typeof ReconcilePendingPayments;
let RECONCILE_BATCH_LIMIT: number;
let expireReservations: typeof ExpireReservations;
let paymentsService: PaymentsServiceType;

beforeAll(async () => {
  db = await startTestDb();
  redisContainer = await new GenericContainer('redis:7-alpine')
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
    .start();

  // Env vars must be set BEFORE the first import of @ventia/db / ../src/main /
  // ./admin-helpers / the worker module — same pattern as
  // stock-reservation-worker.test.ts / payments-service.test.ts.
  process.env.DATABASE_URL = db.url;
  process.env.REDIS_URL = `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`;
  process.env.PAYMENTS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

  // createApp()/app.init() is exercised here for the same reason
  // stock-reservation-worker.test.ts does it: app.init() runs PaymentsModule's
  // whole provider graph, now including ReconciliationWorker, and that must NOT
  // start a real BullMQ Queue/Worker against this test's ephemeral Redis (see
  // that class's doc comment). A leaked Worker/Queue would most likely surface
  // as a hung `afterAll` rather than a clean pass.
  const { createApp } = await import('../src/main');
  app = await createApp();
  await app.init();

  ({ signUpWithTenant } = await import('./admin-helpers'));
  ({ platformDb: prisma } = (await import('@ventia/db')) as unknown as { platformDb: PrismaClientType });
  ({ reconcilePendingPayments, RECONCILE_BATCH_LIMIT } = await import(
    '../src/payments/reconciliation.worker'
  ));
  ({ expireReservations } = await import('../src/payments/stock-reservation.worker'));
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
  // Test hygiene, not production behavior: the sweep is deliberately
  // cross-tenant (like the stock-reservation sweep), so an order seeded by an
  // earlier test that is still PENDING/PENDING with a live `stockReservedUntil`
  // would keep being picked up by every LATER test's sweep too — and would be
  // fed to that later test's scripted fake provider, muddying `toHaveBeenCalled`
  // style assertions. Clearing `stockReservedUntil` retires every previous
  // test's fixtures from the candidate query (`stockReservedUntil IS NOT NULL`
  // is part of it) without touching status/paymentStatus. Runs AFTER each
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

const FAKE_MP_CREDS = {
  publicKey: 'APP_USR-mp-public-key-1234567890',
  privateKey: 'APP_USR-mp-ACCESS-TOKEN-secret-abcdefghijk',
  eventsSecret: 'mp-events-secret-webhook-signing-key-0987',
  sandbox: true,
};

let orderNumberSeq = 9000;

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

interface SeedOrderOpts {
  provider: string | null;
  providerRef?: string | null;
  /** Provenance of `providerRef` (`Order.providerRefSource`). Defaults to
   * `'verified'` whenever a `providerRef` is given, because that is what every
   * pre-existing fixture in this file means by it: a ref stamped by
   * markPaid/markFailed after a real signature-verified webhook. Tests that
   * want the UNTRUSTED case (a value planted through the unauthenticated hint
   * endpoint) pass `'hint'` — or `null` for a pre-migration row of unknown
   * provenance, which is treated identically. */
  providerRefSource?: string | null;
  totalCents?: number;
  /** How long ago the order was created, in minutes — REAL timestamps, never a
   * faked clock, so the 5-minute reconciliation floor is exercised for real. */
  ageMinutes: number;
  /** How far in the FUTURE the 15-minute stock hold still runs, in minutes.
   * `null` = no active reservation. */
  reservedForMinutes: number | null;
  status?: OrderStatus;
  paymentStatus?: PaymentStatus;
  productId?: string;
  qty?: number;
}

async function seedOnlineOrder(
  tenantId: string,
  opts: SeedOrderOpts,
): Promise<{ orderId: string; number: number; reference: string }> {
  const now = Date.now();
  // The gateway reference is `Order.reference`, not the order number — the
  // binding check compares against it, so these tests must echo back the same
  // value a real gateway would have been given.
  const reference = generateOrderReference();
  const order = await prisma.order.create({
    data: {
      tenantId,
      number: orderNumberSeq++,
      reference,
      status: opts.status ?? 'PENDING',
      paymentStatus: opts.paymentStatus ?? 'PENDING',
      paymentProvider: opts.provider,
      providerRef: opts.providerRef ?? null,
      providerRefSource:
        opts.providerRefSource !== undefined ? opts.providerRefSource : opts.providerRef ? 'verified' : null,
      stockReservedUntil:
        opts.reservedForMinutes === null ? null : new Date(now + opts.reservedForMinutes * 60_000),
      createdAt: new Date(now - opts.ageMinutes * 60_000),
      email: 'comprador@example.com',
      phone: '3000000000',
      shippingAddress: {},
      subtotalCents: opts.totalCents ?? 25_000,
      taxCents: 0,
      totalCents: opts.totalCents ?? 25_000,
    },
  });
  if (opts.productId) {
    await prisma.orderItem.create({
      data: {
        tenantId,
        orderId: order.id,
        productId: opts.productId,
        nameSnapshot: 'Item de prueba',
        priceCentsSnapshot: 10_000,
        qty: opts.qty ?? 1,
        taxRateSnapshot: 'NINETEEN',
      },
    });
  }
  return { orderId: order.id, number: order.number, reference };
}

/** Builds a fake `PaymentProvider` with only the two methods this worker ever
 * calls scripted — every other member throws if touched, so an accidental
 * extra call is a loud failure rather than a silent pass. Same
 * "fake the adapter, exercise everything else for real" style
 * webhooks.test.ts/payments-service.test.ts already use (real encryption, real
 * Postgres, real advisory locks — only the outbound gateway HTTP is faked). */
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
      throw new Error('fakeProvider: createCheckoutSession must never be called by the reconciliation worker');
    },
    verifyAndParseWebhook: () => {
      throw new Error('fakeProvider: verifyAndParseWebhook must never be called by the reconciliation worker');
    },
    getTransactionStatus:
      scripted.getTransactionStatus ??
      (() => {
        throw new Error('fakeProvider: getTransactionStatus was not expected to be called');
      }),
    ...(scripted.searchByReference ? { searchByReference: scripted.searchByReference } : {}),
  } as PaymentProvider;
}

/** A scripted gateway answer. `currency` defaults to `'COP'` because that is
 * what a REAL response from any of the three adapters carries alongside an
 * amount (`data.currency` / `currency_id` / `x_currency_code`) — a fixture
 * that omitted it would be testing a malformed response, not a normal one.
 * The currency-binding tests below override it explicitly. */
function status(s: NormalizedStatus, extra: Partial<TransactionStatusResult> = {}): TransactionStatusResult {
  return { status: s, currency: 'COP', ...extra };
}

/** Only the calls that concern ONE specific order — the sweep is cross-tenant,
 * so a bare `not.toHaveBeenCalled()` on a shared spy would be asserting
 * something stronger (and flakier) than the claim under test. `markPaid`'s
 * signature is `(tenantId, orderId, provider, providerRef)`. */
function callsForOrder(spy: { mock: { calls: unknown[][] } }, orderId: string): unknown[][] {
  return spy.mock.calls.filter((call) => call[1] === orderId);
}

describe('reconcilePendingPayments — (a) a known providerRef the gateway reports PAID', () => {
  it('settles the order to CONFIRMED/PAID, clears the reservation, and does so EXACTLY ONCE across two sweeps', async () => {
    const { tenantId } = await signUpWithTenant('recon-paid@demo.co', 'owner');
    await paymentsService.saveProviderCredentials(tenantId, 'wompi', FAKE_WOMPI_CREDS);
    const { orderId, reference } = await seedOnlineOrder(tenantId, {
      provider: 'wompi',
      providerRef: 'wompi_txn_real_paid_1',
      ageMinutes: 6,
      reservedForMinutes: 9,
      totalCents: 25_000,
    });

    const getTransactionStatus = vi.fn(async () =>
      status('PAID', { reference, amountCents: 25_000 }),
    );
    const markPaidSpy = vi.spyOn(paymentsService, 'markPaid');

    await reconcilePendingPayments(paymentsService, () =>
      fakeProvider('wompi', { getTransactionStatus }),
    );

    const after = await prisma.order.findUnique({ where: { id: orderId } });
    expect(after?.status).toBe('CONFIRMED');
    expect(after?.paymentStatus).toBe('PAID');
    expect(after?.stockReservedUntil).toBeNull();
    expect(after?.providerRef).toBe('wompi_txn_real_paid_1');
    expect(callsForOrder(markPaidSpy, orderId)).toHaveLength(1);

    const eventsAfterFirst = await prisma.orderEvent.count({ where: { orderId, type: 'payment_confirmed' } });
    expect(eventsAfterFirst).toBe(1);

    // Second sweep over the SAME fixtures: the order no longer matches the
    // candidate query (paymentStatus is PAID, stockReservedUntil is null), so
    // no second gateway call, no second markPaid, no second OrderEvent, no
    // throw. "Exactly once", proven rather than assumed.
    await reconcilePendingPayments(paymentsService, () =>
      fakeProvider('wompi', { getTransactionStatus }),
    );

    const afterSecond = await prisma.order.findUnique({ where: { id: orderId } });
    expect(afterSecond?.status).toBe('CONFIRMED');
    expect(afterSecond?.paymentStatus).toBe('PAID');
    expect(callsForOrder(markPaidSpy, orderId)).toHaveLength(1);
    expect(await prisma.orderEvent.count({ where: { orderId, type: 'payment_confirmed' } })).toBe(1);
    expect(getTransactionStatus).toHaveBeenCalledTimes(1);
  });
});

describe('reconcilePendingPayments — (b) a known providerRef the gateway reports FAILED', () => {
  it("sets paymentStatus FAILED and leaves status/stockReservedUntil untouched (markFailed's existing contract)", async () => {
    const { tenantId } = await signUpWithTenant('recon-failed@demo.co', 'owner');
    await paymentsService.saveProviderCredentials(tenantId, 'wompi', FAKE_WOMPI_CREDS);
    const { orderId, reference } = await seedOnlineOrder(tenantId, {
      provider: 'wompi',
      providerRef: 'wompi_txn_declined_1',
      ageMinutes: 6,
      reservedForMinutes: 9,
    });

    await reconcilePendingPayments(paymentsService, () =>
      fakeProvider('wompi', {
        getTransactionStatus: async () => status('FAILED', { reference, amountCents: 25_000 }),
      }),
    );

    const after = await prisma.order.findUnique({ where: { id: orderId } });
    expect(after?.paymentStatus).toBe('FAILED');
    expect(after?.status).toBe('PENDING'); // untouched
    expect(after?.stockReservedUntil).not.toBeNull(); // untouched — this job never releases stock
    expect(await prisma.orderEvent.count({ where: { orderId, type: 'payment_failed' } })).toBe(1);

    // The gateway's own resolved status is recorded alongside provider/
    // providerRef — see the EXPIRED case below for why this matters.
    const event = await prisma.orderEvent.findFirst({ where: { orderId, type: 'payment_failed' } });
    expect(event?.data).toMatchObject({ provider: 'wompi', gatewayStatus: 'FAILED' });
  });

  // Mercado Pago maps `refunded`/`charged_back` -> EXPIRED, and this worker
  // settles EVERY non-PAID terminal status through `markFailed`, which by
  // design sets `paymentStatus: 'FAILED'`. So a refunded order and a declined
  // card end up indistinguishable on the Order row itself. That outcome is
  // deliberate and unchanged (nothing here auto-un-confirms or restocks), but
  // the distinction must at least survive in the audit trail.
  it("records an EXPIRED gateway status (MP's refunded/charged_back) in the payment_failed event, while still settling to FAILED", async () => {
    const { tenantId } = await signUpWithTenant('recon-expired-audit@demo.co', 'owner');
    await paymentsService.saveProviderCredentials(tenantId, 'mercadopago', FAKE_MP_CREDS);
    const { orderId, reference } = await seedOnlineOrder(tenantId, {
      provider: 'mercadopago',
      providerRef: 'mp-payment-refunded-99',
      ageMinutes: 6,
      reservedForMinutes: 9,
    });

    await reconcilePendingPayments(paymentsService, () =>
      fakeProvider('mercadopago', {
        getTransactionStatus: async () =>
          status('EXPIRED', { reference, amountCents: 25_000 }),
      }),
    );

    const after = await prisma.order.findUnique({ where: { id: orderId } });
    // markFailed's outcome is unchanged: paymentStatus FAILED, status and the
    // stock hold untouched.
    expect(after?.paymentStatus).toBe('FAILED');
    expect(after?.status).toBe('PENDING');
    expect(after?.stockReservedUntil).not.toBeNull();

    const event = await prisma.orderEvent.findFirst({ where: { orderId, type: 'payment_failed' } });
    expect(event?.data).toMatchObject({
      provider: 'mercadopago',
      providerRef: 'mp-payment-refunded-99',
      // The one piece of information the FAILED paymentStatus throws away.
      gatewayStatus: 'EXPIRED',
    });
  });
});

describe('reconcilePendingPayments — (c) an order younger than the 5-minute floor', () => {
  it('is not selected at all: no gateway call, no state change', async () => {
    const { tenantId } = await signUpWithTenant('recon-too-young@demo.co', 'owner');
    await paymentsService.saveProviderCredentials(tenantId, 'wompi', FAKE_WOMPI_CREDS);
    const { orderId, reference } = await seedOnlineOrder(tenantId, {
      provider: 'wompi',
      providerRef: 'wompi_txn_young_1',
      ageMinutes: 1, // real timestamp, 1 minute old — well inside the 5-minute floor
      reservedForMinutes: 14,
    });

    const getTransactionStatus = vi.fn(async () => status('PAID', { reference }));
    await reconcilePendingPayments(paymentsService, () =>
      fakeProvider('wompi', { getTransactionStatus }),
    );

    expect(getTransactionStatus).not.toHaveBeenCalled();
    const after = await prisma.order.findUnique({ where: { id: orderId } });
    expect(after?.status).toBe('PENDING');
    expect(after?.paymentStatus).toBe('PENDING');
    expect(after?.stockReservedUntil).not.toBeNull();
  });
});

describe('reconcilePendingPayments — (d) mercadopago with no providerRef falls back to searchByReference', () => {
  it('queries by OUR order number, uses the returned providerRef/status, and settles to PAID', async () => {
    const { tenantId } = await signUpWithTenant('recon-mp-search@demo.co', 'owner');
    await paymentsService.saveProviderCredentials(tenantId, 'mercadopago', FAKE_MP_CREDS);
    const { orderId, number, reference } = await seedOnlineOrder(tenantId, {
      provider: 'mercadopago',
      providerRef: null,
      ageMinutes: 7,
      reservedForMinutes: 8,
    });

    // The gateway's OWN reference/amount come back on the result and are what
    // the binding check runs against (see the search-path cases in (e2) below)
    // — a search result that carried neither would no longer settle anything.
    const searchByReference = vi.fn(async () => ({
      providerRef: 'mp-payment-112233',
      status: 'PAID' as const,
      reference,
      amountCents: 25_000,
      currency: 'COP',
    }));
    const getTransactionStatus = vi.fn(async () => status('PENDING'));

    await reconcilePendingPayments(paymentsService, () =>
      fakeProvider('mercadopago', { searchByReference, getTransactionStatus }),
    );

    // Queried by the PLAIN Int-as-string form of Order.number, never the
    // VNT--prefixed display string.
    expect(searchByReference).toHaveBeenCalledWith(String(number), expect.anything());
    expect(getTransactionStatus).not.toHaveBeenCalled();

    const after = await prisma.order.findUnique({ where: { id: orderId } });
    expect(after?.status).toBe('CONFIRMED');
    expect(after?.paymentStatus).toBe('PAID');
    expect(after?.providerRef).toBe('mp-payment-112233');
    expect(after?.stockReservedUntil).toBeNull();
  });

  it('a search that finds nothing leaves the order completely alone', async () => {
    const { tenantId } = await signUpWithTenant('recon-mp-search-empty@demo.co', 'owner');
    await paymentsService.saveProviderCredentials(tenantId, 'mercadopago', FAKE_MP_CREDS);
    const { orderId } = await seedOnlineOrder(tenantId, {
      provider: 'mercadopago',
      providerRef: null,
      ageMinutes: 7,
      reservedForMinutes: 8,
    });

    await reconcilePendingPayments(paymentsService, () =>
      fakeProvider('mercadopago', { searchByReference: async () => null }),
    );

    const after = await prisma.order.findUnique({ where: { id: orderId } });
    expect(after?.status).toBe('PENDING');
    expect(after?.paymentStatus).toBe('PENDING');
    expect(after?.providerRef).toBeNull();
    expect(after?.stockReservedUntil).not.toBeNull();
  });
});

describe('reconcilePendingPayments — (e) wompi/epayco with no providerRef', () => {
  it('is skipped entirely: no API call is even attempted, no crash, order untouched', async () => {
    const { tenantId } = await signUpWithTenant('recon-wompi-noref@demo.co', 'owner');
    await paymentsService.saveProviderCredentials(tenantId, 'wompi', FAKE_WOMPI_CREDS);
    const { orderId } = await seedOnlineOrder(tenantId, {
      provider: 'wompi',
      providerRef: null,
      ageMinutes: 8,
      reservedForMinutes: 7,
    });

    const getTransactionStatus = vi.fn(async () => status('PAID'));
    // Note the absence of `searchByReference` — exactly like the real
    // WompiProvider/EpaycoProvider, for which the optional method is undefined.
    await reconcilePendingPayments(paymentsService, () =>
      fakeProvider('wompi', { getTransactionStatus }),
    );

    expect(getTransactionStatus).not.toHaveBeenCalled();
    const after = await prisma.order.findUnique({ where: { id: orderId } });
    expect(after?.status).toBe('PENDING');
    expect(after?.paymentStatus).toBe('PENDING');
    expect(after?.stockReservedUntil).not.toBeNull();
  });

  it('the same holds for epayco (whose only providerRef source is a real webhook)', async () => {
    const { tenantId } = await signUpWithTenant('recon-epayco-noref@demo.co', 'owner');
    await paymentsService.saveProviderCredentials(tenantId, 'epayco', {
      publicKey: 'epayco-public-key-1234567890abcdef',
      privateKey: 'epayco-private-key-SECRET-abcdefghijklmnop',
      eventsSecret: 'epayco-P_KEY-secret-webhook-signing-9182736',
      epaycoCustomerId: 'epayco-P_CUST_ID_CLIENTE-1234',
      sandbox: true,
    });
    const { orderId } = await seedOnlineOrder(tenantId, {
      provider: 'epayco',
      providerRef: null,
      ageMinutes: 8,
      reservedForMinutes: 7,
    });

    const getTransactionStatus = vi.fn(async () => status('PAID'));
    await reconcilePendingPayments(paymentsService, () =>
      fakeProvider('epayco', { getTransactionStatus }),
    );

    expect(getTransactionStatus).not.toHaveBeenCalled();
    const after = await prisma.order.findUnique({ where: { id: orderId } });
    expect(after?.paymentStatus).toBe('PENDING');
  });
});

describe('reconcilePendingPayments — (e2) THE ORDER-BINDING SAFETY CLAIM', () => {
  // This is the attack the whole `TransactionStatusResult` shape exists to
  // stop, reproduced end to end: `Order.providerRef` is settable through the
  // deliberately-UNAUTHENTICATED provider-ref-hint endpoint, so a shopper
  // holding ONE real, genuinely-PAID transaction id (their own past purchase)
  // can plant it on a DIFFERENT, still-PENDING order. The gateway then answers
  // "yes, that transaction is PAID" — perfectly truthfully — about a payment
  // that has nothing to do with the order being reconciled.
  //
  // Every case below asserts on the SPY (markPaid/markFailed genuinely never
  // invoked for this order), not merely on the end state: an unchanged end
  // state could pass for the wrong reason (e.g. markPaid was called and its own
  // precondition happened to no-op), which would leave the binding check
  // untested while looking green.
  it('a PAID transaction whose reference belongs to a DIFFERENT order settles NOTHING', async () => {
    const { tenantId } = await signUpWithTenant('recon-bind-wrong-ref@demo.co', 'owner');
    await paymentsService.saveProviderCredentials(tenantId, 'wompi', FAKE_WOMPI_CREDS);

    // The attacker's OWN, genuinely-paid past order — the source of the real
    // transaction id, and the order that transaction is actually about.
    const attackersOwn = await seedOnlineOrder(tenantId, {
      provider: 'wompi',
      providerRef: 'wompi_txn_genuinely_paid',
      ageMinutes: 60,
      reservedForMinutes: null,
      status: 'CONFIRMED',
      paymentStatus: 'PAID',
    });

    // The target: a different, still-unpaid order with that real transaction id
    // planted on it via the unauthenticated hint endpoint.
    const target = await seedOnlineOrder(tenantId, {
      provider: 'wompi',
      providerRef: 'wompi_txn_genuinely_paid',
      ageMinutes: 6,
      reservedForMinutes: 9,
      totalCents: 25_000,
    });

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const markPaidSpy = vi.spyOn(paymentsService, 'markPaid');
    const markFailedSpy = vi.spyOn(paymentsService, 'markFailed');

    await reconcilePendingPayments(paymentsService, () =>
      fakeProvider('wompi', {
        // A truthful gateway answer — about the ATTACKER'S OWN order.
        getTransactionStatus: async () =>
          status('PAID', { reference: String(attackersOwn.number), amountCents: 25_000 }),
      }),
    );

    // Settled nothing, in either direction.
    expect(callsForOrder(markPaidSpy, target.orderId)).toHaveLength(0);
    expect(callsForOrder(markFailedSpy, target.orderId)).toHaveLength(0);

    const after = await prisma.order.findUnique({ where: { id: target.orderId } });
    expect(after?.status).toBe('PENDING');
    expect(after?.paymentStatus).toBe('PENDING');
    expect(after?.stockReservedUntil).not.toBeNull(); // falls through to the 15-min expiry worker, untouched
    expect(await prisma.orderEvent.count({ where: { orderId: target.orderId } })).toBe(0);

    // ...and it was logged rather than silently swallowed.
    expect(errorSpy).toHaveBeenCalled();
    expect(JSON.stringify(errorSpy.mock.calls)).toContain('not bound');
  });

  it('a mismatched reference on a FAILED status settles nothing either (never markFailed)', async () => {
    const { tenantId } = await signUpWithTenant('recon-bind-wrong-ref-failed@demo.co', 'owner');
    await paymentsService.saveProviderCredentials(tenantId, 'wompi', FAKE_WOMPI_CREDS);
    const other = await seedOnlineOrder(tenantId, {
      provider: 'wompi',
      providerRef: null,
      ageMinutes: 60,
      reservedForMinutes: null,
      status: 'CANCELLED',
      paymentStatus: 'FAILED',
    });
    const target = await seedOnlineOrder(tenantId, {
      provider: 'wompi',
      providerRef: 'wompi_txn_someone_elses_failure',
      ageMinutes: 6,
      reservedForMinutes: 9,
    });

    vi.spyOn(console, 'error').mockImplementation(() => {});
    const markFailedSpy = vi.spyOn(paymentsService, 'markFailed');

    await reconcilePendingPayments(paymentsService, () =>
      fakeProvider('wompi', {
        getTransactionStatus: async () => status('FAILED', { reference: String(other.number) }),
      }),
    );

    expect(callsForOrder(markFailedSpy, target.orderId)).toHaveLength(0);
    const after = await prisma.order.findUnique({ where: { id: target.orderId } });
    expect(after?.status).toBe('PENDING');
    expect(after?.paymentStatus).toBe('PENDING');
  });

  it('a MISSING reference (undefined — what an adapter emits rather than fabricating one) settles nothing', async () => {
    const { tenantId } = await signUpWithTenant('recon-bind-no-ref@demo.co', 'owner');
    await paymentsService.saveProviderCredentials(tenantId, 'wompi', FAKE_WOMPI_CREDS);
    const { orderId } = await seedOnlineOrder(tenantId, {
      provider: 'wompi',
      providerRef: 'wompi_txn_unreadable_reference',
      ageMinutes: 6,
      reservedForMinutes: 9,
    });

    vi.spyOn(console, 'error').mockImplementation(() => {});
    const markPaidSpy = vi.spyOn(paymentsService, 'markPaid');
    const markFailedSpy = vi.spyOn(paymentsService, 'markFailed');

    await reconcilePendingPayments(paymentsService, () =>
      fakeProvider('wompi', {
        // `status` present, `reference` genuinely absent.
        getTransactionStatus: async () => status('PAID'),
      }),
    );

    expect(callsForOrder(markPaidSpy, orderId)).toHaveLength(0);
    expect(callsForOrder(markFailedSpy, orderId)).toHaveLength(0);
    const after = await prisma.order.findUnique({ where: { id: orderId } });
    expect(after?.status).toBe('PENDING');
    expect(after?.paymentStatus).toBe('PENDING');
    expect(after?.stockReservedUntil).not.toBeNull();
  });

  it('a MATCHING reference but a mismatched amountCents settles nothing', async () => {
    const { tenantId } = await signUpWithTenant('recon-bind-wrong-amount@demo.co', 'owner');
    await paymentsService.saveProviderCredentials(tenantId, 'wompi', FAKE_WOMPI_CREDS);
    const { orderId, reference } = await seedOnlineOrder(tenantId, {
      provider: 'wompi',
      providerRef: 'wompi_txn_wrong_amount',
      ageMinutes: 6,
      reservedForMinutes: 9,
      totalCents: 25_000,
    });

    vi.spyOn(console, 'error').mockImplementation(() => {});
    const markPaidSpy = vi.spyOn(paymentsService, 'markPaid');

    await reconcilePendingPayments(paymentsService, () =>
      fakeProvider('wompi', {
        // Right order, wrong money: 1.000 COP paid against a 250.000 COP order.
        getTransactionStatus: async () =>
          status('PAID', { reference, amountCents: 100_000 }),
      }),
    );

    expect(callsForOrder(markPaidSpy, orderId)).toHaveLength(0);
    const after = await prisma.order.findUnique({ where: { id: orderId } });
    expect(after?.status).toBe('PENDING');
    expect(after?.paymentStatus).toBe('PENDING');
    expect(after?.stockReservedUntil).not.toBeNull();
  });

  // --- The SEARCH path's own binding (P3c review follow-up).
  //
  // These four cases were IMPOSSIBLE to write before: the worker used to
  // restate its own query key as the search result's `reference`
  // (`reference: String(order.number)`), so the binding comparison on this path
  // compared a value to itself — a tautology — and `amountCents` was never
  // populated at all, so there was no amount binding here whatsoever. The whole
  // guarantee rested on Mercado Pago's server-side `external_reference` filter
  // being exact-match: documented, but never verified by us at runtime, and no
  // test could have caught a regression because the interface gave a fake
  // provider no way to return a mismatched reference in the first place.
  //
  // `ReferenceSearchResult` now carries the gateway's OWN reference/amount, so
  // the SAME `checkOrderBinding` runs on this path with honest data, and these
  // tests can drive it. (The real `MercadoPagoProvider.searchByReference` also
  // drops mismatched results itself — belt and braces, covered in
  // `packages/payments/test/mercadopago.test.ts` — but that is the ADAPTER's
  // defence; this is the WORKER's, and the worker must not depend on it.)
  it('a search result whose reference is for a DIFFERENT order settles nothing', async () => {
    const { tenantId } = await signUpWithTenant('recon-bind-search-wrong-ref@demo.co', 'owner');
    await paymentsService.saveProviderCredentials(tenantId, 'mercadopago', FAKE_MP_CREDS);
    const { orderId, reference } = await seedOnlineOrder(tenantId, {
      provider: 'mercadopago',
      providerRef: null,
      ageMinutes: 7,
      reservedForMinutes: 8,
      totalCents: 25_000,
    });

    vi.spyOn(console, 'error').mockImplementation(() => {});
    const markPaidSpy = vi.spyOn(paymentsService, 'markPaid');
    const markFailedSpy = vi.spyOn(paymentsService, 'markFailed');

    await reconcilePendingPayments(paymentsService, () =>
      fakeProvider('mercadopago', {
        // What a prefix/fuzzy-matching search would hand back: a real, PAID
        // payment — for order `${number}2`, not for this order.
        searchByReference: async () => ({
          providerRef: 'mp-payment-belonging-to-another-order',
          status: 'PAID' as const,
          reference: `${reference}-wrong`,
          amountCents: 25_000,
          currency: 'COP',
        }),
      }),
    );

    expect(callsForOrder(markPaidSpy, orderId)).toHaveLength(0);
    expect(callsForOrder(markFailedSpy, orderId)).toHaveLength(0);
    const after = await prisma.order.findUnique({ where: { id: orderId } });
    expect(after?.status).toBe('PENDING');
    expect(after?.paymentStatus).toBe('PENDING');
    expect(after?.providerRef).toBeNull();
    expect(after?.stockReservedUntil).not.toBeNull();
    expect(await prisma.orderEvent.count({ where: { orderId } })).toBe(0);
  });

  it('a search result with NO reference at all (undefined) settles nothing', async () => {
    const { tenantId } = await signUpWithTenant('recon-bind-search-no-ref@demo.co', 'owner');
    await paymentsService.saveProviderCredentials(tenantId, 'mercadopago', FAKE_MP_CREDS);
    const { orderId } = await seedOnlineOrder(tenantId, {
      provider: 'mercadopago',
      providerRef: null,
      ageMinutes: 7,
      reservedForMinutes: 8,
    });

    vi.spyOn(console, 'error').mockImplementation(() => {});
    const markPaidSpy = vi.spyOn(paymentsService, 'markPaid');
    const markFailedSpy = vi.spyOn(paymentsService, 'markFailed');

    await reconcilePendingPayments(paymentsService, () =>
      fakeProvider('mercadopago', {
        // An adapter that genuinely could not read `external_reference` emits
        // `undefined` rather than fabricating one — and `undefined` is a
        // REJECTION here, never a pass, exactly as on the by-id path.
        searchByReference: async () => ({ providerRef: 'mp-payment-unverifiable', status: 'PAID' as const }),
      }),
    );

    expect(callsForOrder(markPaidSpy, orderId)).toHaveLength(0);
    expect(callsForOrder(markFailedSpy, orderId)).toHaveLength(0);
    const after = await prisma.order.findUnique({ where: { id: orderId } });
    expect(after?.status).toBe('PENDING');
    expect(after?.paymentStatus).toBe('PENDING');
    expect(after?.providerRef).toBeNull();
    expect(after?.stockReservedUntil).not.toBeNull();
  });

  it('a search result with a MATCHING reference but a mismatched amountCents settles nothing', async () => {
    const { tenantId } = await signUpWithTenant('recon-bind-search-wrong-amount@demo.co', 'owner');
    await paymentsService.saveProviderCredentials(tenantId, 'mercadopago', FAKE_MP_CREDS);
    const { orderId, reference } = await seedOnlineOrder(tenantId, {
      provider: 'mercadopago',
      providerRef: null,
      ageMinutes: 7,
      reservedForMinutes: 8,
      totalCents: 25_000,
    });

    vi.spyOn(console, 'error').mockImplementation(() => {});
    const markPaidSpy = vi.spyOn(paymentsService, 'markPaid');

    await reconcilePendingPayments(paymentsService, () =>
      fakeProvider('mercadopago', {
        // Right order number, wrong money — an amount binding that simply did
        // not exist on this path before.
        searchByReference: async () => ({
          providerRef: 'mp-payment-underpaid',
          status: 'PAID' as const,
          reference,
          amountCents: 100_000,
          currency: 'COP',
        }),
      }),
    );

    expect(callsForOrder(markPaidSpy, orderId)).toHaveLength(0);
    const after = await prisma.order.findUnique({ where: { id: orderId } });
    expect(after?.status).toBe('PENDING');
    expect(after?.paymentStatus).toBe('PENDING');
    expect(after?.providerRef).toBeNull();
    expect(after?.stockReservedUntil).not.toBeNull();
  });

  it('a search result whose OWN reference and amount both match does settle', async () => {
    const { tenantId } = await signUpWithTenant('recon-bind-search-ok@demo.co', 'owner');
    await paymentsService.saveProviderCredentials(tenantId, 'mercadopago', FAKE_MP_CREDS);
    const { orderId, reference } = await seedOnlineOrder(tenantId, {
      provider: 'mercadopago',
      providerRef: null,
      ageMinutes: 7,
      reservedForMinutes: 8,
      totalCents: 25_000,
    });

    await reconcilePendingPayments(paymentsService, () =>
      fakeProvider('mercadopago', {
        searchByReference: async () => ({
          providerRef: 'mp-payment-445566',
          status: 'PAID' as const,
          reference,
          amountCents: 25_000,
          currency: 'COP',
        }),
      }),
    );

    const after = await prisma.order.findUnique({ where: { id: orderId } });
    expect(after?.status).toBe('CONFIRMED');
    expect(after?.paymentStatus).toBe('PAID');
    expect(after?.providerRef).toBe('mp-payment-445566');
    expect(after?.stockReservedUntil).toBeNull();
  });

  it('a matching reference with NO amountCents at all still settles (the amount check only binds when available)', async () => {
    const { tenantId } = await signUpWithTenant('recon-bind-no-amount@demo.co', 'owner');
    await paymentsService.saveProviderCredentials(tenantId, 'wompi', FAKE_WOMPI_CREDS);
    const { orderId, reference } = await seedOnlineOrder(tenantId, {
      provider: 'wompi',
      providerRef: 'wompi_txn_no_amount',
      ageMinutes: 6,
      reservedForMinutes: 9,
    });

    await reconcilePendingPayments(paymentsService, () =>
      fakeProvider('wompi', {
        getTransactionStatus: async () => status('PAID', { reference }),
      }),
    );

    const after = await prisma.order.findUnique({ where: { id: orderId } });
    expect(after?.status).toBe('CONFIRMED');
    expect(after?.paymentStatus).toBe('PAID');
  });
});

describe('reconcilePendingPayments — (f) a gateway call that throws', () => {
  it('skips only that order this run and never aborts the rest of the batch', async () => {
    const { tenantId } = await signUpWithTenant('recon-throws@demo.co', 'owner');
    await paymentsService.saveProviderCredentials(tenantId, 'wompi', FAKE_WOMPI_CREDS);
    const broken = await seedOnlineOrder(tenantId, {
      provider: 'wompi',
      providerRef: 'wompi_txn_gateway_down',
      ageMinutes: 6,
      reservedForMinutes: 9,
    });
    const healthy = await seedOnlineOrder(tenantId, {
      provider: 'wompi',
      providerRef: 'wompi_txn_ok',
      ageMinutes: 6,
      reservedForMinutes: 9,
    });

    vi.spyOn(console, 'error').mockImplementation(() => {});

    // No `expect().rejects` — the sweep itself must resolve normally.
    await reconcilePendingPayments(paymentsService, () =>
      fakeProvider('wompi', {
        getTransactionStatus: async (providerRef: string) => {
          if (providerRef === 'wompi_txn_gateway_down') {
            throw new Error('simulated gateway failure: getaddrinfo ENOTFOUND');
          }
          return status('PAID', { reference: healthy.reference, amountCents: 25_000 });
        },
      }),
    );

    // The broken one: untouched, NEVER treated as a FAILED payment.
    const brokenAfter = await prisma.order.findUnique({ where: { id: broken.orderId } });
    expect(brokenAfter?.status).toBe('PENDING');
    expect(brokenAfter?.paymentStatus).toBe('PENDING');
    expect(brokenAfter?.stockReservedUntil).not.toBeNull();

    // The healthy one, in the SAME batch, still got processed.
    const healthyAfter = await prisma.order.findUnique({ where: { id: healthy.orderId } });
    expect(healthyAfter?.status).toBe('CONFIRMED');
    expect(healthyAfter?.paymentStatus).toBe('PAID');
  });
});

describe('reconcilePendingPayments — (g) threshold ordering vs. the 15-minute stock-expiry worker', () => {
  // Design decision 4's core safety claim, proven with REAL timestamps against
  // the REAL, unmodified stock-reservation worker — not by reading the two
  // constants and trusting them to be ordered.
  it('reconciliation reaches a 6-minute-old order that the expiry worker still would not touch', async () => {
    const { tenantId } = await signUpWithTenant('recon-threshold-order@demo.co', 'owner');
    await paymentsService.saveProviderCredentials(tenantId, 'wompi', FAKE_WOMPI_CREDS);
    const product = await seedProduct(tenantId, 6); // checkout already took 10 -> 6 for qty 4
    const { orderId, reference } = await seedOnlineOrder(tenantId, {
      provider: 'wompi',
      providerRef: 'wompi_txn_threshold',
      // 6 minutes old: PAST the 5-minute reconciliation floor...
      ageMinutes: 6,
      // ...but its 15-minute hold still has 9 real minutes left to run.
      reservedForMinutes: 9,
      productId: product.id,
      qty: 4,
    });

    // 1. The existing expiry worker, run FIRST against the very same row:
    //    it does nothing, because the reservation has not lapsed.
    await expireReservations();
    const afterExpirySweep = await prisma.order.findUnique({ where: { id: orderId } });
    expect(afterExpirySweep?.status).toBe('PENDING');
    expect(afterExpirySweep?.paymentStatus).toBe('PENDING');
    expect(afterExpirySweep?.stockReservedUntil).not.toBeNull();

    // 2. Reconciliation, at that same instant, DOES reach it and settles it.
    await reconcilePendingPayments(paymentsService, () =>
      fakeProvider('wompi', {
        getTransactionStatus: async () => status('PAID', { reference, amountCents: 25_000 }),
      }),
    );
    const afterRecon = await prisma.order.findUnique({ where: { id: orderId } });
    expect(afterRecon?.status).toBe('CONFIRMED');
    expect(afterRecon?.paymentStatus).toBe('PAID');
    expect(afterRecon?.stockReservedUntil).toBeNull();

    // 3. The expiry worker can now never touch it: markPaid cleared
    //    stockReservedUntil and moved status off PENDING, so its own candidate
    //    query no longer matches. No restock, no cancellation, no undo needed.
    await expireReservations();
    const afterSecondExpirySweep = await prisma.order.findUnique({ where: { id: orderId } });
    expect(afterSecondExpirySweep?.status).toBe('CONFIRMED');
    expect(afterSecondExpirySweep?.paymentStatus).toBe('PAID');
    const productAfter = await prisma.product.findUnique({ where: { id: product.id } });
    expect(productAfter?.stock).toBe(6); // never restocked
    expect(await prisma.orderEvent.count({ where: { orderId, type: 'reservation_expired' } })).toBe(0);
  });
});

describe('reconcilePendingPayments — a tenant with no saved credentials', () => {
  it('is skipped without throwing (no config to authenticate a gateway call with)', async () => {
    const { tenantId } = await signUpWithTenant('recon-no-creds@demo.co', 'owner');
    const { orderId } = await seedOnlineOrder(tenantId, {
      provider: 'wompi',
      providerRef: 'wompi_txn_orphan',
      ageMinutes: 6,
      reservedForMinutes: 9,
    });

    vi.spyOn(console, 'error').mockImplementation(() => {});
    const getTransactionStatus = vi.fn(async () => status('PAID'));
    await reconcilePendingPayments(paymentsService, () =>
      fakeProvider('wompi', { getTransactionStatus }),
    );

    expect(getTransactionStatus).not.toHaveBeenCalled();
    const after = await prisma.order.findUnique({ where: { id: orderId } });
    expect(after?.paymentStatus).toBe('PENDING');
  });
});

describe('reconcilePendingPayments — (h) the candidate query is bounded and deterministically ordered', () => {
  // Without a `take`, a platform-wide gateway outage means one sweep issues N
  // sequential HTTP calls (N = every unsettled online order across every
  // tenant) while the 2-minute repeat keeps firing on top of it. Without a
  // deterministic ORDER, a bounded sweep could also keep re-reading the same
  // arbitrary slice forever and starve the rest.
  // Asserted through REAL BEHAVIOUR (how many orders one sweep actually
  // touches, and which ones), not by inspecting the Prisma call's arguments:
  // `platformDb.order.findMany` is a proxied delegate that cannot be spied on
  // without breaking the client for the rest of the file.
  it('touches at most RECONCILE_BATCH_LIMIT orders per sweep, oldest first', async () => {
    const { tenantId } = await signUpWithTenant('recon-bounded-query@demo.co', 'owner');
    await paymentsService.saveProviderCredentials(tenantId, 'wompi', FAKE_WOMPI_CREDS);

    const overflow = 5;
    const total = RECONCILE_BATCH_LIMIT + overflow;
    const now = Date.now();
    // Index 0 is the NEWEST, index total-1 the OLDEST — so the last
    // `overflow` orders by age are exactly the ones a bounded, oldest-first
    // sweep must leave for the next run.
    await prisma.order.createMany({
      data: Array.from({ length: total }, (_, i) => ({
        tenantId,
        number: orderNumberSeq++,
        reference: generateOrderReference(),
        status: 'PENDING' as const,
        paymentStatus: 'PENDING' as const,
        paymentProvider: 'wompi',
        providerRef: `wompi_txn_bounded_${i}`,
        // Same default `seedOnlineOrder` applies (P3 wave-2 FIX 3): these
        // fixtures stand for refs a real signature-verified webhook stamped.
        // Without it the worker would refuse the by-id lookup on provenance
        // grounds and this test would measure nothing.
        providerRefSource: 'verified',
        stockReservedUntil: new Date(now + 9 * 60_000),
        createdAt: new Date(now - 6 * 60_000 - i * 1_000),
        email: 'comprador@example.com',
        phone: '3000000000',
        shippingAddress: {},
        subtotalCents: 25_000,
        taxCents: 0,
        totalCents: 25_000,
      })),
    });

    const seen = new Set<string>();
    await reconcilePendingPayments(paymentsService, () =>
      fakeProvider('wompi', {
        getTransactionStatus: async (providerRef: string) => {
          seen.add(providerRef);
          // Still PENDING per the gateway: this sweep settles nothing, so the
          // only thing being measured is HOW MANY orders it reached.
          return status('PENDING');
        },
      }),
    );

    expect(RECONCILE_BATCH_LIMIT).toBeGreaterThan(0);
    expect(seen.size).toBe(RECONCILE_BATCH_LIMIT);
    // The oldest was reached...
    expect(seen.has(`wompi_txn_bounded_${total - 1}`)).toBe(true);
    // ...and the newest `overflow` were deferred to the next 2-minute run
    // rather than being starved by an arbitrary, unordered page.
    for (let i = 0; i < overflow; i++) {
      expect(seen.has(`wompi_txn_bounded_${i}`)).toBe(false);
    }
  }, 60_000);
});

describe('reconcilePendingPayments — COD and already-settled orders are out of scope', () => {
  it('never selects a COD order or one whose reservation was already cleared', async () => {
    const { tenantId } = await signUpWithTenant('recon-cod@demo.co', 'owner');
    await paymentsService.saveProviderCredentials(tenantId, 'wompi', FAKE_WOMPI_CREDS);

    const cod = await seedOnlineOrder(tenantId, {
      provider: null,
      ageMinutes: 30,
      reservedForMinutes: null,
      paymentStatus: 'COD',
    });
    const noReservation = await seedOnlineOrder(tenantId, {
      provider: 'wompi',
      providerRef: 'wompi_txn_no_reservation',
      ageMinutes: 30,
      reservedForMinutes: null,
    });

    const getTransactionStatus = vi.fn(async () => status('PAID'));
    await reconcilePendingPayments(paymentsService, () =>
      fakeProvider('wompi', { getTransactionStatus }),
    );

    expect(getTransactionStatus).not.toHaveBeenCalled();
    expect((await prisma.order.findUnique({ where: { id: cod.orderId } }))?.paymentStatus).toBe('COD');
    expect((await prisma.order.findUnique({ where: { id: noReservation.orderId } }))?.paymentStatus).toBe(
      'PENDING',
    );
  });
});

// ---------------------------------------------------------------------------
// P3 wave-2 regression tests. Each block below fails against the pre-fix code.
// ---------------------------------------------------------------------------

describe('reconcilePendingPayments — FIX 1: a DECLINED-then-retried order stays recoverable', () => {
  // The live repro this closes, end to end:
  //
  //   PENDING/PENDING → attempt 1 declined → PENDING/FAILED
  //                   → attempt 2 APPROVED → PENDING/FAILED   ← webhook lost
  //                   → reconciliation      → settled = 0     ← THIS test
  //                   → 15-min expiry       → CANCELLED/EXPIRED, stock restocked
  //
  // The shopper WAS charged. Before the fix the candidate query filtered
  // `paymentStatus: 'PENDING'`, so a declined attempt removed the order from
  // reconciliation permanently and nothing was left to recover a lost retry
  // webhook.
  it('a PENDING/FAILED order is still a candidate and recovers to CONFIRMED/PAID', async () => {
    const { tenantId } = await signUpWithTenant('recon-failed-retry@demo.co', 'owner');
    await paymentsService.saveProviderCredentials(tenantId, 'wompi', FAKE_WOMPI_CREDS);
    const { orderId, reference } = await seedOnlineOrder(tenantId, {
      provider: 'wompi',
      // Attempt 1's ref, stamped by its (genuine) FAILED webhook.
      providerRef: 'wompi_txn_attempt_1_declined',
      ageMinutes: 6,
      reservedForMinutes: 9,
      totalCents: 25_000,
      paymentStatus: 'FAILED',
    });

    const getTransactionStatus = vi.fn(async () =>
      // Attempt 2 went through; Wompi says so when asked.
      status('PAID', { reference, amountCents: 25_000 }),
    );

    const settled = await reconcilePendingPayments(paymentsService, () =>
      fakeProvider('wompi', { getTransactionStatus }),
    );

    expect(getTransactionStatus).toHaveBeenCalled();
    expect(settled).toBeGreaterThan(0);
    const after = await prisma.order.findUnique({ where: { id: orderId } });
    expect(after?.status).toBe('CONFIRMED');
    expect(after?.paymentStatus).toBe('PAID');
    expect(after?.stockReservedUntil).toBeNull();
    expect(await prisma.orderEvent.count({ where: { orderId, type: 'payment_confirmed' } })).toBe(1);
  });

  it('a FAILED order the gateway still calls FAILED is left exactly as it was (no churn, no second event)', async () => {
    const { tenantId } = await signUpWithTenant('recon-failed-stays-failed@demo.co', 'owner');
    await paymentsService.saveProviderCredentials(tenantId, 'wompi', FAKE_WOMPI_CREDS);
    const { orderId, reference } = await seedOnlineOrder(tenantId, {
      provider: 'wompi',
      providerRef: 'wompi_txn_still_declined',
      ageMinutes: 6,
      reservedForMinutes: 9,
      totalCents: 25_000,
      paymentStatus: 'FAILED',
    });

    await reconcilePendingPayments(paymentsService, () =>
      fakeProvider('wompi', {
        getTransactionStatus: async () => status('FAILED', { reference, amountCents: 25_000 }),
      }),
    );

    const after = await prisma.order.findUnique({ where: { id: orderId } });
    expect(after?.status).toBe('PENDING');
    expect(after?.paymentStatus).toBe('FAILED');
    // markFailed still requires PENDING/PENDING, so re-settling an
    // already-FAILED order is a no-op and writes no duplicate event.
    expect(await prisma.orderEvent.count({ where: { orderId, type: 'payment_failed' } })).toBe(0);
  });
});

describe('reconcilePendingPayments — the returned count is TRANSITIONS, not settle-path calls (wave 3)', () => {
  // `settledCount` incremented whenever `reconcileOneOrder` had CALLED a settle
  // path, but both settle paths no-op outside their own preconditions — so the
  // operator-facing `[reconciliation-worker] reconciled N order(s)` line could
  // name orders nothing whatsoever happened to. Same root cause as the webhook
  // controller's `result: 'confirmed'` lie, one layer up.
  it('an already-FAILED order the gateway still calls FAILED is NOT counted (markFailed no-ops)', async () => {
    const { tenantId } = await signUpWithTenant('recon-count-noop-failed@demo.co', 'owner');
    await paymentsService.saveProviderCredentials(tenantId, 'wompi', FAKE_WOMPI_CREDS);
    const { orderId, reference } = await seedOnlineOrder(tenantId, {
      provider: 'wompi',
      providerRef: 'wompi_txn_count_still_declined',
      ageMinutes: 6,
      reservedForMinutes: 9,
      totalCents: 25_000,
      // A candidate (wave-2 FIX 1 put FAILED back in the candidate set) whose
      // gateway answer is still FAILED — so `markFailed` is genuinely called
      // and genuinely does nothing, since it requires PENDING/PENDING exactly.
      paymentStatus: 'FAILED',
    });

    const settled = await reconcilePendingPayments(paymentsService, () =>
      fakeProvider('wompi', {
        getTransactionStatus: async () => status('FAILED', { reference, amountCents: 25_000 }),
      }),
    );

    expect(settled).toBe(0);
    const after = await prisma.order.findUnique({ where: { id: orderId } });
    expect(after?.paymentStatus).toBe('FAILED');
    expect(await prisma.orderEvent.count({ where: { orderId } })).toBe(0);
  });

  it('a settle that really transitions the order IS counted (the count still counts)', async () => {
    const { tenantId } = await signUpWithTenant('recon-count-real@demo.co', 'owner');
    await paymentsService.saveProviderCredentials(tenantId, 'wompi', FAKE_WOMPI_CREDS);
    const { orderId, reference } = await seedOnlineOrder(tenantId, {
      provider: 'wompi',
      providerRef: 'wompi_txn_count_real',
      ageMinutes: 6,
      reservedForMinutes: 9,
      totalCents: 25_000,
    });

    const settled = await reconcilePendingPayments(paymentsService, () =>
      fakeProvider('wompi', {
        getTransactionStatus: async () => status('PAID', { reference, amountCents: 25_000 }),
      }),
    );

    expect(settled).toBe(1);
    expect((await prisma.order.findUnique({ where: { id: orderId } }))?.paymentStatus).toBe('PAID');
  });

  it('a markPaid that no-ops under a race is not counted either', async () => {
    // The narrow window the candidate query cannot close: the order qualified
    // when it was read, and something else (a webhook delivery, an admin
    // action) settled or cancelled it before this sweep reached the settle.
    // `markPaid` correctly no-ops; the count must not claim otherwise.
    const { tenantId } = await signUpWithTenant('recon-count-race@demo.co', 'owner');
    await paymentsService.saveProviderCredentials(tenantId, 'wompi', FAKE_WOMPI_CREDS);
    const { orderId, reference } = await seedOnlineOrder(tenantId, {
      provider: 'wompi',
      providerRef: 'wompi_txn_count_race',
      ageMinutes: 6,
      reservedForMinutes: 9,
      totalCents: 25_000,
    });

    const markPaidSpy = vi.spyOn(paymentsService, 'markPaid').mockImplementation(async () => false);

    const settled = await reconcilePendingPayments(paymentsService, () =>
      fakeProvider('wompi', {
        getTransactionStatus: async () => status('PAID', { reference, amountCents: 25_000 }),
      }),
    );

    expect(callsForOrder(markPaidSpy, orderId)).toHaveLength(1);
    expect(settled).toBe(0);
  });
});

describe('reconcilePendingPayments — FIX 2: an order whose status already moved on is never a candidate', () => {
  // The zombie the `status: 'PENDING'` filter kills. A merchant pressing
  // "Confirmar pedido" on an online-payment order left it CONFIRMED/PENDING
  // with `stockReservedUntil` still set — which matched the old candidate
  // query FOREVER (one gateway call + one settle attempt every 2 minutes for
  // the life of the order), while `expireReservations()` could never release
  // it because that sweep filters `status: 'PENDING'`.
  it('a CONFIRMED/PENDING order with a live reservation is skipped: no gateway call at all', async () => {
    const { tenantId } = await signUpWithTenant('recon-zombie@demo.co', 'owner');
    await paymentsService.saveProviderCredentials(tenantId, 'wompi', FAKE_WOMPI_CREDS);
    const { orderId } = await seedOnlineOrder(tenantId, {
      provider: 'wompi',
      providerRef: 'wompi_txn_zombie',
      ageMinutes: 6,
      reservedForMinutes: 9,
      status: 'CONFIRMED',
      paymentStatus: 'PENDING',
    });

    const getTransactionStatus = vi.fn(async () => status('PAID'));
    const settledCount = await reconcilePendingPayments(paymentsService, () =>
      fakeProvider('wompi', { getTransactionStatus }),
    );

    expect(getTransactionStatus).not.toHaveBeenCalled();
    expect(settledCount).toBe(0);
    const after = await prisma.order.findUnique({ where: { id: orderId } });
    expect(after?.status).toBe('CONFIRMED');
    expect(after?.paymentStatus).toBe('PENDING');
  });
});

describe('reconcilePendingPayments — FIX 3a: the CURRENCY binding', () => {
  // There was no currency term anywhere in this system: all three adapters
  // sent `CHECKOUT_CURRENCY = 'COP'` outbound and nothing read one back, so a
  // payment of the same NUMBER of units in another currency satisfied the
  // amount check exactly as well as the real one.
  it('a matching reference and amount in a DIFFERENT currency settles nothing', async () => {
    const { tenantId } = await signUpWithTenant('recon-currency-usd@demo.co', 'owner');
    await paymentsService.saveProviderCredentials(tenantId, 'wompi', FAKE_WOMPI_CREDS);
    const { orderId, reference } = await seedOnlineOrder(tenantId, {
      provider: 'wompi',
      providerRef: 'wompi_txn_usd',
      ageMinutes: 6,
      reservedForMinutes: 9,
      totalCents: 25_000,
    });

    vi.spyOn(console, 'error').mockImplementation(() => {});
    const markPaidSpy = vi.spyOn(paymentsService, 'markPaid');

    await reconcilePendingPayments(paymentsService, () =>
      fakeProvider('wompi', {
        // 250,00 USD against a 250.000 COP order: same number, ~4.000x the money.
        getTransactionStatus: async () =>
          status('PAID', { reference, amountCents: 25_000, currency: 'USD' }),
      }),
    );

    expect(callsForOrder(markPaidSpy, orderId)).toHaveLength(0);
    const after = await prisma.order.findUnique({ where: { id: orderId } });
    expect(after?.status).toBe('PENDING');
    expect(after?.paymentStatus).toBe('PENDING');
    expect(after?.stockReservedUntil).not.toBeNull();
  });

  it('an amount with NO currency at all settles nothing (unverifiable is not a pass)', async () => {
    const { tenantId } = await signUpWithTenant('recon-currency-missing@demo.co', 'owner');
    await paymentsService.saveProviderCredentials(tenantId, 'wompi', FAKE_WOMPI_CREDS);
    const { orderId, reference } = await seedOnlineOrder(tenantId, {
      provider: 'wompi',
      providerRef: 'wompi_txn_no_currency',
      ageMinutes: 6,
      reservedForMinutes: 9,
      totalCents: 25_000,
    });

    vi.spyOn(console, 'error').mockImplementation(() => {});
    const markPaidSpy = vi.spyOn(paymentsService, 'markPaid');

    await reconcilePendingPayments(paymentsService, () =>
      fakeProvider('wompi', {
        getTransactionStatus: async () => ({
          status: 'PAID' as const,
          reference,
          amountCents: 25_000,
          // currency deliberately absent
        }),
      }),
    );

    expect(callsForOrder(markPaidSpy, orderId)).toHaveLength(0);
    expect((await prisma.order.findUnique({ where: { id: orderId } }))?.paymentStatus).toBe('PENDING');
  });

  it('a result with NO amount at all is still bound by reference alone, currency or not (unchanged behavior)', async () => {
    const { tenantId } = await signUpWithTenant('recon-currency-no-amount@demo.co', 'owner');
    await paymentsService.saveProviderCredentials(tenantId, 'wompi', FAKE_WOMPI_CREDS);
    const { orderId, reference } = await seedOnlineOrder(tenantId, {
      provider: 'wompi',
      providerRef: 'wompi_txn_no_amount_no_currency',
      ageMinutes: 6,
      reservedForMinutes: 9,
    });

    await reconcilePendingPayments(paymentsService, () =>
      fakeProvider('wompi', {
        getTransactionStatus: async () => ({ status: 'PAID' as const, reference }),
      }),
    );

    const after = await prisma.order.findUnique({ where: { id: orderId } });
    expect(after?.status).toBe('CONFIRMED');
    expect(after?.paymentStatus).toBe('PAID');
  });
});

describe('reconcilePendingPayments — FIX 3b: a HINT-sourced providerRef on a non-account-scoped provider', () => {
  // The exploit: ePayco's lookup takes no credential at all and Wompi's was
  // observed answering with none, so `reference`/`amountCents`/`currency` —
  // every term the binding check compares — are all values the PAYER chose. An
  // attacker with their own merchant account pays THEMSELVES a transaction
  // carrying the victim's order number and total, plants its id through the
  // unauthenticated hint endpoint, and the binding passes TRUTHFULLY.
  it.each([
    ['wompi', FAKE_WOMPI_CREDS] as const,
    ['epayco', FAKE_WOMPI_CREDS] as const,
  ])(
    '%s: a truthfully-binding PAID lookup from a hinted ref settles nothing, and the gateway is never even asked',
    async (providerId, creds) => {
      const { tenantId } = await signUpWithTenant(`recon-hint-${providerId}@demo.co`, 'owner');
      await paymentsService.saveProviderCredentials(tenantId, providerId, creds);
      const { orderId, reference } = await seedOnlineOrder(tenantId, {
        provider: providerId,
        providerRef: 'attacker_planted_txn_paid_into_their_own_account',
        providerRefSource: 'hint',
        ageMinutes: 6,
        reservedForMinutes: 9,
        totalCents: 25_000,
      });

      vi.spyOn(console, 'error').mockImplementation(() => {});
      const markPaidSpy = vi.spyOn(paymentsService, 'markPaid');
      const getTransactionStatus = vi.fn(async () =>
        // Everything matches. That is the whole point — the values are the
        // attacker's to choose.
        status('PAID', { reference, amountCents: 25_000, currency: 'COP' }),
      );

      await reconcilePendingPayments(paymentsService, () =>
        fakeProvider(providerId, { getTransactionStatus }),
      );

      expect(getTransactionStatus).not.toHaveBeenCalled();
      expect(callsForOrder(markPaidSpy, orderId)).toHaveLength(0);
      const after = await prisma.order.findUnique({ where: { id: orderId } });
      expect(after?.status).toBe('PENDING');
      expect(after?.paymentStatus).toBe('PENDING');
      expect(after?.stockReservedUntil).not.toBeNull();
    },
  );

  it('a NULL providerRefSource (a pre-migration row of unknown provenance) is treated as untrusted too', async () => {
    const { tenantId } = await signUpWithTenant('recon-hint-null-source@demo.co', 'owner');
    await paymentsService.saveProviderCredentials(tenantId, 'wompi', FAKE_WOMPI_CREDS);
    const { orderId, reference } = await seedOnlineOrder(tenantId, {
      provider: 'wompi',
      providerRef: 'ref_of_unknown_provenance',
      providerRefSource: null,
      ageMinutes: 6,
      reservedForMinutes: 9,
      totalCents: 25_000,
    });

    vi.spyOn(console, 'error').mockImplementation(() => {});
    const getTransactionStatus = vi.fn(async () =>
      status('PAID', { reference, amountCents: 25_000 }),
    );

    await reconcilePendingPayments(paymentsService, () =>
      fakeProvider('wompi', { getTransactionStatus }),
    );

    expect(getTransactionStatus).not.toHaveBeenCalled();
    expect((await prisma.order.findUnique({ where: { id: orderId } }))?.paymentStatus).toBe('PENDING');
  });

  it("a webhook-VERIFIED ref on the same provider still settles — this gate is about provenance, not about wompi", async () => {
    const { tenantId } = await signUpWithTenant('recon-verified-still-works@demo.co', 'owner');
    await paymentsService.saveProviderCredentials(tenantId, 'wompi', FAKE_WOMPI_CREDS);
    const { orderId, reference } = await seedOnlineOrder(tenantId, {
      provider: 'wompi',
      providerRef: 'wompi_txn_stamped_by_a_real_webhook',
      providerRefSource: 'verified',
      ageMinutes: 6,
      reservedForMinutes: 9,
      totalCents: 25_000,
    });

    await reconcilePendingPayments(paymentsService, () =>
      fakeProvider('wompi', {
        getTransactionStatus: async () => status('PAID', { reference, amountCents: 25_000 }),
      }),
    );

    const after = await prisma.order.findUnique({ where: { id: orderId } });
    expect(after?.status).toBe('CONFIRMED');
    expect(after?.paymentStatus).toBe('PAID');
  });

  it('mercadopago IS account-scoped, so a hinted ref there is still looked up by id', async () => {
    const { tenantId } = await signUpWithTenant('recon-hint-mp-allowed@demo.co', 'owner');
    await paymentsService.saveProviderCredentials(tenantId, 'mercadopago', FAKE_MP_CREDS);
    const { orderId, reference } = await seedOnlineOrder(tenantId, {
      provider: 'mercadopago',
      providerRef: 'mp-payment-from-the-return-page',
      providerRefSource: 'hint',
      ageMinutes: 6,
      reservedForMinutes: 9,
      totalCents: 25_000,
    });

    const getTransactionStatus = vi.fn(async () =>
      status('PAID', { reference, amountCents: 25_000 }),
    );

    await reconcilePendingPayments(paymentsService, () =>
      fakeProvider('mercadopago', { getTransactionStatus }),
    );

    // MP's lookup authenticates with the PRIVATE access token, so a truthful
    // answer there is necessarily about a payment into THIS tenant's account.
    expect(getTransactionStatus).toHaveBeenCalled();
    const after = await prisma.order.findUnique({ where: { id: orderId } });
    expect(after?.status).toBe('CONFIRMED');
    expect(after?.paymentStatus).toBe('PAID');
  });
});

describe('reconcilePendingPayments — FIX 4: a planted bogus ref no longer suppresses self-healing', () => {
  // Before: the worker PREFERRED `order.providerRef` over `searchByReference`,
  // so an attacker converted a RECOVERABLE order into a LOST one — an MP order
  // with no ref self-heals to CONFIRMED/PAID off the search, but the same
  // order with a bogus ref planted stopped at the failed by-id lookup and was
  // cancelled and restocked with the shopper's money already taken.
  it('a by-id lookup that fails to bind falls back to searchByReference and settles', async () => {
    const { tenantId } = await signUpWithTenant('recon-fallback-search@demo.co', 'owner');
    await paymentsService.saveProviderCredentials(tenantId, 'mercadopago', FAKE_MP_CREDS);
    const { orderId, number, reference } = await seedOnlineOrder(tenantId, {
      provider: 'mercadopago',
      providerRef: 'bogus-ref-planted-by-an-attacker',
      providerRefSource: 'hint',
      ageMinutes: 7,
      reservedForMinutes: 8,
      totalCents: 25_000,
    });

    vi.spyOn(console, 'error').mockImplementation(() => {});
    const getTransactionStatus = vi.fn(async () =>
      // A real, PAID payment — for a DIFFERENT order. Truthful, and useless.
      status('PAID', { reference: `${number}9`, amountCents: 25_000 }),
    );
    const searchByReference = vi.fn(async () => ({
      providerRef: 'mp-payment-the-shopper-actually-made',
      status: 'PAID' as const,
      reference,
      amountCents: 25_000,
      currency: 'COP',
    }));

    await reconcilePendingPayments(paymentsService, () =>
      fakeProvider('mercadopago', { getTransactionStatus, searchByReference }),
    );

    expect(getTransactionStatus).toHaveBeenCalled();
    expect(searchByReference).toHaveBeenCalledWith(String(number), expect.anything());
    const after = await prisma.order.findUnique({ where: { id: orderId } });
    expect(after?.status).toBe('CONFIRMED');
    expect(after?.paymentStatus).toBe('PAID');
    // Settled with the ref the GATEWAY vouched for, not the planted one.
    expect(after?.providerRef).toBe('mp-payment-the-shopper-actually-made');
    expect(after?.providerRefSource).toBe('verified');
  });

  it('the same fallback runs when the by-id lookup was REFUSED for provenance (search, then settle)', async () => {
    const { tenantId } = await signUpWithTenant('recon-fallback-after-refusal@demo.co', 'owner');
    await paymentsService.saveProviderCredentials(tenantId, 'mercadopago', FAKE_MP_CREDS);
    const { orderId, reference } = await seedOnlineOrder(tenantId, {
      provider: 'mercadopago',
      providerRef: 'planted',
      providerRefSource: 'hint',
      ageMinutes: 7,
      reservedForMinutes: 8,
      totalCents: 25_000,
    });

    vi.spyOn(console, 'error').mockImplementation(() => {});
    // MP is account-scoped so the by-id call IS made; script it to return a
    // result that cannot bind (no reference), then prove the search still runs.
    const getTransactionStatus = vi.fn(async () => ({ status: 'PAID' as const }));
    const searchByReference = vi.fn(async () => ({
      providerRef: 'mp-payment-real',
      status: 'PAID' as const,
      reference,
      amountCents: 25_000,
      currency: 'COP',
    }));

    await reconcilePendingPayments(paymentsService, () =>
      fakeProvider('mercadopago', { getTransactionStatus, searchByReference }),
    );

    expect(searchByReference).toHaveBeenCalled();
    const after = await prisma.order.findUnique({ where: { id: orderId } });
    expect(after?.paymentStatus).toBe('PAID');
    expect(after?.providerRef).toBe('mp-payment-real');
  });

  it('a provider with NO searchByReference and an unbindable by-id result is still left alone', async () => {
    const { tenantId } = await signUpWithTenant('recon-fallback-none@demo.co', 'owner');
    await paymentsService.saveProviderCredentials(tenantId, 'wompi', FAKE_WOMPI_CREDS);
    const { orderId, number } = await seedOnlineOrder(tenantId, {
      provider: 'wompi',
      providerRef: 'wompi_txn_verified_but_wrong_order',
      ageMinutes: 6,
      reservedForMinutes: 9,
      totalCents: 25_000,
    });

    vi.spyOn(console, 'error').mockImplementation(() => {});
    const markPaidSpy = vi.spyOn(paymentsService, 'markPaid');

    await reconcilePendingPayments(paymentsService, () =>
      fakeProvider('wompi', {
        getTransactionStatus: async () => status('PAID', { reference: `${number}7`, amountCents: 25_000 }),
      }),
    );

    expect(callsForOrder(markPaidSpy, orderId)).toHaveLength(0);
    expect((await prisma.order.findUnique({ where: { id: orderId } }))?.paymentStatus).toBe('PENDING');
  });
});
