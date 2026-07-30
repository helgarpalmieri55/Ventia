import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient as PrismaClientType, OrderStatus, PaymentStatus } from '@ventia/db';
import { startTestDb } from './helpers';
import type { signUpWithTenant as SignUpWithTenant } from './admin-helpers';
import type { PaymentsService as PaymentsServiceType } from '../src/payments/payments.service';

let db: Awaited<ReturnType<typeof startTestDb>>;
let redisContainer: StartedTestContainer;
let app: INestApplication;
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
  // / ./admin-helpers — same pattern as orders-transitions.test.ts.
  // PAYMENTS_ENCRYPTION_KEY: a real, valid 32-byte base64 key — this suite
  // exercises REAL encrypt/decrypt (encryption.ts), never mocked. Read
  // directly from process.env by `loadEncryptionKey()` (not `loadEnv()`),
  // so setting it here is sufficient without touching any other required
  // env var.
  process.env.DATABASE_URL = db.url;
  process.env.REDIS_URL = `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`;
  process.env.PAYMENTS_ENCRYPTION_KEY = Buffer.alloc(32, 42).toString('base64');

  const { createApp } = await import('../src/main');
  app = await createApp();
  await app.init();

  ({ signUpWithTenant } = await import('./admin-helpers'));
  ({ platformDb: prisma } = (await import('@ventia/db')) as unknown as { platformDb: PrismaClientType });

  const { PaymentsService } = await import('../src/payments/payments.service');
  paymentsService = app.get(PaymentsService);
}, 120_000);

afterAll(async () => {
  await app.close();
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

// Mercado Pago and ePayco equivalents of FAKE_CREDS — neither has
// `integritySecret` (Wompi-only, per `TenantProviderConfig`'s doc comment),
// and ePayco additionally carries `epaycoCustomerId` (P_CUST_ID_CLIENTE).
const FAKE_MP_CREDS = {
  publicKey: 'APP_USR-mp-public-key-1234567890',
  privateKey: 'APP_USR-mp-ACCESS-TOKEN-secret-abcdefghijk',
  eventsSecret: 'mp-events-secret-webhook-signing-key-0987',
  sandbox: true,
};

const FAKE_EPAYCO_CREDS = {
  publicKey: 'epayco-public-key-1234567890abcdef',
  privateKey: 'epayco-private-key-SECRET-abcdefghijklmnop',
  eventsSecret: 'epayco-P_KEY-secret-webhook-signing-9182736',
  epaycoCustomerId: 'epayco-P_CUST_ID_CLIENTE-1234',
  sandbox: true,
};

describe('PaymentsService.saveProviderCredentials / getTenantProviderConfig', () => {
  it('round-trips with REAL encryption: get returns exactly what was saved, decrypted', async () => {
    const { tenantId } = await signUpWithTenant('payments-svc-roundtrip@demo.co', 'owner');

    await paymentsService.saveProviderCredentials(tenantId, 'wompi', FAKE_CREDS);
    const cfg = await paymentsService.getTenantProviderConfig(tenantId, 'wompi');

    expect(cfg).toEqual({
      publicKey: FAKE_CREDS.publicKey,
      privateKey: FAKE_CREDS.privateKey,
      sandbox: FAKE_CREDS.sandbox,
      integritySecret: FAKE_CREDS.integritySecret,
      eventsSecret: FAKE_CREDS.eventsSecret,
    });
  });

  it('persists privateKey/integritySecret/eventsSecret as CIPHERTEXT, never plaintext, in the raw DB row', async () => {
    const { tenantId } = await signUpWithTenant('payments-svc-ciphertext@demo.co', 'owner');

    await paymentsService.saveProviderCredentials(tenantId, 'wompi', FAKE_CREDS);

    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    const settings = tenant.settings as Record<string, unknown>;
    const payments = settings.payments as Record<string, unknown>;
    const providers = payments.providers as Record<string, unknown>;
    const wompi = providers.wompi as Record<string, unknown>;

    // publicKey IS stored in cleartext (design decision: not a secret).
    expect(wompi.publicKey).toBe(FAKE_CREDS.publicKey);

    // Every actual secret is encrypted — the raw stored string must not
    // equal, or even contain, the plaintext.
    expect(wompi.privateKeyEncrypted).not.toBe(FAKE_CREDS.privateKey);
    expect(String(wompi.privateKeyEncrypted)).not.toContain(FAKE_CREDS.privateKey);
    expect(wompi.integritySecretEncrypted).not.toBe(FAKE_CREDS.integritySecret);
    expect(String(wompi.integritySecretEncrypted)).not.toContain(FAKE_CREDS.integritySecret);
    expect(wompi.eventsSecretEncrypted).not.toBe(FAKE_CREDS.eventsSecret);
    expect(String(wompi.eventsSecretEncrypted)).not.toContain(FAKE_CREDS.eventsSecret);

    // Ciphertext format sanity: "iv:tag:ciphertext" (encryption.ts's format).
    expect(String(wompi.privateKeyEncrypted).split(':')).toHaveLength(3);
  });

  it('returns null for a tenant with no saved provider config', async () => {
    const { tenantId } = await signUpWithTenant('payments-svc-unconfigured@demo.co', 'owner');
    const cfg = await paymentsService.getTenantProviderConfig(tenantId, 'wompi');
    expect(cfg).toBeNull();
  });

  it('saving credentials for one tenant does not affect another tenant (isolation)', async () => {
    const tenantA = await signUpWithTenant('payments-svc-isolation-a@demo.co', 'owner');
    const tenantB = await signUpWithTenant('payments-svc-isolation-b@demo.co', 'owner');

    await paymentsService.saveProviderCredentials(tenantA.tenantId, 'wompi', FAKE_CREDS);

    const cfgA = await paymentsService.getTenantProviderConfig(tenantA.tenantId, 'wompi');
    const cfgB = await paymentsService.getTenantProviderConfig(tenantB.tenantId, 'wompi');

    expect(cfgA).not.toBeNull();
    expect(cfgB).toBeNull();
  });

  it('does not clobber codEnabled already saved at the payments level (merge-in-place at the service layer)', async () => {
    const { tenantId } = await signUpWithTenant('payments-svc-preserve-codenabled@demo.co', 'owner');

    // Seed codEnabled directly (simulating an earlier PATCH), then save
    // provider credentials and confirm codEnabled survives.
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    await prisma.tenant.update({
      where: { id: tenantId },
      data: { settings: { ...(tenant.settings as object), payments: { codEnabled: true } } },
    });

    await paymentsService.saveProviderCredentials(tenantId, 'wompi', FAKE_CREDS);

    const after = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    const settings = after.settings as Record<string, unknown>;
    const payments = settings.payments as Record<string, unknown>;
    expect(payments.codEnabled).toBe(true);
    expect(payments.providers).toBeTruthy();
  });
});

describe('PaymentsService.saveProviderCredentials / getTenantProviderConfig — mercadopago', () => {
  it('round-trips with REAL encryption: get returns exactly what was saved, decrypted', async () => {
    const { tenantId } = await signUpWithTenant('payments-svc-mp-roundtrip@demo.co', 'owner');

    await paymentsService.saveProviderCredentials(tenantId, 'mercadopago', FAKE_MP_CREDS);
    const cfg = await paymentsService.getTenantProviderConfig(tenantId, 'mercadopago');

    expect(cfg).toEqual({
      publicKey: FAKE_MP_CREDS.publicKey,
      privateKey: FAKE_MP_CREDS.privateKey,
      sandbox: FAKE_MP_CREDS.sandbox,
      integritySecret: undefined,
      eventsSecret: FAKE_MP_CREDS.eventsSecret,
      epaycoCustomerId: undefined,
    });
  });

  it('persists privateKey/eventsSecret as CIPHERTEXT, never plaintext, in the raw DB row', async () => {
    const { tenantId } = await signUpWithTenant('payments-svc-mp-ciphertext@demo.co', 'owner');

    await paymentsService.saveProviderCredentials(tenantId, 'mercadopago', FAKE_MP_CREDS);

    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    const settings = tenant.settings as Record<string, unknown>;
    const payments = settings.payments as Record<string, unknown>;
    const providers = payments.providers as Record<string, unknown>;
    const mercadopago = providers.mercadopago as Record<string, unknown>;

    // publicKey IS stored in cleartext (design decision: not a secret).
    expect(mercadopago.publicKey).toBe(FAKE_MP_CREDS.publicKey);

    // Every actual secret is encrypted — the raw stored string must not
    // equal, or even contain, the plaintext.
    expect(mercadopago.privateKeyEncrypted).not.toBe(FAKE_MP_CREDS.privateKey);
    expect(String(mercadopago.privateKeyEncrypted)).not.toContain(FAKE_MP_CREDS.privateKey);
    expect(mercadopago.eventsSecretEncrypted).not.toBe(FAKE_MP_CREDS.eventsSecret);
    expect(String(mercadopago.eventsSecretEncrypted)).not.toContain(FAKE_MP_CREDS.eventsSecret);
    // Mercado Pago has no integritySecret — must never appear at all.
    expect(mercadopago.integritySecretEncrypted).toBeUndefined();

    // Ciphertext format sanity: "iv:tag:ciphertext" (encryption.ts's format).
    expect(String(mercadopago.privateKeyEncrypted).split(':')).toHaveLength(3);
  });

  it('returns null for a tenant with no saved provider config', async () => {
    const { tenantId } = await signUpWithTenant('payments-svc-mp-unconfigured@demo.co', 'owner');
    const cfg = await paymentsService.getTenantProviderConfig(tenantId, 'mercadopago');
    expect(cfg).toBeNull();
  });

  it('saving credentials for one tenant does not affect another tenant (isolation)', async () => {
    const tenantA = await signUpWithTenant('payments-svc-mp-isolation-a@demo.co', 'owner');
    const tenantB = await signUpWithTenant('payments-svc-mp-isolation-b@demo.co', 'owner');

    await paymentsService.saveProviderCredentials(tenantA.tenantId, 'mercadopago', FAKE_MP_CREDS);

    const cfgA = await paymentsService.getTenantProviderConfig(tenantA.tenantId, 'mercadopago');
    const cfgB = await paymentsService.getTenantProviderConfig(tenantB.tenantId, 'mercadopago');

    expect(cfgA).not.toBeNull();
    expect(cfgB).toBeNull();
  });
});

describe('PaymentsService.saveProviderCredentials / getTenantProviderConfig — epayco', () => {
  it('round-trips with REAL encryption: get returns exactly what was saved, decrypted, including epaycoCustomerId', async () => {
    const { tenantId } = await signUpWithTenant('payments-svc-epayco-roundtrip@demo.co', 'owner');

    await paymentsService.saveProviderCredentials(tenantId, 'epayco', FAKE_EPAYCO_CREDS);
    const cfg = await paymentsService.getTenantProviderConfig(tenantId, 'epayco');

    expect(cfg).toEqual({
      publicKey: FAKE_EPAYCO_CREDS.publicKey,
      privateKey: FAKE_EPAYCO_CREDS.privateKey,
      sandbox: FAKE_EPAYCO_CREDS.sandbox,
      integritySecret: undefined,
      eventsSecret: FAKE_EPAYCO_CREDS.eventsSecret,
      epaycoCustomerId: FAKE_EPAYCO_CREDS.epaycoCustomerId,
    });
  });

  it('persists privateKey/eventsSecret/epaycoCustomerId as CIPHERTEXT, never plaintext, in the raw DB row', async () => {
    const { tenantId } = await signUpWithTenant('payments-svc-epayco-ciphertext@demo.co', 'owner');

    await paymentsService.saveProviderCredentials(tenantId, 'epayco', FAKE_EPAYCO_CREDS);

    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    const settings = tenant.settings as Record<string, unknown>;
    const payments = settings.payments as Record<string, unknown>;
    const providers = payments.providers as Record<string, unknown>;
    const epayco = providers.epayco as Record<string, unknown>;

    // publicKey IS stored in cleartext (design decision: not a secret).
    expect(epayco.publicKey).toBe(FAKE_EPAYCO_CREDS.publicKey);

    // Every actual secret — including epaycoCustomerId, encrypted per this
    // task's judgment call (see payments.service.ts's StoredProviderCredentials
    // doc comment) — is encrypted. The raw stored string must not equal, or
    // even contain, the plaintext.
    expect(epayco.privateKeyEncrypted).not.toBe(FAKE_EPAYCO_CREDS.privateKey);
    expect(String(epayco.privateKeyEncrypted)).not.toContain(FAKE_EPAYCO_CREDS.privateKey);
    expect(epayco.eventsSecretEncrypted).not.toBe(FAKE_EPAYCO_CREDS.eventsSecret);
    expect(String(epayco.eventsSecretEncrypted)).not.toContain(FAKE_EPAYCO_CREDS.eventsSecret);
    expect(epayco.epaycoCustomerIdEncrypted).not.toBe(FAKE_EPAYCO_CREDS.epaycoCustomerId);
    expect(String(epayco.epaycoCustomerIdEncrypted)).not.toContain(FAKE_EPAYCO_CREDS.epaycoCustomerId);
    // ePayco has no integritySecret — must never appear at all.
    expect(epayco.integritySecretEncrypted).toBeUndefined();

    // Ciphertext format sanity: "iv:tag:ciphertext" (encryption.ts's format).
    expect(String(epayco.privateKeyEncrypted).split(':')).toHaveLength(3);
    expect(String(epayco.epaycoCustomerIdEncrypted).split(':')).toHaveLength(3);
  });

  it('returns null for a tenant with no saved provider config', async () => {
    const { tenantId } = await signUpWithTenant('payments-svc-epayco-unconfigured@demo.co', 'owner');
    const cfg = await paymentsService.getTenantProviderConfig(tenantId, 'epayco');
    expect(cfg).toBeNull();
  });

  it('saving credentials for one tenant does not affect another tenant (isolation)', async () => {
    const tenantA = await signUpWithTenant('payments-svc-epayco-isolation-a@demo.co', 'owner');
    const tenantB = await signUpWithTenant('payments-svc-epayco-isolation-b@demo.co', 'owner');

    await paymentsService.saveProviderCredentials(tenantA.tenantId, 'epayco', FAKE_EPAYCO_CREDS);

    const cfgA = await paymentsService.getTenantProviderConfig(tenantA.tenantId, 'epayco');
    const cfgB = await paymentsService.getTenantProviderConfig(tenantB.tenantId, 'epayco');

    expect(cfgA).not.toBeNull();
    expect(cfgB).toBeNull();
  });
});

describe('PaymentsService.testConnection', () => {
  it('{ok:false, error: "not configured"} when the tenant has no saved credentials — never throws', async () => {
    const { tenantId } = await signUpWithTenant('payments-svc-test-unconfigured@demo.co', 'owner');
    const result = await paymentsService.testConnection(tenantId, 'wompi');
    expect(result).toEqual({ ok: false, error: 'not configured' });
  });

  it('{ok: false} (not a thrown error) when the underlying provider call rejects', async () => {
    const { tenantId } = await signUpWithTenant('payments-svc-test-fail@demo.co', 'owner');
    await paymentsService.saveProviderCredentials(tenantId, 'wompi', FAKE_CREDS);

    // WompiProvider.getTransactionStatus's default fetchImpl is the global
    // `fetch` — simulating a network-level failure this way proves
    // testConnection catches whatever a real provider call throws, without
    // needing to touch the provider-registry singleton.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('simulated network failure: getaddrinfo ENOTFOUND')),
    );

    const result = await paymentsService.testConnection(tenantId, 'wompi');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('simulated network failure');

    vi.unstubAllGlobals();
  });

  it('{ok: true} when the underlying provider call resolves without throwing', async () => {
    const { tenantId } = await signUpWithTenant('payments-svc-test-ok@demo.co', 'owner');
    await paymentsService.saveProviderCredentials(tenantId, 'wompi', FAKE_CREDS);

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ data: { status: 'DECLINED' } }),
      }),
    );

    const result = await paymentsService.testConnection(tenantId, 'wompi');
    expect(result).toEqual({ ok: true });

    vi.unstubAllGlobals();
  });

  it('mercadopago: {ok:false, error: "not configured"} when the tenant has no saved credentials — never throws', async () => {
    const { tenantId } = await signUpWithTenant('payments-svc-mp-test-unconfigured@demo.co', 'owner');
    const result = await paymentsService.testConnection(tenantId, 'mercadopago');
    expect(result).toEqual({ ok: false, error: 'not configured' });
  });

  it('mercadopago: {ok: false} (not a thrown error) when the underlying provider call rejects', async () => {
    const { tenantId } = await signUpWithTenant('payments-svc-mp-test-fail@demo.co', 'owner');
    await paymentsService.saveProviderCredentials(tenantId, 'mercadopago', FAKE_MP_CREDS);

    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('simulated network failure: getaddrinfo ENOTFOUND')),
    );

    const result = await paymentsService.testConnection(tenantId, 'mercadopago');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('simulated network failure');

    vi.unstubAllGlobals();
  });

  it('mercadopago: {ok: true} when the underlying provider call resolves without throwing', async () => {
    const { tenantId } = await signUpWithTenant('payments-svc-mp-test-ok@demo.co', 'owner');
    await paymentsService.saveProviderCredentials(tenantId, 'mercadopago', FAKE_MP_CREDS);

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ status: 'rejected' }),
      }),
    );

    const result = await paymentsService.testConnection(tenantId, 'mercadopago');
    expect(result).toEqual({ ok: true });

    vi.unstubAllGlobals();
  });

  it('epayco: {ok:false, error: "not configured"} when the tenant has no saved credentials — never throws', async () => {
    const { tenantId } = await signUpWithTenant('payments-svc-epayco-test-unconfigured@demo.co', 'owner');
    const result = await paymentsService.testConnection(tenantId, 'epayco');
    expect(result).toEqual({ ok: false, error: 'not configured' });
  });

  it('epayco: {ok: false} (not a thrown error) when the underlying provider call rejects', async () => {
    const { tenantId } = await signUpWithTenant('payments-svc-epayco-test-fail@demo.co', 'owner');
    await paymentsService.saveProviderCredentials(tenantId, 'epayco', FAKE_EPAYCO_CREDS);

    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('simulated network failure: getaddrinfo ENOTFOUND')),
    );

    const result = await paymentsService.testConnection(tenantId, 'epayco');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('simulated network failure');

    vi.unstubAllGlobals();
  });

  it('epayco: {ok: true} when the underlying provider call resolves without throwing', async () => {
    const { tenantId } = await signUpWithTenant('payments-svc-epayco-test-ok@demo.co', 'owner');
    await paymentsService.saveProviderCredentials(tenantId, 'epayco', FAKE_EPAYCO_CREDS);

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ data: { x_response: 'Rechazada' } }),
      }),
    );

    const result = await paymentsService.testConnection(tenantId, 'epayco');
    expect(result).toEqual({ ok: true });

    vi.unstubAllGlobals();
  });
});

describe('PaymentsService.markPaid', () => {
  // No product/stock fixture here: per design decision 3, `markPaid` does
  // NOT decrement stock (checkout's wompi branch already reserved it at
  // order-creation time) — it only clears `stockReservedUntil`, so these
  // tests only need bare `Order` rows, not products/stock.
  let orderNumberSeq = 1;

  async function seedOrder(
    tenantId: string,
    status: OrderStatus,
    paymentStatus: PaymentStatus,
    opts?: { paymentProvider?: string | null; stockReservedUntil?: Date | null },
  ): Promise<string> {
    const order = await prisma.order.create({
      data: {
        tenantId,
        number: orderNumberSeq++,
        status,
        paymentStatus,
        paymentProvider: opts?.paymentProvider ?? 'wompi',
        stockReservedUntil: opts?.stockReservedUntil ?? new Date(Date.now() + 15 * 60_000),
        email: 'comprador@example.com',
        phone: '3000000000',
        shippingAddress: {},
        subtotalCents: 10_000,
        taxCents: 0,
        totalCents: 10_000,
      },
    });
    return order.id;
  }

  it('PENDING/PENDING -> CONFIRMED/PAID, clears stockReservedUntil, writes exactly one OrderEvent', async () => {
    const { tenantId } = await signUpWithTenant('payments-svc-markpaid-happy@demo.co', 'owner');
    const orderId = await seedOrder(tenantId, 'PENDING', 'PENDING');

    await paymentsService.markPaid(tenantId, orderId, 'wompi', 'wompi-txn-1');

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe('CONFIRMED');
    expect(order.paymentStatus).toBe('PAID');
    expect(order.stockReservedUntil).toBeNull();
    expect(order.paymentProvider).toBe('wompi');
    // P3c: providerRef is also stamped onto the Order row itself now, not
    // just the OrderEvent's JSON data (asserted further below).
    expect(order.providerRef).toBe('wompi-txn-1');

    const events = await prisma.orderEvent.findMany({ where: { orderId, type: 'payment_confirmed' } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      tenantId,
      orderId,
      type: 'payment_confirmed',
      data: { provider: 'wompi', providerRef: 'wompi-txn-1' },
    });
  });

  it('is idempotent: calling it TWICE on the same order only transitions once — second call is a genuine no-op', async () => {
    const { tenantId } = await signUpWithTenant('payments-svc-markpaid-idempotent@demo.co', 'owner');
    const orderId = await seedOrder(tenantId, 'PENDING', 'PENDING');

    await paymentsService.markPaid(tenantId, orderId, 'wompi', 'wompi-txn-2');
    const afterFirst = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(afterFirst.status).toBe('CONFIRMED');
    expect(afterFirst.paymentStatus).toBe('PAID');

    // Second call — simulating a webhook retry after the first delivery
    // already succeeded. Must not throw, and must not add a second event.
    await expect(
      paymentsService.markPaid(tenantId, orderId, 'wompi', 'wompi-txn-2'),
    ).resolves.toBeUndefined();

    const afterSecond = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(afterSecond.status).toBe('CONFIRMED');
    expect(afterSecond.paymentStatus).toBe('PAID');

    const events = await prisma.orderEvent.findMany({ where: { orderId, type: 'payment_confirmed' } });
    expect(events).toHaveLength(1); // still exactly one — the second call added nothing
  });

  it('on an order already CONFIRMED (not PENDING/PENDING) is a safe no-op: no OrderEvent, no field changes', async () => {
    const { tenantId } = await signUpWithTenant('payments-svc-markpaid-already-confirmed@demo.co', 'owner');
    const orderId = await seedOrder(tenantId, 'CONFIRMED', 'PAID', { stockReservedUntil: null });

    const before = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });

    await expect(paymentsService.markPaid(tenantId, orderId, 'wompi', 'wompi-txn-3')).resolves.toBeUndefined();

    const after = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(after).toEqual(before);

    const events = await prisma.orderEvent.count({ where: { orderId, type: 'payment_confirmed' } });
    expect(events).toBe(0);
  });

  it('on a nonexistent order id is a safe no-op (never throws)', async () => {
    const { tenantId } = await signUpWithTenant('payments-svc-markpaid-missing@demo.co', 'owner');
    await expect(
      paymentsService.markPaid(tenantId, randomUUID(), 'wompi', 'wompi-txn-4'),
    ).resolves.toBeUndefined();
  });

  it('does not touch a same-tenant order belonging to another tenant (cross-tenant no-op)', async () => {
    const tenantA = await signUpWithTenant('payments-svc-markpaid-cross-a@demo.co', 'owner');
    const tenantB = await signUpWithTenant('payments-svc-markpaid-cross-b@demo.co', 'owner');
    const orderId = await seedOrder(tenantA.tenantId, 'PENDING', 'PENDING');

    await paymentsService.markPaid(tenantB.tenantId, orderId, 'wompi', 'wompi-txn-5');

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe('PENDING');
    expect(order.paymentStatus).toBe('PENDING');

    const events = await prisma.orderEvent.count({ where: { orderId, type: 'payment_confirmed' } });
    expect(events).toBe(0);
  });
});

describe('PaymentsService.markFailed', () => {
  // Mirrors markPaid's own seedOrder fixture above (that helper is scoped to
  // its own describe block, so a narrow local copy here — same shape,
  // nothing new — is simpler than exporting it just for this one addition).
  let orderNumberSeq = 10_000;

  async function seedOrder(
    tenantId: string,
    status: OrderStatus,
    paymentStatus: PaymentStatus,
    opts?: { paymentProvider?: string | null; stockReservedUntil?: Date | null },
  ): Promise<string> {
    const order = await prisma.order.create({
      data: {
        tenantId,
        number: orderNumberSeq++,
        status,
        paymentStatus,
        paymentProvider: opts?.paymentProvider ?? 'wompi',
        stockReservedUntil: opts?.stockReservedUntil ?? new Date(Date.now() + 15 * 60_000),
        email: 'comprador@example.com',
        phone: '3000000000',
        shippingAddress: {},
        subtotalCents: 10_000,
        taxCents: 0,
        totalCents: 10_000,
      },
    });
    return order.id;
  }

  it('PENDING/PENDING -> paymentStatus FAILED, providerRef persisted on the Order row (not just the OrderEvent)', async () => {
    const { tenantId } = await signUpWithTenant('payments-svc-markfailed-happy@demo.co', 'owner');
    const orderId = await seedOrder(tenantId, 'PENDING', 'PENDING');

    await paymentsService.markFailed(tenantId, orderId, 'wompi', 'wompi-txn-failed-1');

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe('PENDING'); // markFailed never touches status
    expect(order.paymentStatus).toBe('FAILED');
    // P3c: providerRef is stamped onto the Order row itself, not just the
    // OrderEvent's JSON data (asserted below).
    expect(order.providerRef).toBe('wompi-txn-failed-1');

    const events = await prisma.orderEvent.findMany({ where: { orderId, type: 'payment_failed' } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      tenantId,
      orderId,
      type: 'payment_failed',
      data: { provider: 'wompi', providerRef: 'wompi-txn-failed-1' },
    });
  });

  // This exact bug (a late FAILED webhook for an earlier attempt clobbering
  // an already-CONFIRMED/PAID order back to FAILED) is the one markFailed's
  // own doc comment recounts finding and fixing in an earlier review — that
  // guard code has been live and unchanged ever since, but had no test of
  // its own until now.
  it('on an order already CONFIRMED/PAID (not PENDING/PENDING) is a safe no-op: no OrderEvent, no field changes', async () => {
    const { tenantId } = await signUpWithTenant('payments-svc-markfailed-already-confirmed@demo.co', 'owner');
    const orderId = await seedOrder(tenantId, 'CONFIRMED', 'PAID', { stockReservedUntil: null });

    const before = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });

    await expect(
      paymentsService.markFailed(tenantId, orderId, 'wompi', 'wompi-txn-failed-2'),
    ).resolves.toBeUndefined();

    const after = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(after).toEqual(before);

    const events = await prisma.orderEvent.count({ where: { orderId, type: 'payment_failed' } });
    expect(events).toBe(0);
  });

  it('on a nonexistent order id is a safe no-op (never throws)', async () => {
    const { tenantId } = await signUpWithTenant('payments-svc-markfailed-missing@demo.co', 'owner');
    await expect(
      paymentsService.markFailed(tenantId, randomUUID(), 'wompi', 'wompi-txn-failed-3'),
    ).resolves.toBeUndefined();
  });
});
