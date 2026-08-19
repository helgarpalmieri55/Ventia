import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient as PrismaClientType } from '@ventia/db';
import { startTestDb } from './helpers';
import type { signUpWithTenant as SignUpWithTenant } from './admin-helpers';
import { renderPrivacyPolicy } from '../src/settings/privacy-policy.template';

let db: Awaited<ReturnType<typeof startTestDb>>;
let redisContainer: StartedTestContainer;
let app: INestApplication;
let signUpWithTenant: typeof SignUpWithTenant;
let platformDb: PrismaClientType;

/** A fully-configured store: contact details, a connected gateway, COD, the AI
 * agent, WhatsApp and human handoff all on — so the conditional sections of
 * the template are exercised, not just the unconditional spine. */
async function buildFullTenant(email: string) {
  const { cookie, tenantId } = await signUpWithTenant(email, 'owner');
  // `TenantDomain.domain` is globally unique, so every tenant in this file
  // needs its own — derived from the (already unique) sign-up email.
  const domain = `${email.split('@')[0]}.ventia.localhost`;

  await platformDb.tenant.update({
    where: { id: tenantId },
    data: {
      name: 'Aromas del Quindío',
      settings: {
        storeInfo: {
          contactEmail: 'hola@aromasdelquindio.co',
          contactPhone: '+57 310 555 0134',
          category: 'hogar',
          // `storeSettingsSchema` (packages/core) does not accept these five
          // yet, so no merchant can save them through the settings endpoint
          // today — the generator reads them defensively so that the day the
          // schema grows them, the policy fills itself. Set here to exercise
          // the fully-configured path; the "missing optional data" test below
          // covers what every real store looks like until then.
          legalName: 'Aromas del Quindío S.A.S.',
          taxId: 'NIT 901.234.567-8',
          address: 'Carrera 14 # 8-42, local 3',
          municipio: 'Armenia',
          departamento: 'Quindío',
        },
        payments: {
          codEnabled: true,
          // Shape written by PaymentsService.saveProviderCredentials — the
          // presence of `privateKeyEncrypted` is what marks a provider
          // "connected" (see settings.controller.ts#maskedProviderView), and
          // the generator reads exactly that signal, never a decrypted secret.
          providers: { wompi: { publicKey: 'pub_test_1234', privateKeyEncrypted: 'iv:tag:ct', sandbox: true } },
        },
      },
      agentConfig: { agentName: 'Sofía', tone: 'cercano' },
    },
  });

  await platformDb.tenantDomain.create({
    data: { tenantId, domain, isPrimary: true, verifiedAt: new Date() },
  });
  await platformDb.tenantLimits.create({
    data: {
      tenantId,
      productsMax: 500,
      aiMessagesMonth: 2000,
      staffSeats: 5,
      customDomain: true,
      humanHandoff: true,
      whatsappChannel: true,
    },
  });
  await platformDb.whatsAppNumber.create({
    data: {
      tenantId,
      provider: 'cloud',
      externalId: `pn_${tenantId}`,
      displayPhone: '+57 310 555 0134',
      status: 'connected',
    },
  });

  return { cookie, tenantId, domain };
}

beforeAll(async () => {
  db = await startTestDb();
  redisContainer = await new GenericContainer('redis:7-alpine')
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
    .start();

  process.env.DATABASE_URL = db.url;
  process.env.REDIS_URL = `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`;

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

describe('POST /v1/admin/content/policy_privacy/generate', () => {
  it("interpolates the tenant's own store data into the policy", async () => {
    const { cookie, domain } = await buildFullTenant('policy-full@demo.co');

    const res = await request(app.getHttpServer())
      .post('/v1/admin/content/policy_privacy/generate')
      .set('cookie', cookie);

    expect(res.status).toBe(200);
    const body = res.body.bodyMd as string;

    // THE assertion this whole feature stands on: a policy that does not
    // actually name this merchant is not this merchant's policy. Every value
    // below comes from THIS tenant's row, and none of them appears anywhere in
    // the template's literal text.
    expect(body).toContain('Aromas del Quindío');
    expect(body).toContain('hola@aromasdelquindio.co');
    expect(body).toContain('+57 310 555 0134');
    expect(body).toContain(`https://${domain}`);
    expect(body).toContain('Wompi de Bancolombia');
    expect(body).toContain('Sofía, nuestro asistente virtual');

    expect(res.body.title).toBe('Política de tratamiento de datos personales');
    // Nothing anywhere in a published policy may read as a filled-in blank.
    expect(body).not.toMatch(/undefined|\[object Object\]|\[COMPLETAR/);
    expect(res.body.placeholders).toEqual([]);
  });

  it('states everything Ley 1581 / Decreto 1074 require a política de tratamiento to state', async () => {
    const { cookie } = await buildFullTenant('policy-legal@demo.co');

    const res = await request(app.getHttpServer())
      .post('/v1/admin/content/policy_privacy/generate')
      .set('cookie', cookie);
    const body = res.body.bodyMd as string;

    // Identity + contact of the Responsable (Decreto 1074 art. 2.2.2.25.3.1 #1)
    expect(body).toContain('Responsable del Tratamiento');
    expect(body).toMatch(/NIT o cédula/);
    expect(body).toMatch(/Domicilio:/);
    expect(body).toMatch(/Correo electrónico:/);

    // Data collected + purposes (#2), described from what we actually store
    expect(body).toContain('departamento');
    expect(body).toContain('municipio');
    expect(body).toContain('carrito de compras');

    // Rights under Ley 1581 art. 8, INCLUDING supresión and revocatoria (#3)
    expect(body).toContain('Conocer qué datos suyos tenemos');
    expect(body).toMatch(/[Aa]ctualizarlos y rectificarlos/);
    expect(body).toContain('supresión');
    expect(body).toMatch(/[Rr]evocar la autorización/);

    // Channel + procedure + statutory deadlines (#4 and #5, arts. 14/15/16)
    expect(body).toContain('diez (10) días hábiles');
    expect(body).toContain('quince (15) días hábiles');
    expect(body).toContain('Superintendencia de Industria y Comercio');

    // Effective date + database validity period (#6)
    expect(body).toMatch(/rige a partir del \d{1,2} de [a-zé]+ de \d{4}/);
  });

  it('produces a coherent document with visible placeholders when optional store data is missing', async () => {
    // signUpWithTenant leaves settings/agentConfig/limits null and creates no
    // domain — the state a merchant is in seconds after signing up.
    const { cookie } = await signUpWithTenant('policy-bare@demo.co', 'owner');

    const res = await request(app.getHttpServer())
      .post('/v1/admin/content/policy_privacy/generate')
      .set('cookie', cookie);

    expect(res.status).toBe(200);
    const body = res.body.bodyMd as string;

    // No `undefined`, no `null`, and no empty gap where a value should be.
    expect(body).not.toMatch(/undefined|\bnull\b|\[object Object\]/);
    expect(body).not.toMatch(/es\s*,\s*propietario/);
    // Every labelled contact line still carries something on the same line —
    // "Correo electrónico:" trailing into nothing is the failure mode that
    // would ship a policy naming no way to exercise any right.
    for (const label of ['Razón social o nombre', 'NIT o cédula', 'Domicilio', 'Correo electrónico', 'Teléfono']) {
      expect(body).toMatch(new RegExp(`${label}[^:\\n]*: *\\S`));
    }

    // Instead: loud, self-describing markers, echoed as a checklist.
    expect(body).toContain('[COMPLETAR: correo electrónico de contacto de la tienda]');
    expect(body).toContain('[COMPLETAR: NIT o número de cédula]');
    expect(res.body.placeholders).toContain('razón social o nombre completo del titular de la tienda');
    expect(res.body.placeholders).toContain('teléfono o WhatsApp de contacto');

    // And it is still a whole document: every section survives the missing data.
    for (const heading of [
      '1. Quién responde por sus datos',
      '2. Qué datos personales recogemos',
      '3. Para qué usamos sus datos',
      '4. Cómo obtenemos su autorización',
      '5. Con quién compartimos sus datos',
      '6. Sus derechos como titular de los datos',
      '7. Cómo ejercer sus derechos',
      '8. Por cuánto tiempo conservamos sus datos',
      '12. Vigencia',
    ]) {
      expect(body).toContain(heading);
    }
  });

  it('only claims the channels this store actually has', async () => {
    const { cookie: bare } = await signUpWithTenant('policy-channels-off@demo.co', 'owner');
    const { cookie: full } = await buildFullTenant('policy-channels-on@demo.co');

    const off = (
      await request(app.getHttpServer()).post('/v1/admin/content/policy_privacy/generate').set('cookie', bare)
    ).body.bodyMd as string;
    const on = (
      await request(app.getHttpServer()).post('/v1/admin/content/policy_privacy/generate').set('cookie', full)
    ).body.bodyMd as string;

    // A store with no agent, no WhatsApp and no gateway must not tell shoppers
    // their chats go to an AI provider or that we keep their WhatsApp number.
    expect(off).not.toContain('Anthropic');
    expect(off).not.toContain('asistente virtual');
    expect(off).not.toContain('Wompi');
    // The WhatsApp CHANNEL claims — "we keep the number you write from", "the
    // WhatsApp provider that carries your messages" — are the ones that must
    // not appear. Section 3 still says the store may contact you by WhatsApp
    // about your order, which is true of any Colombian merchant holding the
    // phone number you gave them at checkout, channel or no channel.
    expect(off).not.toContain('el número desde el cual escribe');
    expect(off).not.toContain('canal de WhatsApp');
    expect(off).not.toContain('Conversaciones:');

    expect(on).toContain('Anthropic');
    expect(on).toContain('el número desde el cual escribe');
    expect(on).toContain('asistente virtual');
  });

  it('tells the merchant — and only the merchant — that they are the responsable and this is not legal advice', async () => {
    const { cookie } = await buildFullTenant('policy-disclaimer@demo.co');

    const res = await request(app.getHttpServer())
      .post('/v1/admin/content/policy_privacy/generate')
      .set('cookie', cookie);

    expect(res.body.disclaimer).toContain('no es asesoría jurídica');
    expect(res.body.disclaimer).toContain('Responsable del Tratamiento eres tú');
    // The published page is addressed to shoppers; a "this is a template"
    // caveat there would only confuse who is answerable to them.
    expect(res.body.bodyMd).not.toContain('asesoría jurídica');
    expect(res.body.bodyMd).not.toContain('plantilla');
  });

  it('writes nothing: generating never publishes or overwrites', async () => {
    const { cookie, tenantId } = await buildFullTenant('policy-nowrite@demo.co');

    await request(app.getHttpServer()).post('/v1/admin/content/policy_privacy/generate').set('cookie', cookie);
    expect(await platformDb.tenantContent.count({ where: { tenantId } })).toBe(0);

    // With merchant-written content already saved, generating still leaves it
    // exactly as it was, and flags that something is there to be protected.
    await platformDb.tenantContent.create({
      data: { tenantId, type: 'policy_privacy', title: 'Mi política', bodyMd: 'Texto que escribí yo.' },
    });
    const res = await request(app.getHttpServer())
      .post('/v1/admin/content/policy_privacy/generate')
      .set('cookie', cookie);

    expect(res.body.hasExistingContent).toBe(true);
    const row = await platformDb.tenantContent.findFirstOrThrow({ where: { tenantId, type: 'policy_privacy' } });
    expect(row.bodyMd).toBe('Texto que escribí yo.');
  });

  it('403s a staff session', async () => {
    const { cookie } = await signUpWithTenant('policy-staff@demo.co', 'staff');
    const res = await request(app.getHttpServer())
      .post('/v1/admin/content/policy_privacy/generate')
      .set('cookie', cookie);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN_ROLE');
  });
});

describe('PUT /v1/admin/content/:type', () => {
  it('publishes the reviewed policy so the storefront stops falling back', async () => {
    const { cookie, tenantId } = await buildFullTenant('policy-publish@demo.co');

    const generated = await request(app.getHttpServer())
      .post('/v1/admin/content/policy_privacy/generate')
      .set('cookie', cookie);

    const edited = `${generated.body.bodyMd}\n\nAtendemos de lunes a sábado.`;
    const put = await request(app.getHttpServer())
      .put('/v1/admin/content/policy_privacy')
      .set('cookie', cookie)
      .send({ title: generated.body.title, bodyMd: edited });

    expect(put.status).toBe(200);
    expect(put.body.bodyMd).toBe(edited);

    // Round-trips through the admin editor...
    const get = await request(app.getHttpServer()).get('/v1/admin/content/policy_privacy').set('cookie', cookie);
    expect(get.status).toBe(200);
    expect(get.body.bodyMd).toContain('Aromas del Quindío');

    // ...and is the row the storefront's own content endpoint reads.
    const row = await platformDb.tenantContent.findFirstOrThrow({ where: { tenantId, type: 'policy_privacy' } });
    expect(row.title).toBe('Política de tratamiento de datos personales');
    expect(row.bodyMd).toBe(edited);

    // Editing is a mutation, so it is audited (spec §9).
    const audit = await platformDb.auditLog.findFirst({ where: { tenantId, action: 'content.update' } });
    expect(audit).not.toBeNull();
  });

  it('400s an unknown content type and an empty title', async () => {
    const { cookie } = await signUpWithTenant('policy-validation@demo.co', 'owner');

    const badType = await request(app.getHttpServer())
      .put('/v1/admin/content/politica_secreta')
      .set('cookie', cookie)
      .send({ title: 'X', bodyMd: 'y' });
    expect(badType.status).toBe(400);

    const badBody = await request(app.getHttpServer())
      .put('/v1/admin/content/policy_privacy')
      .set('cookie', cookie)
      .send({ bodyMd: 'sin título' });
    expect(badBody.status).toBe(400);
    expect(badBody.body.error).toBe('VALIDATION_FAILED');
  });

  it('403s a staff session on write but lets it read', async () => {
    const { cookie: owner, tenantId } = await buildFullTenant('policy-staff-write@demo.co');
    await request(app.getHttpServer())
      .put('/v1/admin/content/policy_privacy')
      .set('cookie', owner)
      .send({ title: 'Privacidad', bodyMd: 'Contenido del propietario.' });

    const { cookie: staff } = await signUpWithTenant('policy-staff-read@demo.co', 'staff');
    // Staff belongs to a DIFFERENT tenant here (signUpWithTenant provisions
    // one per call), so this also re-proves tenant scoping on these routes.
    const write = await request(app.getHttpServer())
      .put('/v1/admin/content/policy_privacy')
      .set('cookie', staff)
      .send({ title: 'Privacidad', bodyMd: 'Escrito por staff.' });
    expect(write.status).toBe(403);

    const read = await request(app.getHttpServer()).get('/v1/admin/content').set('cookie', staff);
    expect(read.status).toBe(200);
    expect(read.body.items.find((i: { type: string }) => i.type === 'policy_privacy').bodyMd).toBeNull();

    const untouched = await platformDb.tenantContent.findFirstOrThrow({
      where: { tenantId, type: 'policy_privacy' },
    });
    expect(untouched.bodyMd).toBe('Contenido del propietario.');
  });
});

describe('renderPrivacyPolicy (pure)', () => {
  const base = {
    storeName: 'Tienda Nueva',
    domain: null,
    contactEmail: null,
    contactPhone: null,
    legalName: null,
    taxId: null,
    addressLine: null,
    municipio: null,
    departamento: null,
    codEnabled: false,
    paymentProviders: [],
    agentEnabled: false,
    agentName: null,
    whatsappConnected: false,
    humanHandoffEnabled: false,
    effectiveDate: new Date('2026-08-19T15:00:00Z'),
  };

  it('formats the effective date in Colombian civil time, in Spanish', () => {
    expect(renderPrivacyPolicy(base).bodyMd).toContain('rige a partir del 19 de agosto de 2026');
    // 20:30 in Bogotá is already the 20th in UTC; the merchant's date is the
    // one that goes in the document.
    expect(
      renderPrivacyPolicy({ ...base, effectiveDate: new Date('2026-08-20T01:30:00Z') }).bodyMd,
    ).toContain('rige a partir del 19 de agosto de 2026');
  });

  it('is deterministic and free of I/O', () => {
    expect(renderPrivacyPolicy(base)).toEqual(renderPrivacyPolicy(base));
  });

  it('joins several payment gateways the way Spanish does', () => {
    const body = renderPrivacyPolicy({
      ...base,
      paymentProviders: ['wompi', 'mercadopago', 'epayco'],
    }).bodyMd;
    expect(body).toContain('Wompi de Bancolombia, Mercado Pago y ePayco');
    expect(body).toContain('las pasarelas de pago');
  });
});
