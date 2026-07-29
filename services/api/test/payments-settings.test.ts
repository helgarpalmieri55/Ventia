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
});
