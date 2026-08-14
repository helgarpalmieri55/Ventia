import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
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
  ({ reconcilePendingPayments } = await import('../src/payments/reconciliation.worker'));
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
): Promise<{ orderId: string; number: number }> {
  const now = Date.now();
  const order = await prisma.order.create({
    data: {
      tenantId,
      number: orderNumberSeq++,
      status: opts.status ?? 'PENDING',
      paymentStatus: opts.paymentStatus ?? 'PENDING',
      paymentProvider: opts.provider,
      providerRef: opts.providerRef ?? null,
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
  return { orderId: order.id, number: order.number };
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

function status(s: NormalizedStatus, extra: Partial<TransactionStatusResult> = {}): TransactionStatusResult {
  return { status: s, ...extra };
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
    const { orderId, number } = await seedOnlineOrder(tenantId, {
      provider: 'wompi',
      providerRef: 'wompi_txn_real_paid_1',
      ageMinutes: 6,
      reservedForMinutes: 9,
      totalCents: 25_000,
    });

    const getTransactionStatus = vi.fn(async () =>
      status('PAID', { reference: String(number), amountCents: 25_000 }),
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
    const { orderId, number } = await seedOnlineOrder(tenantId, {
      provider: 'wompi',
      providerRef: 'wompi_txn_declined_1',
      ageMinutes: 6,
      reservedForMinutes: 9,
    });

    await reconcilePendingPayments(paymentsService, () =>
      fakeProvider('wompi', {
        getTransactionStatus: async () => status('FAILED', { reference: String(number), amountCents: 25_000 }),
      }),
    );

    const after = await prisma.order.findUnique({ where: { id: orderId } });
    expect(after?.paymentStatus).toBe('FAILED');
    expect(after?.status).toBe('PENDING'); // untouched
    expect(after?.stockReservedUntil).not.toBeNull(); // untouched — this job never releases stock
    expect(await prisma.orderEvent.count({ where: { orderId, type: 'payment_failed' } })).toBe(1);
  });
});

describe('reconcilePendingPayments — (c) an order younger than the 5-minute floor', () => {
  it('is not selected at all: no gateway call, no state change', async () => {
    const { tenantId } = await signUpWithTenant('recon-too-young@demo.co', 'owner');
    await paymentsService.saveProviderCredentials(tenantId, 'wompi', FAKE_WOMPI_CREDS);
    const { orderId, number } = await seedOnlineOrder(tenantId, {
      provider: 'wompi',
      providerRef: 'wompi_txn_young_1',
      ageMinutes: 1, // real timestamp, 1 minute old — well inside the 5-minute floor
      reservedForMinutes: 14,
    });

    const getTransactionStatus = vi.fn(async () => status('PAID', { reference: String(number) }));
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
    const { orderId, number } = await seedOnlineOrder(tenantId, {
      provider: 'mercadopago',
      providerRef: null,
      ageMinutes: 7,
      reservedForMinutes: 8,
    });

    const searchByReference = vi.fn(async () => ({ providerRef: 'mp-payment-112233', status: 'PAID' as const }));
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
    const { orderId, number } = await seedOnlineOrder(tenantId, {
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
          status('PAID', { reference: String(number), amountCents: 100_000 }),
      }),
    );

    expect(callsForOrder(markPaidSpy, orderId)).toHaveLength(0);
    const after = await prisma.order.findUnique({ where: { id: orderId } });
    expect(after?.status).toBe('PENDING');
    expect(after?.paymentStatus).toBe('PENDING');
    expect(after?.stockReservedUntil).not.toBeNull();
  });

  it('a matching reference with NO amountCents at all still settles (the amount check only binds when available)', async () => {
    const { tenantId } = await signUpWithTenant('recon-bind-no-amount@demo.co', 'owner');
    await paymentsService.saveProviderCredentials(tenantId, 'wompi', FAKE_WOMPI_CREDS);
    const { orderId, number } = await seedOnlineOrder(tenantId, {
      provider: 'wompi',
      providerRef: 'wompi_txn_no_amount',
      ageMinutes: 6,
      reservedForMinutes: 9,
    });

    await reconcilePendingPayments(paymentsService, () =>
      fakeProvider('wompi', {
        getTransactionStatus: async () => status('PAID', { reference: String(number) }),
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
          return status('PAID', { reference: String(healthy.number), amountCents: 25_000 });
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
    const { orderId, number } = await seedOnlineOrder(tenantId, {
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
        getTransactionStatus: async () => status('PAID', { reference: String(number), amountCents: 25_000 }),
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
