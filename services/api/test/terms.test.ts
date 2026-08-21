import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient as PrismaClientType } from '@ventia/db';
import { startTestDb } from './helpers';
import type { signUpWithTenant as SignUpWithTenant } from './admin-helpers';
import { renderTerms } from '../src/settings/terms.template';

let db: Awaited<ReturnType<typeof startTestDb>>;
let redisContainer: StartedTestContainer;
let app: INestApplication;
let signUpWithTenant: typeof SignUpWithTenant;
let platformDb: PrismaClientType;

/**
 * A fully-configured store: identidad legal, a connected gateway, COD with two
 * restricted departamentos, all four shipping method shapes, the AI agent and
 * WhatsApp — so the conditional parts of the contract are exercised, not just
 * the unconditional spine.
 *
 * The shipping methods are written in the shape `ShippingService.loadConfig`
 * reads (`settings.shipping.methods`), because the document QUOTES their
 * prices and those prices are contractual terms: a fixture that invented its
 * own shape would keep passing on the day the two readers diverged.
 */
async function buildFullTenant(email: string) {
  const { cookie, tenantId } = await signUpWithTenant(email, 'owner');
  const domain = `${email.split('@')[0]}.ventia.localhost`;

  // Through the REAL settings endpoint, so this also re-proves
  // `storeSettingsSchema` keeps the five identidad-legal keys the generator
  // reads by name.
  const storeRes = await request(app.getHttpServer())
    .patch('/v1/admin/settings/store')
    .set('cookie', cookie)
    .send({
      name: 'Aromas del Quindío',
      storeInfo: {
        contactEmail: 'hola@aromasdelquindio.co',
        contactPhone: '+57 310 555 0134',
        legalName: 'Aromas del Quindío S.A.S.',
        taxId: 'NIT 901.234.567-8',
        address: 'Carrera 14 # 8-42, local 3',
        municipio: 'Armenia',
        departamento: 'Quindío',
      },
    });
  if (storeRes.status !== 200) {
    throw new Error(`settings/store PATCH failed: ${storeRes.status} ${JSON.stringify(storeRes.body)}`);
  }

  await platformDb.tenant.update({
    where: { id: tenantId },
    data: {
      name: 'Aromas del Quindío',
      settings: {
        storeInfo: { ...(storeRes.body.storeInfo as Record<string, unknown>) },
        payments: {
          codEnabled: true,
          // `privateKeyEncrypted` present == "connected" (see
          // settings.controller.ts#maskedProviderView); the generator reads
          // exactly that signal, never a decrypted secret.
          providers: { wompi: { publicKey: 'pub_test_1234', privateKeyEncrypted: 'iv:tag:ct', sandbox: true } },
        },
        shipping: {
          methods: [
            { id: 'm1', type: 'flat', label: 'Envío estándar', priceCents: 990000, enabled: true },
            {
              id: 'm2',
              type: 'free_over',
              label: 'Envío gratis',
              thresholdCents: 15000000,
              fallbackPriceCents: 1200000,
              enabled: true,
            },
            { id: 'm3', type: 'pickup', label: 'Recoger en tienda', enabled: true },
            // Disabled: a shopper cannot pick it, so the contract must not
            // quote its price as if they could.
            { id: 'm4', type: 'flat', label: 'Mensajería urgente', priceCents: 4500000, enabled: false },
          ],
          // 88 = San Andrés, Providencia y Santa Catalina; 91 = Amazonas.
          codRestrictedDepartamentos: ['88', '91'],
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

function generate(cookie: string) {
  return request(app.getHttpServer()).post('/v1/admin/content/policy_terms/generate').set('cookie', cookie);
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

describe('POST /v1/admin/content/policy_terms/generate', () => {
  it("interpolates the tenant's own store data into the contract", async () => {
    const { cookie, domain } = await buildFullTenant('terms-full@demo.co');

    const res = await generate(cookie);
    expect(res.status).toBe(200);
    const body = res.body.bodyMd as string;

    // THE assertion this whole feature stands on: a contract that does not
    // name this merchant, at this address, with this NIT, is not this
    // merchant's contract — and Ley 1480 art. 50 lit. a) makes exactly those
    // fields mandatory. None of these values appears in the template's
    // literal text.
    expect(body).toContain('Aromas del Quindío S.A.S.');
    expect(body).toContain('NIT 901.234.567-8');
    expect(body).toContain('Carrera 14 # 8-42, local 3, Armenia, Quindío, Colombia');
    expect(body).toContain('hola@aromasdelquindio.co');
    expect(body).toContain('+57 310 555 0134');
    expect(body).toContain(`https://${domain}/terminos-y-condiciones`);
    expect(body).toContain(`https://${domain}/rastrear`);
    expect(body).toContain(`https://${domain}/privacidad`);
    expect(body).toContain('Wompi de Bancolombia');

    expect(res.body.title).toBe('Términos y condiciones');
    // Nothing anywhere in a published contract may read as a filled-in blank.
    expect(body).not.toMatch(/undefined|\[object Object\]/);
  });

  it("quotes this store's real shipping prices, and only the methods a shopper can pick", async () => {
    const { cookie } = await buildFullTenant('terms-shipping@demo.co');
    const body = (await generate(cookie)).body.bodyMd as string;

    // Prices come from `settings.shipping.methods` through the same reader
    // that prices a real checkout, formatted the way the storefront cart
    // formats them. A shipping price in a published contract is a term the
    // merchant is held to, so a wrong number here is worse than no number.
    expect(body).toContain('Envío estándar: $ 9.900 por pedido.');
    expect(body).toContain('Envío gratis: sin costo de envío cuando los productos de su pedido suman $ 150.000 o más.');
    expect(body).toContain('Por debajo de ese valor, el envío cuesta $ 12.000.');
    expect(body).toContain('Recoger en tienda: usted recoge el pedido y no paga costo de envío.');

    // Disabled method: not offerable at checkout, therefore not promised here.
    expect(body).not.toContain('Mensajería urgente');
    expect(body).not.toContain('45.000');
  });

  it('names the departamentos where contra entrega is genuinely switched off', async () => {
    const { cookie } = await buildFullTenant('terms-cod-zones@demo.co');
    const body = (await generate(cookie)).body.bodyMd as string;

    // Resolved from the DANE codes `ShippingService.isCodAllowedIn` actually
    // enforces, so the contract cannot promise COD where checkout refuses it.
    expect(body).toContain('El pago contra entrega no está disponible para entregas en estos departamentos:');
    expect(body).toContain('San Andrés, Providencia y Santa Catalina');
    expect(body).toContain('Amazonas');
    // Not "...en San Andrés, Providencia y Santa Catalina y Amazonas", which
    // reads as four places. See the template's comment on this branch.
    expect(body).not.toContain('Santa Catalina y Amazonas');
  });

  it('states what Ley 1480 requires a distance-sale contract to state', async () => {
    const { cookie } = await buildFullTenant('terms-legal@demo.co');
    const body = (await generate(cookie)).body.bodyMd as string;

    // art. 50 lit. a) identity of the seller, incl. the judicial notification
    // address the article names explicitly.
    expect(body).toContain('dirección para notificaciones judiciales');
    expect(body).toMatch(/NIT o cédula:/);

    // art. 50 lit. d) condiciones generales, consultable/printable/downloadable
    expect(body).toContain('condiciones generales del contrato');
    expect(body).toContain('imprimirlos y descargarlos antes y después de comprar');
    expect(body).toContain('resumen del pedido');

    // art. 50 lit. c) total price INCLUDING taxes, shipping quoted separately
    expect(body).toContain('ya incluyen el IVA');
    expect(body).toContain('El costo de envío es un valor aparte');

    // art. 50 lit. h) thirty calendar days to deliver, or the contract ends
    expect(body).toContain('treinta (30) días calendario siguientes al día en que lo hizo');

    // art. 47 retracto: five business days, all money back, no deductions,
    // thirty calendar days, return shipping on the consumer.
    expect(body).toContain('derecho de retracto');
    expect(body).toContain('cinco (5) días hábiles contados desde el día en que usted recibe el producto');
    expect(body).toContain('sin hacer descuentos ni retenciones por ningún concepto');
    expect(body).toContain('no puede tardar más de treinta (30) días calendario');
    expect(body).toContain('Los costos de transporte y los demás gastos que implique devolverlo los asume usted');

    // art. 51 reversión: the electronic-instrument precondition, the five
    // business days, and BOTH notifications (us and the card issuer).
    expect(body).toContain('reversión del pago');
    expect(body).toContain('instrumento de pago electrónico');
    expect(body).toContain('notificarle la reclamación al banco');

    // arts. 8 / 11 / 16 garantía legal
    expect(body).toContain('garantía es de un (1) año para productos nuevos');
    expect(body).toContain('la garantía va hasta la fecha de vencimiento');
    expect(body).toContain('se lo reponemos o le devolvemos el dinero');

    // art. 58 num. 5 reclamación directa: fifteen business days to answer,
    // and the requisito de procedibilidad before the SIC.
    expect(body).toContain('quince (15) días hábiles');
    expect(body).toContain('Superintendencia de Industria y Comercio');

    // Fecha de entrada en vigencia.
    expect(body).toMatch(/rigen a partir del \d{1,2} de [a-zé]+ de \d{4}/);
  });

  it('says what contra entrega does and does not change about the shopper\'s rights', async () => {
    const { cookie } = await buildFullTenant('terms-cod@demo.co');
    const body = (await generate(cookie)).body.bodyMd as string;

    // The distinction the whole COD section exists for: art. 47 retracto
    // applies to a cash-on-delivery purchase (it is still a venta a
    // distancia), while art. 51 reversión does NOT, because there is no
    // electronic payment instrument to reverse. Getting this backwards is the
    // single most likely error in a Colombian e-commerce terms page.
    expect(body).toContain('Si usted pagó contra entrega, el derecho de retracto le aplica exactamente igual');
    expect(body).toContain('Esta reversión no aplica cuando usted pagó contra entrega en efectivo');

    // And what the code actually does before a COD order ships.
    expect(body).toContain('Antes de despachar un pedido contra entrega lo confirmamos con usted');
  });

  it('only promises the payment mechanics this store actually has', async () => {
    const { cookie: full } = await buildFullTenant('terms-channels-on@demo.co');
    const { cookie: bare } = await signUpWithTenant('terms-channels-off@demo.co', 'owner');

    const on = (await generate(full)).body.bodyMd as string;
    const off = (await generate(bare)).body.bodyMd as string;

    // A store with no gateway holds no fifteen-minute stock reservation
    // (`stockReservedUntil` is null for COD-only orders), has no gateway to
    // name, and no COD to describe.
    expect(off).not.toContain('Wompi');
    expect(off).not.toContain('quince (15) minutos');
    expect(off).not.toContain('contra entrega');
    expect(off).not.toContain('Chat de nuestra tienda');
    expect(off).toContain('[COMPLETAR: los medios de pago que aceptas]');

    expect(on).toContain('quince (15) minutos');
    expect(on).toContain('También puede pagar contra entrega');
    expect(on).toContain('Chat de nuestra tienda');
  });

  it('produces a coherent contract with visible placeholders when the store data is missing', async () => {
    // signUpWithTenant leaves settings/agentConfig/limits null and creates no
    // domain — the state a merchant is in seconds after signing up.
    const { cookie } = await signUpWithTenant('terms-bare@demo.co', 'owner');

    const res = await generate(cookie);
    expect(res.status).toBe(200);
    const body = res.body.bodyMd as string;

    // No `undefined`, no `null`, no empty gap where a value should be.
    expect(body).not.toMatch(/undefined|\bnull\b|\[object Object\]/);
    expect(body).not.toMatch(/es\s*,\s*responsable/);
    // Every labelled line still carries something after its colon — a
    // "Correo electrónico:" trailing into nothing would publish a contract
    // naming no way to exercise any right in it.
    for (const label of [
      'Razón social o nombre',
      'NIT o cédula',
      'Dirección, domicilio y dirección para notificaciones judiciales',
      'Correo electrónico',
      'Teléfono',
      'Tienda en línea',
    ]) {
      expect(body).toMatch(new RegExp(`${label}[^:\\n]*: *\\S`));
    }

    // Loud, self-describing markers instead, echoed as a checklist.
    expect(body).toContain('[COMPLETAR: NIT o número de cédula]');
    expect(body).toContain('[COMPLETAR: las opciones de envío que ofreces y cuánto cuesta cada una]');
    expect(res.body.placeholders).toContain('razón social o nombre completo del titular de la tienda');
    expect(res.body.placeholders).toContain('dirección web de la tienda');

    // And it is still a whole contract: every numbered section survives, so
    // the cross-references inside it ("los canales de la sección 14") still
    // point at something.
    for (const heading of [
      '1. Quién le vende',
      '2. Qué son estos términos y cuándo los acepta',
      '5. Precios, impuestos y costo de envío',
      '9. Envíos y entrega',
      '11. Su derecho de retracto',
      '12. Reversión del pago',
      '13. Garantía legal',
      '14. Peticiones, quejas y reclamos',
      '20. Vigencia',
    ]) {
      expect(body).toContain(heading);
    }
  });

  it('still asks for delivery time and invoicing even from a fully-configured store', async () => {
    const { cookie } = await buildFullTenant('terms-unknowable@demo.co');
    const res = await generate(cookie);
    const body = res.body.bodyMd as string;

    // The deliberate difference from the privacy generator, where a complete
    // store gets zero markers. Nothing in this platform holds a delivery
    // estimate or an invoicing arrangement, and both are contractual terms
    // the merchant would be held to — so they are asked for, never guessed.
    expect(res.body.placeholders).toEqual([
      'tiempo estimado de entrega, por ejemplo "de 2 a 5 días hábiles en ciudades principales y de 3 a 8 en el resto del país"',
      'cómo entregas la factura electrónica o el documento equivalente y cuándo la recibe el cliente',
    ]);
    expect(body).toContain('Tiempo estimado de entrega: [COMPLETAR:');
    expect(body).toContain('Sobre la factura: [COMPLETAR:');
    // The identidad-legal markers ARE gone once the merchant saved them.
    expect(body).not.toContain('[COMPLETAR: NIT o número de cédula]');
  });

  it('tells the merchant — and only the merchant — that this is a template and they are the proveedor', async () => {
    const { cookie } = await buildFullTenant('terms-disclaimer@demo.co');
    const res = await generate(cookie);

    expect(res.body.disclaimer).toContain('no es asesoría jurídica');
    expect(res.body.disclaimer).toContain('El proveedor frente a tus clientes eres tú');
    // The published page is addressed to shoppers; a "this is a template"
    // caveat there would only confuse who is answerable to them.
    expect(res.body.bodyMd).not.toContain('asesoría jurídica');
    expect(res.body.bodyMd).not.toContain('plantilla');
    expect(res.body.bodyMd).not.toContain('abogado');
    expect(res.body.bodyMd).not.toContain('[COMPLETAR: ...]');
  });

  it('writes nothing: generating never publishes or overwrites', async () => {
    const { cookie, tenantId } = await buildFullTenant('terms-nowrite@demo.co');

    await generate(cookie);
    expect(await platformDb.tenantContent.count({ where: { tenantId } })).toBe(0);

    await platformDb.tenantContent.create({
      data: { tenantId, type: 'policy_terms', title: 'Mis términos', bodyMd: 'Texto que escribí yo.' },
    });
    const res = await generate(cookie);

    expect(res.body.hasExistingContent).toBe(true);
    const row = await platformDb.tenantContent.findFirstOrThrow({ where: { tenantId, type: 'policy_terms' } });
    expect(row.bodyMd).toBe('Texto que escribí yo.');
  });

  it('403s a staff session', async () => {
    const { cookie } = await signUpWithTenant('terms-staff@demo.co', 'staff');
    const res = await generate(cookie);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN_ROLE');
  });
});

describe('policy_terms as a content type', () => {
  it('publishes through the same editor and is readable by the storefront', async () => {
    const { cookie, tenantId, domain } = await buildFullTenant('terms-publish@demo.co');

    const generated = await generate(cookie);
    const edited = `${generated.body.bodyMd}\n\nAtendemos de lunes a sábado.`;

    const put = await request(app.getHttpServer())
      .put('/v1/admin/content/policy_terms')
      .set('cookie', cookie)
      .send({ title: generated.body.title, bodyMd: edited });
    expect(put.status).toBe(200);
    expect(put.body.type).toBe('policy_terms');

    // Round-trips through the admin editor...
    const get = await request(app.getHttpServer()).get('/v1/admin/content/policy_terms').set('cookie', cookie);
    expect(get.status).toBe(200);
    expect(get.body.bodyMd).toBe(edited);

    // ...appears in the list every content row comes back in...
    const list = await request(app.getHttpServer()).get('/v1/admin/content').set('cookie', cookie);
    expect(list.body.items.map((i: { type: string }) => i.type)).toContain('policy_terms');

    // ...and is what the PUBLIC storefront endpoint serves, which is the
    // whole point: `/terminos-y-condiciones` renders this or the fallback.
    const publicRes = await request(app.getHttpServer())
      .get('/v1/storefront/content/policy_terms')
      .set('x-tenant-domain', domain);
    expect(publicRes.status).toBe(200);
    expect(publicRes.body.title).toBe('Términos y condiciones');
    expect(publicRes.body.bodyMd).toBe(edited);

    // Editing is a mutation, so it is audited (spec §9).
    const audit = await platformDb.auditLog.findFirst({
      where: { tenantId, action: 'content.update' },
    });
    expect(audit).not.toBeNull();
  });

  it('404s the storefront while the merchant has published nothing', async () => {
    // Which is what makes apps/storefront's POLICY_DEFAULTS.policy_terms
    // fallback reachable — the one that deliberately refuses to invent a
    // contract in the merchant's name.
    const { domain } = await buildFullTenant('terms-unpublished@demo.co');
    const res = await request(app.getHttpServer())
      .get('/v1/storefront/content/policy_terms')
      .set('x-tenant-domain', domain);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('CONTENT_NOT_FOUND');
  });
});

describe('renderTerms (pure)', () => {
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
    shippingMethods: [],
    codRestrictedDepartamentos: [],
    agentEnabled: false,
    whatsappConnected: false,
    effectiveDate: new Date('2026-08-21T15:00:00Z'),
  };

  it('formats the effective date in Colombian civil time, in Spanish', () => {
    expect(renderTerms(base).bodyMd).toContain('rigen a partir del 21 de agosto de 2026');
    // 20:30 in Bogotá is already the 22nd in UTC; the merchant's date is the
    // one that goes in the document.
    expect(renderTerms({ ...base, effectiveDate: new Date('2026-08-22T01:30:00Z') }).bodyMd).toContain(
      'rigen a partir del 21 de agosto de 2026',
    );
  });

  it('is deterministic and free of I/O', () => {
    expect(renderTerms(base)).toEqual(renderTerms(base));
  });

  it('joins several payment gateways the way Spanish does', () => {
    const body = renderTerms({ ...base, paymentProviders: ['wompi', 'mercadopago', 'epayco'] }).bodyMd;
    expect(body).toContain('Wompi de Bancolombia, Mercado Pago y ePayco');
  });

  it('drops a malformed shipping method instead of quoting a guessed price', () => {
    // `settings.shipping` is unvalidated JSON. A method with no price is one
    // `ShippingService.priceForIn` would refuse at checkout
    // (SHIPPING_METHOD_UNAVAILABLE), so promising it a price here would put a
    // number in a contract that the checkout will not honour.
    const body = renderTerms({
      ...base,
      shippingMethods: [
        { id: 'ok', type: 'flat', label: 'Envío nacional', priceCents: 1500000, enabled: true },
        { id: 'broken', type: 'flat', label: 'Rota', enabled: true },
        { id: 'nameless', type: 'flat', label: '   ', priceCents: 100, enabled: true },
      ] as never,
    }).bodyMd;

    expect(body).toContain('Envío nacional: $ 15.000 por pedido.');
    expect(body).not.toContain('Rota');
    expect(body).not.toMatch(/undefined|NaN/);
  });

  it('never leaks the merchant-facing disclaimer into the published body', () => {
    // Belt and braces for the pure layer: `renderTerms` has no way to reach
    // TERMS_DISCLAIMER, and this is the test that would fail if someone
    // "helpfully" prepended it.
    expect(renderTerms(base).bodyMd).not.toContain('asesoría jurídica');
  });
});
