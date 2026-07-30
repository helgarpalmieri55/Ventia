import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient as PrismaClientType } from '@ventia/db';
import { startTestDb } from './helpers';
import type { signUpWithTenant as SignUpWithTenant } from './admin-helpers';

let db: Awaited<ReturnType<typeof startTestDb>>;
let redisContainer: StartedTestContainer;
let app: INestApplication;
let signUpWithTenant: typeof SignUpWithTenant;
let platformDb: PrismaClientType;

beforeAll(async () => {
  db = await startTestDb();
  redisContainer = await new GenericContainer('redis:7-alpine')
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
    .start();

  process.env.DATABASE_URL = db.url;
  process.env.REDIS_URL = `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`;
  process.env.PAYMENTS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

  const { createApp } = await import('../src/main');
  app = await createApp();
  await app.init();

  ({ signUpWithTenant } = await import('./admin-helpers'));
  ({ platformDb } = await import('@ventia/db'));
}, 120_000);

afterAll(async () => {
  await app.close();
  await redisContainer.stop();
  await db.stop();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// A realistic-looking (but entirely fake) Wompi private key — this exact
// string is what the credential-leak test below greps for in the FULL
// stringified GET /v1/admin/settings response body.
const FAKE_PRIVATE_KEY = 'prv_test_S3cr3tPr1vateKey_DoNotLeakThisAnywhereEver_9f8e7d6c';
const FAKE_INTEGRITY_SECRET = 'test_integrity_D0N0TLEAK_9182736450';
const FAKE_EVENTS_SECRET = 'test_events_D0N0TLEAK_5647382910';

const WOMPI_CREDS_BODY = {
  publicKey: 'pub_test_visible_public_key_1234',
  privateKey: FAKE_PRIVATE_KEY,
  integritySecret: FAKE_INTEGRITY_SECRET,
  eventsSecret: FAKE_EVENTS_SECRET,
  sandbox: true,
};

// Mercado Pago / ePayco equivalents — distinct fake secret strings so each
// provider's leak test can assert its OWN secret is absent without any risk
// of accidentally matching a substring of another provider's fixture.
const FAKE_MP_PRIVATE_KEY = 'APP_USR-mp-S3cr3tAccessToken_DoNotLeakThisAnywhereEver_1a2b3c';
const FAKE_MP_EVENTS_SECRET = 'mp-events-D0N0TLEAK-webhook-signing-key-6758493021';

const MERCADOPAGO_CREDS_BODY = {
  publicKey: 'APP_USR-mp-visible-public-key-5678',
  privateKey: FAKE_MP_PRIVATE_KEY,
  eventsSecret: FAKE_MP_EVENTS_SECRET,
  sandbox: true,
};

const FAKE_EPAYCO_PRIVATE_KEY = 'epayco-S3cr3tPrivateKey_DoNotLeakThisAnywhereEver_4d5e6f';
const FAKE_EPAYCO_EVENTS_SECRET = 'epayco-P_KEY-D0N0TLEAK-9876543210';
const FAKE_EPAYCO_CUSTOMER_ID = 'epayco-P_CUST_ID_CLIENTE-D0N0TLEAK-1357924680';

const EPAYCO_CREDS_BODY = {
  publicKey: 'epayco-visible-public-key-9012',
  privateKey: FAKE_EPAYCO_PRIVATE_KEY,
  eventsSecret: FAKE_EPAYCO_EVENTS_SECRET,
  epaycoCustomerId: FAKE_EPAYCO_CUSTOMER_ID,
  sandbox: true,
};

describe('PATCH /v1/admin/settings/payments — providers.wompi merge-in-place', () => {
  it('setting codEnabled first, then PATCHing only providers.wompi, leaves codEnabled untouched', async () => {
    const { cookie } = await signUpWithTenant('payments-settings-merge@demo.co', 'owner');

    const codPatch = await request(app.getHttpServer())
      .patch('/v1/admin/settings/payments')
      .set('cookie', cookie)
      .send({ codEnabled: true });
    expect(codPatch.status).toBe(200);
    expect(codPatch.body.payments.codEnabled).toBe(true);

    // A SEPARATE, later PATCH sending ONLY providers.wompi.
    const providersPatch = await request(app.getHttpServer())
      .patch('/v1/admin/settings/payments')
      .set('cookie', cookie)
      .send({ providers: { wompi: WOMPI_CREDS_BODY } });
    expect(providersPatch.status).toBe(200);

    // codEnabled must still be true — untouched by the providers-only PATCH.
    expect(providersPatch.body.payments.codEnabled).toBe(true);
    expect(providersPatch.body.payments.providers.wompi.connected).toBe(true);

    const getRes = await request(app.getHttpServer()).get('/v1/admin/settings').set('cookie', cookie);
    expect(getRes.body.payments.codEnabled).toBe(true);
    expect(getRes.body.payments.providers.wompi.connected).toBe(true);
  });

  it('the reverse order also holds: PATCHing providers.wompi first, then codEnabled alone, leaves the provider connected', async () => {
    const { cookie } = await signUpWithTenant('payments-settings-merge-reverse@demo.co', 'owner');

    const providersPatch = await request(app.getHttpServer())
      .patch('/v1/admin/settings/payments')
      .set('cookie', cookie)
      .send({ providers: { wompi: WOMPI_CREDS_BODY } });
    expect(providersPatch.status).toBe(200);

    const codPatch = await request(app.getHttpServer())
      .patch('/v1/admin/settings/payments')
      .set('cookie', cookie)
      .send({ codEnabled: false });
    expect(codPatch.status).toBe(200);
    expect(codPatch.body.payments.codEnabled).toBe(false);
    // Still connected — the codEnabled-only PATCH must not clobber providers.
    expect(codPatch.body.payments.providers.wompi.connected).toBe(true);
  });

  it('never returns the raw publicKey, and masks it to a "****"+last4 suffix', async () => {
    const { cookie } = await signUpWithTenant('payments-settings-masked-publickey@demo.co', 'owner');

    const res = await request(app.getHttpServer())
      .patch('/v1/admin/settings/payments')
      .set('cookie', cookie)
      .send({ providers: { wompi: WOMPI_CREDS_BODY } });
    expect(res.status).toBe(200);

    const masked = res.body.payments.providers.wompi.publicKeyMasked as string;
    expect(masked).not.toBe(WOMPI_CREDS_BODY.publicKey);
    expect(masked.endsWith(WOMPI_CREDS_BODY.publicKey.slice(-4))).toBe(true);
    expect(masked).toContain('*');
  });

  it('an empty {} PATCH is accepted as a no-op (200), not rejected', async () => {
    const { cookie } = await signUpWithTenant('payments-settings-empty-patch@demo.co', 'owner');
    const res = await request(app.getHttpServer())
      .patch('/v1/admin/settings/payments')
      .set('cookie', cookie)
      .send({});
    expect(res.status).toBe(200);
  });

  it('400 VALIDATION_FAILED when providers.wompi is missing a required field (privateKey)', async () => {
    const { cookie } = await signUpWithTenant('payments-settings-invalid-creds@demo.co', 'owner');
    const res = await request(app.getHttpServer())
      .patch('/v1/admin/settings/payments')
      .set('cookie', cookie)
      .send({ providers: { wompi: { publicKey: 'pub_test_x', sandbox: true } } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_FAILED');
  });
});

describe('PATCH /v1/admin/settings/payments — providers.mercadopago merge-in-place', () => {
  it('setting codEnabled first, then PATCHing only providers.mercadopago, leaves codEnabled untouched', async () => {
    const { cookie } = await signUpWithTenant('payments-settings-mp-merge@demo.co', 'owner');

    const codPatch = await request(app.getHttpServer())
      .patch('/v1/admin/settings/payments')
      .set('cookie', cookie)
      .send({ codEnabled: true });
    expect(codPatch.status).toBe(200);
    expect(codPatch.body.payments.codEnabled).toBe(true);

    const providersPatch = await request(app.getHttpServer())
      .patch('/v1/admin/settings/payments')
      .set('cookie', cookie)
      .send({ providers: { mercadopago: MERCADOPAGO_CREDS_BODY } });
    expect(providersPatch.status).toBe(200);

    expect(providersPatch.body.payments.codEnabled).toBe(true);
    expect(providersPatch.body.payments.providers.mercadopago.connected).toBe(true);

    const getRes = await request(app.getHttpServer()).get('/v1/admin/settings').set('cookie', cookie);
    expect(getRes.body.payments.codEnabled).toBe(true);
    expect(getRes.body.payments.providers.mercadopago.connected).toBe(true);
  });

  it('the reverse order also holds: PATCHing providers.mercadopago first, then codEnabled alone, leaves the provider connected', async () => {
    const { cookie } = await signUpWithTenant('payments-settings-mp-merge-reverse@demo.co', 'owner');

    const providersPatch = await request(app.getHttpServer())
      .patch('/v1/admin/settings/payments')
      .set('cookie', cookie)
      .send({ providers: { mercadopago: MERCADOPAGO_CREDS_BODY } });
    expect(providersPatch.status).toBe(200);

    const codPatch = await request(app.getHttpServer())
      .patch('/v1/admin/settings/payments')
      .set('cookie', cookie)
      .send({ codEnabled: false });
    expect(codPatch.status).toBe(200);
    expect(codPatch.body.payments.codEnabled).toBe(false);
    expect(codPatch.body.payments.providers.mercadopago.connected).toBe(true);
  });

  it('never returns the raw publicKey, and masks it to a "****"+last4 suffix', async () => {
    const { cookie } = await signUpWithTenant('payments-settings-mp-masked-publickey@demo.co', 'owner');

    const res = await request(app.getHttpServer())
      .patch('/v1/admin/settings/payments')
      .set('cookie', cookie)
      .send({ providers: { mercadopago: MERCADOPAGO_CREDS_BODY } });
    expect(res.status).toBe(200);

    const masked = res.body.payments.providers.mercadopago.publicKeyMasked as string;
    expect(masked).not.toBe(MERCADOPAGO_CREDS_BODY.publicKey);
    expect(masked.endsWith(MERCADOPAGO_CREDS_BODY.publicKey.slice(-4))).toBe(true);
    expect(masked).toContain('*');
  });

  it('an empty {} PATCH is accepted as a no-op (200), not rejected', async () => {
    const { cookie } = await signUpWithTenant('payments-settings-mp-empty-patch@demo.co', 'owner');
    const res = await request(app.getHttpServer())
      .patch('/v1/admin/settings/payments')
      .set('cookie', cookie)
      .send({});
    expect(res.status).toBe(200);
  });

  it('400 VALIDATION_FAILED when providers.mercadopago is missing a required field (privateKey)', async () => {
    const { cookie } = await signUpWithTenant('payments-settings-mp-invalid-creds@demo.co', 'owner');
    const res = await request(app.getHttpServer())
      .patch('/v1/admin/settings/payments')
      .set('cookie', cookie)
      .send({ providers: { mercadopago: { publicKey: 'APP_USR-x', sandbox: true } } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_FAILED');
  });
});

describe('PATCH /v1/admin/settings/payments — providers.epayco merge-in-place', () => {
  it('setting codEnabled first, then PATCHing only providers.epayco, leaves codEnabled untouched', async () => {
    const { cookie } = await signUpWithTenant('payments-settings-epayco-merge@demo.co', 'owner');

    const codPatch = await request(app.getHttpServer())
      .patch('/v1/admin/settings/payments')
      .set('cookie', cookie)
      .send({ codEnabled: true });
    expect(codPatch.status).toBe(200);
    expect(codPatch.body.payments.codEnabled).toBe(true);

    const providersPatch = await request(app.getHttpServer())
      .patch('/v1/admin/settings/payments')
      .set('cookie', cookie)
      .send({ providers: { epayco: EPAYCO_CREDS_BODY } });
    expect(providersPatch.status).toBe(200);

    expect(providersPatch.body.payments.codEnabled).toBe(true);
    expect(providersPatch.body.payments.providers.epayco.connected).toBe(true);

    const getRes = await request(app.getHttpServer()).get('/v1/admin/settings').set('cookie', cookie);
    expect(getRes.body.payments.codEnabled).toBe(true);
    expect(getRes.body.payments.providers.epayco.connected).toBe(true);
  });

  it('the reverse order also holds: PATCHing providers.epayco first, then codEnabled alone, leaves the provider connected', async () => {
    const { cookie } = await signUpWithTenant('payments-settings-epayco-merge-reverse@demo.co', 'owner');

    const providersPatch = await request(app.getHttpServer())
      .patch('/v1/admin/settings/payments')
      .set('cookie', cookie)
      .send({ providers: { epayco: EPAYCO_CREDS_BODY } });
    expect(providersPatch.status).toBe(200);

    const codPatch = await request(app.getHttpServer())
      .patch('/v1/admin/settings/payments')
      .set('cookie', cookie)
      .send({ codEnabled: false });
    expect(codPatch.status).toBe(200);
    expect(codPatch.body.payments.codEnabled).toBe(false);
    expect(codPatch.body.payments.providers.epayco.connected).toBe(true);
  });

  it('never returns the raw publicKey, and masks it to a "****"+last4 suffix', async () => {
    const { cookie } = await signUpWithTenant('payments-settings-epayco-masked-publickey@demo.co', 'owner');

    const res = await request(app.getHttpServer())
      .patch('/v1/admin/settings/payments')
      .set('cookie', cookie)
      .send({ providers: { epayco: EPAYCO_CREDS_BODY } });
    expect(res.status).toBe(200);

    const masked = res.body.payments.providers.epayco.publicKeyMasked as string;
    expect(masked).not.toBe(EPAYCO_CREDS_BODY.publicKey);
    expect(masked.endsWith(EPAYCO_CREDS_BODY.publicKey.slice(-4))).toBe(true);
    expect(masked).toContain('*');
  });

  it('an empty {} PATCH is accepted as a no-op (200), not rejected', async () => {
    const { cookie } = await signUpWithTenant('payments-settings-epayco-empty-patch@demo.co', 'owner');
    const res = await request(app.getHttpServer())
      .patch('/v1/admin/settings/payments')
      .set('cookie', cookie)
      .send({});
    expect(res.status).toBe(200);
  });

  it('400 VALIDATION_FAILED when providers.epayco is missing a required field (privateKey)', async () => {
    const { cookie } = await signUpWithTenant('payments-settings-epayco-invalid-creds@demo.co', 'owner');
    const res = await request(app.getHttpServer())
      .patch('/v1/admin/settings/payments')
      .set('cookie', cookie)
      .send({ providers: { epayco: { publicKey: 'epayco-x', sandbox: true } } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_FAILED');
  });
});

describe('credential-leak test: GET /v1/admin/settings never exposes plaintext secrets anywhere in its body', () => {
  it('the raw plaintext privateKey/integritySecret/eventsSecret do NOT appear anywhere in the stringified response, before or after saving', async () => {
    const { cookie } = await signUpWithTenant('payments-settings-no-leak@demo.co', 'owner');

    const patchRes = await request(app.getHttpServer())
      .patch('/v1/admin/settings/payments')
      .set('cookie', cookie)
      .send({ providers: { wompi: WOMPI_CREDS_BODY } });
    expect(patchRes.status).toBe(200);

    // Rigor: stringify the FULL response body and search for the raw
    // plaintext substring anywhere in it — not just checking that a
    // specific field is absent/renamed. This is the exact leak this task's
    // masking design (cleartext publicKey + encrypted-at-rest secrets,
    // decrypted only in-memory inside PaymentsService, never in an HTTP
    // response) is meant to make structurally impossible.
    const patchBodyString = JSON.stringify(patchRes.body);
    expect(patchBodyString).not.toContain(FAKE_PRIVATE_KEY);
    expect(patchBodyString).not.toContain(FAKE_INTEGRITY_SECRET);
    expect(patchBodyString).not.toContain(FAKE_EVENTS_SECRET);

    const getRes = await request(app.getHttpServer()).get('/v1/admin/settings').set('cookie', cookie);
    expect(getRes.status).toBe(200);
    const getBodyString = JSON.stringify(getRes.body);
    expect(getBodyString).not.toContain(FAKE_PRIVATE_KEY);
    expect(getBodyString).not.toContain(FAKE_INTEGRITY_SECRET);
    expect(getBodyString).not.toContain(FAKE_EVENTS_SECRET);

    // The public key, in contrast, IS allowed to appear — but only in its
    // masked form, never in full.
    expect(getBodyString).not.toContain(WOMPI_CREDS_BODY.publicKey);
  });

  it('the raw plaintext secrets do not appear in the AuditLog row written for this PATCH either', async () => {
    const { cookie, tenantId } = await signUpWithTenant('payments-settings-no-leak-audit@demo.co', 'owner');

    await request(app.getHttpServer())
      .patch('/v1/admin/settings/payments')
      .set('cookie', cookie)
      .send({ providers: { wompi: WOMPI_CREDS_BODY } });

    const audits = await platformDb.auditLog.findMany({ where: { tenantId, action: 'settings.payments' } });
    expect(audits.length).toBeGreaterThan(0);
    const auditString = JSON.stringify(audits);
    expect(auditString).not.toContain(FAKE_PRIVATE_KEY);
    expect(auditString).not.toContain(FAKE_INTEGRITY_SECRET);
    expect(auditString).not.toContain(FAKE_EVENTS_SECRET);
  });

  it('the raw plaintext secrets ARE present, encrypted, in the underlying Tenant.settings row (sanity check the masking isn\'t just "we forgot to save it")', async () => {
    const { cookie, tenantId } = await signUpWithTenant('payments-settings-sanity-saved@demo.co', 'owner');

    await request(app.getHttpServer())
      .patch('/v1/admin/settings/payments')
      .set('cookie', cookie)
      .send({ providers: { wompi: WOMPI_CREDS_BODY } });

    const tenant = await platformDb.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    const settings = tenant.settings as Record<string, unknown>;
    const payments = settings.payments as Record<string, unknown>;
    const providers = payments.providers as Record<string, unknown>;
    const wompi = providers.wompi as Record<string, unknown>;
    expect(wompi.privateKeyEncrypted).toBeTruthy();
    expect(wompi.privateKeyEncrypted).not.toBe(FAKE_PRIVATE_KEY);
  });
});

describe('credential-leak test: mercadopago — GET /v1/admin/settings never exposes plaintext secrets anywhere in its body', () => {
  it('the raw plaintext privateKey/eventsSecret do NOT appear anywhere in the stringified response, before or after saving', async () => {
    const { cookie } = await signUpWithTenant('payments-settings-mp-no-leak@demo.co', 'owner');

    const patchRes = await request(app.getHttpServer())
      .patch('/v1/admin/settings/payments')
      .set('cookie', cookie)
      .send({ providers: { mercadopago: MERCADOPAGO_CREDS_BODY } });
    expect(patchRes.status).toBe(200);

    // Same rigor as the wompi leak test above: stringify the FULL response
    // body and search for the raw plaintext substring anywhere in it.
    const patchBodyString = JSON.stringify(patchRes.body);
    expect(patchBodyString).not.toContain(FAKE_MP_PRIVATE_KEY);
    expect(patchBodyString).not.toContain(FAKE_MP_EVENTS_SECRET);

    const getRes = await request(app.getHttpServer()).get('/v1/admin/settings').set('cookie', cookie);
    expect(getRes.status).toBe(200);
    const getBodyString = JSON.stringify(getRes.body);
    expect(getBodyString).not.toContain(FAKE_MP_PRIVATE_KEY);
    expect(getBodyString).not.toContain(FAKE_MP_EVENTS_SECRET);

    // The public key, in contrast, IS allowed to appear — but only in its
    // masked form, never in full.
    expect(getBodyString).not.toContain(MERCADOPAGO_CREDS_BODY.publicKey);
  });

  it('the raw plaintext secrets do not appear in the AuditLog row written for this PATCH either', async () => {
    const { cookie, tenantId } = await signUpWithTenant('payments-settings-mp-no-leak-audit@demo.co', 'owner');

    await request(app.getHttpServer())
      .patch('/v1/admin/settings/payments')
      .set('cookie', cookie)
      .send({ providers: { mercadopago: MERCADOPAGO_CREDS_BODY } });

    const audits = await platformDb.auditLog.findMany({ where: { tenantId, action: 'settings.payments' } });
    expect(audits.length).toBeGreaterThan(0);
    const auditString = JSON.stringify(audits);
    expect(auditString).not.toContain(FAKE_MP_PRIVATE_KEY);
    expect(auditString).not.toContain(FAKE_MP_EVENTS_SECRET);
  });

  it('the raw plaintext secrets ARE present, encrypted, in the underlying Tenant.settings row (sanity check the masking isn\'t just "we forgot to save it")', async () => {
    const { cookie, tenantId } = await signUpWithTenant('payments-settings-mp-sanity-saved@demo.co', 'owner');

    await request(app.getHttpServer())
      .patch('/v1/admin/settings/payments')
      .set('cookie', cookie)
      .send({ providers: { mercadopago: MERCADOPAGO_CREDS_BODY } });

    const tenant = await platformDb.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    const settings = tenant.settings as Record<string, unknown>;
    const payments = settings.payments as Record<string, unknown>;
    const providers = payments.providers as Record<string, unknown>;
    const mercadopago = providers.mercadopago as Record<string, unknown>;
    expect(mercadopago.privateKeyEncrypted).toBeTruthy();
    expect(mercadopago.privateKeyEncrypted).not.toBe(FAKE_MP_PRIVATE_KEY);
  });
});

describe('credential-leak test: epayco — GET /v1/admin/settings never exposes plaintext secrets anywhere in its body', () => {
  it('the raw plaintext privateKey/eventsSecret/epaycoCustomerId do NOT appear anywhere in the stringified response, before or after saving', async () => {
    const { cookie } = await signUpWithTenant('payments-settings-epayco-no-leak@demo.co', 'owner');

    const patchRes = await request(app.getHttpServer())
      .patch('/v1/admin/settings/payments')
      .set('cookie', cookie)
      .send({ providers: { epayco: EPAYCO_CREDS_BODY } });
    expect(patchRes.status).toBe(200);

    // Same rigor as the wompi/mercadopago leak tests above — including
    // epaycoCustomerId, which this task chose to encrypt at rest even
    // though it's an account identifier, not a secret on its own (see
    // payments.service.ts's StoredProviderCredentials doc comment).
    const patchBodyString = JSON.stringify(patchRes.body);
    expect(patchBodyString).not.toContain(FAKE_EPAYCO_PRIVATE_KEY);
    expect(patchBodyString).not.toContain(FAKE_EPAYCO_EVENTS_SECRET);
    expect(patchBodyString).not.toContain(FAKE_EPAYCO_CUSTOMER_ID);

    const getRes = await request(app.getHttpServer()).get('/v1/admin/settings').set('cookie', cookie);
    expect(getRes.status).toBe(200);
    const getBodyString = JSON.stringify(getRes.body);
    expect(getBodyString).not.toContain(FAKE_EPAYCO_PRIVATE_KEY);
    expect(getBodyString).not.toContain(FAKE_EPAYCO_EVENTS_SECRET);
    expect(getBodyString).not.toContain(FAKE_EPAYCO_CUSTOMER_ID);

    // The public key, in contrast, IS allowed to appear — but only in its
    // masked form, never in full.
    expect(getBodyString).not.toContain(EPAYCO_CREDS_BODY.publicKey);
  });

  it('the raw plaintext secrets do not appear in the AuditLog row written for this PATCH either', async () => {
    const { cookie, tenantId } = await signUpWithTenant('payments-settings-epayco-no-leak-audit@demo.co', 'owner');

    await request(app.getHttpServer())
      .patch('/v1/admin/settings/payments')
      .set('cookie', cookie)
      .send({ providers: { epayco: EPAYCO_CREDS_BODY } });

    const audits = await platformDb.auditLog.findMany({ where: { tenantId, action: 'settings.payments' } });
    expect(audits.length).toBeGreaterThan(0);
    const auditString = JSON.stringify(audits);
    expect(auditString).not.toContain(FAKE_EPAYCO_PRIVATE_KEY);
    expect(auditString).not.toContain(FAKE_EPAYCO_EVENTS_SECRET);
    expect(auditString).not.toContain(FAKE_EPAYCO_CUSTOMER_ID);
  });

  it('the raw plaintext secrets ARE present, encrypted, in the underlying Tenant.settings row (sanity check the masking isn\'t just "we forgot to save it")', async () => {
    const { cookie, tenantId } = await signUpWithTenant('payments-settings-epayco-sanity-saved@demo.co', 'owner');

    await request(app.getHttpServer())
      .patch('/v1/admin/settings/payments')
      .set('cookie', cookie)
      .send({ providers: { epayco: EPAYCO_CREDS_BODY } });

    const tenant = await platformDb.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    const settings = tenant.settings as Record<string, unknown>;
    const payments = settings.payments as Record<string, unknown>;
    const providers = payments.providers as Record<string, unknown>;
    const epayco = providers.epayco as Record<string, unknown>;
    expect(epayco.privateKeyEncrypted).toBeTruthy();
    expect(epayco.privateKeyEncrypted).not.toBe(FAKE_EPAYCO_PRIVATE_KEY);
    expect(epayco.epaycoCustomerIdEncrypted).toBeTruthy();
    expect(epayco.epaycoCustomerIdEncrypted).not.toBe(FAKE_EPAYCO_CUSTOMER_ID);
  });
});

describe('staff cannot reach payments provider routes (403, mirrors the existing M8 acceptance criterion)', () => {
  it('403 FORBIDDEN_ROLE on PATCH .../payments (providers.wompi) and POST .../payments/wompi/test-connection', async () => {
    const { cookie } = await signUpWithTenant('payments-settings-staff@demo.co', 'staff');

    const patchRes = await request(app.getHttpServer())
      .patch('/v1/admin/settings/payments')
      .set('cookie', cookie)
      .send({ providers: { wompi: WOMPI_CREDS_BODY } });
    expect(patchRes.status).toBe(403);
    expect(patchRes.body).toEqual({ error: 'FORBIDDEN_ROLE' });

    const testConnRes = await request(app.getHttpServer())
      .post('/v1/admin/settings/payments/wompi/test-connection')
      .set('cookie', cookie);
    expect(testConnRes.status).toBe(403);
    expect(testConnRes.body).toEqual({ error: 'FORBIDDEN_ROLE' });
  });

  it('403 FORBIDDEN_ROLE on PATCH .../payments (providers.mercadopago) and POST .../payments/mercadopago/test-connection', async () => {
    const { cookie } = await signUpWithTenant('payments-settings-staff-mp@demo.co', 'staff');

    const patchRes = await request(app.getHttpServer())
      .patch('/v1/admin/settings/payments')
      .set('cookie', cookie)
      .send({ providers: { mercadopago: MERCADOPAGO_CREDS_BODY } });
    expect(patchRes.status).toBe(403);
    expect(patchRes.body).toEqual({ error: 'FORBIDDEN_ROLE' });

    const testConnRes = await request(app.getHttpServer())
      .post('/v1/admin/settings/payments/mercadopago/test-connection')
      .set('cookie', cookie);
    expect(testConnRes.status).toBe(403);
    expect(testConnRes.body).toEqual({ error: 'FORBIDDEN_ROLE' });
  });

  it('403 FORBIDDEN_ROLE on PATCH .../payments (providers.epayco) and POST .../payments/epayco/test-connection', async () => {
    const { cookie } = await signUpWithTenant('payments-settings-staff-epayco@demo.co', 'staff');

    const patchRes = await request(app.getHttpServer())
      .patch('/v1/admin/settings/payments')
      .set('cookie', cookie)
      .send({ providers: { epayco: EPAYCO_CREDS_BODY } });
    expect(patchRes.status).toBe(403);
    expect(patchRes.body).toEqual({ error: 'FORBIDDEN_ROLE' });

    const testConnRes = await request(app.getHttpServer())
      .post('/v1/admin/settings/payments/epayco/test-connection')
      .set('cookie', cookie);
    expect(testConnRes.status).toBe(403);
    expect(testConnRes.body).toEqual({ error: 'FORBIDDEN_ROLE' });
  });
});

describe('POST /v1/admin/settings/payments/:provider/test-connection', () => {
  it('{ok:false, error:"not configured"} (200, not an error status) when nothing has been saved yet', async () => {
    const { cookie } = await signUpWithTenant('payments-settings-testconn-unconfigured@demo.co', 'owner');

    const res = await request(app.getHttpServer())
      .post('/v1/admin/settings/payments/wompi/test-connection')
      .set('cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: false, error: 'not configured' });
  });

  it('surfaces {ok:false} with a 200 (never 500) when the underlying provider call fails', async () => {
    const { cookie } = await signUpWithTenant('payments-settings-testconn-fail@demo.co', 'owner');

    await request(app.getHttpServer())
      .patch('/v1/admin/settings/payments')
      .set('cookie', cookie)
      .send({ providers: { wompi: WOMPI_CREDS_BODY } });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('simulated provider outage')),
    );

    const res = await request(app.getHttpServer())
      .post('/v1/admin/settings/payments/wompi/test-connection')
      .set('cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toContain('simulated provider outage');
  });

  it('surfaces {ok:true} with a 200 when the underlying provider call succeeds', async () => {
    const { cookie } = await signUpWithTenant('payments-settings-testconn-ok@demo.co', 'owner');

    await request(app.getHttpServer())
      .patch('/v1/admin/settings/payments')
      .set('cookie', cookie)
      .send({ providers: { wompi: WOMPI_CREDS_BODY } });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ data: { status: 'DECLINED' } }),
      }),
    );

    const res = await request(app.getHttpServer())
      .post('/v1/admin/settings/payments/wompi/test-connection')
      .set('cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('mercadopago: {ok:false, error:"not configured"} (200, not an error status) when nothing has been saved yet', async () => {
    const { cookie } = await signUpWithTenant('payments-settings-testconn-mp-unconfigured@demo.co', 'owner');

    const res = await request(app.getHttpServer())
      .post('/v1/admin/settings/payments/mercadopago/test-connection')
      .set('cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: false, error: 'not configured' });
  });

  it('mercadopago: surfaces {ok:false} with a 200 (never 500) when the underlying provider call fails', async () => {
    const { cookie } = await signUpWithTenant('payments-settings-testconn-mp-fail@demo.co', 'owner');

    await request(app.getHttpServer())
      .patch('/v1/admin/settings/payments')
      .set('cookie', cookie)
      .send({ providers: { mercadopago: MERCADOPAGO_CREDS_BODY } });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('simulated provider outage')),
    );

    const res = await request(app.getHttpServer())
      .post('/v1/admin/settings/payments/mercadopago/test-connection')
      .set('cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toContain('simulated provider outage');
  });

  it('mercadopago: surfaces {ok:true} with a 200 when the underlying provider call succeeds', async () => {
    const { cookie } = await signUpWithTenant('payments-settings-testconn-mp-ok@demo.co', 'owner');

    await request(app.getHttpServer())
      .patch('/v1/admin/settings/payments')
      .set('cookie', cookie)
      .send({ providers: { mercadopago: MERCADOPAGO_CREDS_BODY } });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ status: 'rejected' }),
      }),
    );

    const res = await request(app.getHttpServer())
      .post('/v1/admin/settings/payments/mercadopago/test-connection')
      .set('cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('epayco: {ok:false, error:"not configured"} (200, not an error status) when nothing has been saved yet', async () => {
    const { cookie } = await signUpWithTenant('payments-settings-testconn-epayco-unconfigured@demo.co', 'owner');

    const res = await request(app.getHttpServer())
      .post('/v1/admin/settings/payments/epayco/test-connection')
      .set('cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: false, error: 'not configured' });
  });

  it('epayco: surfaces {ok:false} with a 200 (never 500) when the underlying provider call fails', async () => {
    const { cookie } = await signUpWithTenant('payments-settings-testconn-epayco-fail@demo.co', 'owner');

    await request(app.getHttpServer())
      .patch('/v1/admin/settings/payments')
      .set('cookie', cookie)
      .send({ providers: { epayco: EPAYCO_CREDS_BODY } });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('simulated provider outage')),
    );

    const res = await request(app.getHttpServer())
      .post('/v1/admin/settings/payments/epayco/test-connection')
      .set('cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toContain('simulated provider outage');
  });

  it('epayco: surfaces {ok:true} with a 200 when the underlying provider call succeeds', async () => {
    const { cookie } = await signUpWithTenant('payments-settings-testconn-epayco-ok@demo.co', 'owner');

    await request(app.getHttpServer())
      .patch('/v1/admin/settings/payments')
      .set('cookie', cookie)
      .send({ providers: { epayco: EPAYCO_CREDS_BODY } });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ data: { x_response: 'Rechazada' } }),
      }),
    );

    const res = await request(app.getHttpServer())
      .post('/v1/admin/settings/payments/epayco/test-connection')
      .set('cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});

describe('GET /v1/admin/settings — providers view shows all 3 providers simultaneously (P3b Task 4 controller generalization)', () => {
  it('shows wompi.connected + mercadopago.connected both true, epayco.connected false, after saving only two of the three', async () => {
    const { cookie } = await signUpWithTenant('payments-settings-all-providers-view@demo.co', 'owner');

    await request(app.getHttpServer())
      .patch('/v1/admin/settings/payments')
      .set('cookie', cookie)
      .send({ providers: { wompi: WOMPI_CREDS_BODY } });

    await request(app.getHttpServer())
      .patch('/v1/admin/settings/payments')
      .set('cookie', cookie)
      .send({ providers: { mercadopago: MERCADOPAGO_CREDS_BODY } });

    const getRes = await request(app.getHttpServer()).get('/v1/admin/settings').set('cookie', cookie);
    expect(getRes.status).toBe(200);

    const providers = getRes.body.payments.providers;
    expect(providers.wompi.connected).toBe(true);
    expect(providers.mercadopago.connected).toBe(true);
    // epayco was never saved for this tenant — must show as NOT connected,
    // not simply be absent from the response.
    expect(providers.epayco.connected).toBe(false);
    expect(providers.epayco.publicKeyMasked).toBeNull();

    // Sanity: each connected provider's masked key still traces back to its
    // own credentials, not a cross-provider mixup.
    expect(providers.wompi.publicKeyMasked.endsWith(WOMPI_CREDS_BODY.publicKey.slice(-4))).toBe(true);
    expect(providers.mercadopago.publicKeyMasked.endsWith(MERCADOPAGO_CREDS_BODY.publicKey.slice(-4))).toBe(true);
  });

  it('a SINGLE PATCH carrying all 3 providers at once saves all 3, none clobbering another', async () => {
    const { cookie, tenantId } = await signUpWithTenant('payments-settings-multi-provider-one-patch@demo.co', 'owner');

    const res = await request(app.getHttpServer())
      .patch('/v1/admin/settings/payments')
      .set('cookie', cookie)
      .send({
        providers: {
          wompi: WOMPI_CREDS_BODY,
          mercadopago: MERCADOPAGO_CREDS_BODY,
          epayco: EPAYCO_CREDS_BODY,
        },
      });
    expect(res.status).toBe(200);

    const providers = res.body.payments.providers;
    expect(providers.wompi.connected).toBe(true);
    expect(providers.mercadopago.connected).toBe(true);
    expect(providers.epayco.connected).toBe(true);
    expect(providers.wompi.publicKeyMasked.endsWith(WOMPI_CREDS_BODY.publicKey.slice(-4))).toBe(true);
    expect(providers.mercadopago.publicKeyMasked.endsWith(MERCADOPAGO_CREDS_BODY.publicKey.slice(-4))).toBe(true);
    expect(providers.epayco.publicKeyMasked.endsWith(EPAYCO_CREDS_BODY.publicKey.slice(-4))).toBe(true);

    // Confirm each provider's OWN raw stored blob really has its own
    // credentials (not, say, all 3 accidentally sharing the last-written
    // provider's data via a read-modify-write race inside the loop).
    const tenant = await platformDb.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    const settings = tenant.settings as { payments: { providers: Record<string, { publicKey: string }> } };
    expect(settings.payments.providers.wompi.publicKey).toBe(WOMPI_CREDS_BODY.publicKey);
    expect(settings.payments.providers.mercadopago.publicKey).toBe(MERCADOPAGO_CREDS_BODY.publicKey);
    expect(settings.payments.providers.epayco.publicKey).toBe(EPAYCO_CREDS_BODY.publicKey);
  });
});
