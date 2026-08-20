import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import Redis from 'ioredis';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient as PrismaClientType } from '@ventia/db';
import { startTestDb } from './helpers';
import { MAILER, type Mailer, type MailMessage } from '../src/mailer/mailer';
import type { PaymentsService as PaymentsServiceType } from '../src/payments/payments.service';
import { NO_PUBLISHED_POLICY_VERSION, privacyPolicyVersionFor } from '../src/checkout/privacy-consent';

const CHECKOUT_TEST_DOMAINS = [
  'checkout-a.ventia.localhost',
  'checkout-b.ventia.localhost',
  'checkout-c.ventia.localhost',
  'checkout-d.ventia.localhost',
  'checkout-e.ventia.localhost',
  'checkout-f.ventia.localhost',
  'checkout-g.ventia.localhost',
  'checkout-h.ventia.localhost',
  'checkout-i.ventia.localhost',
  'checkout-j.ventia.localhost',
  'checkout-k.ventia.localhost',
  'checkout-l.ventia.localhost',
  'checkout-m.ventia.localhost',
  'checkout-n.ventia.localhost',
  // Tenants O and P exist ONLY for the two-tenant redirect-URL test. P
  // deliberately owns a fully CUSTOM domain (not a `*.ventia.localhost`
  // subdomain), which is the case no `PLATFORM_ROOT_DOMAIN` rule could derive.
  'checkout-o.ventia.localhost',
  'tienda-p.example.com',
  // Tenant Q exists only for the Ley 1581 authorization tests at the bottom of
  // this file, which need a tenant whose order rows and published policy
  // nothing else in this file touches.
  'checkout-q.ventia.localhost',
];

// Same fixture shape as payments-service.test.ts/webhooks.test.ts's own
// FAKE_CREDS — a real (fake but well-formed) Wompi credential set saved
// through the REAL PaymentsService.saveProviderCredentials/encryption, not
// mocked, so the `wompi` checkout tests below exercise the actual
// getTenantProviderConfig lookup checkout.service.ts's new branch calls.
const FAKE_WOMPI_CREDS = {
  publicKey: 'pub_test_ABCDEFGHIJKLMNOPQRSTUV',
  privateKey: 'prv_test_ZYXWVUTSRQPONMLKJIHGFEDCBA0123456789',
  integritySecret: 'test_integrity_abc123def456',
  eventsSecret: 'test_events_ghi789jkl012',
  sandbox: true,
};

let db: Awaited<ReturnType<typeof startTestDb>>;
let prisma: PrismaClientType;
let app: INestApplication;
let sentMail: MailMessage[];
let paymentsService: PaymentsServiceType;

// tenantId fixtures, populated in beforeAll.
let tenantAId: string; // happy path + unconfigured-shipping-method + same-email reuse
let tenantBId: string; // insufficient stock
let tenantCId: string; // COD-restricted departamento
let tenantDId: string; // no cart cookie at all
let tenantEId: string; // concurrency
let tenantFId: string; // product archived after being added to cart
let tenantGId: string; // wompi happy path
let tenantHId: string; // wompi insufficient stock (wompi credentials configured)
let tenantIId: string; // wompi checkout, tenant never configured wompi credentials
let tenantJId: string; // wompi concurrent-checkout stock-reservation race (STOCK_BELOW_ZERO -> INSUFFICIENT_STOCK remap)
let tenantKId: string; // wompi checkout, credentials saved but missing integritySecret/eventsSecret
let tenantLId: string; // mercadopago checkout, tenant never configured mercadopago credentials — no real adapter exists yet (P3b Task 1)
let tenantMId: string; // mercadopago checkout, credentials saved but missing eventsSecret (phase-7 review gap)
let tenantNId: string; // epayco checkout, credentials saved but missing epaycoCustomerId (phase-7 review gap)
let tenantOId: string; // wompi checkout on a *.ventia.localhost domain — half of the two-tenant redirect-URL test
let tenantPId: string; // wompi checkout on a fully CUSTOM domain — other half of the two-tenant redirect-URL test
let tenantQId: string; // Ley 1581 authorization: the checkbox gate + the prueba de la autorización written onto the order

// Product fixture ids, populated in beforeAll.
let productXId: string; // tenant A — 45900 cents
let productYId: string; // tenant A — 20000 cents
let stockOkProductId: string; // tenant B — enough stock
let stockShortProductId: string; // tenant B — insufficient stock
let codProductId: string; // tenant C
let concurrencyProductId: string; // tenant E — plenty of stock
let archivableProductId: string; // tenant F — active at add-to-cart time, archived before checkout
let wompiHappyProductId: string; // tenant G — enough stock, wompi checkout
let wompiStockShortProductId: string; // tenant H — insufficient stock, wompi checkout
let wompiUnconfiguredProductId: string; // tenant I — wompi checkout, no provider credentials saved
let wompiRaceProductId: string; // tenant J — stock 1, two concurrent wompi checkouts race for it
let wompiIncompleteCredsProductId: string; // tenant K — wompi credentials missing integritySecret/eventsSecret
let mercadopagoUnconfiguredProductId: string; // tenant L — mercadopago checkout, no provider credentials saved
let mercadopagoIncompleteCredsProductId: string; // tenant M — mercadopago credentials missing eventsSecret
let epaycoIncompleteCredsProductId: string; // tenant N — epayco credentials missing epaycoCustomerId
let multiTenantOProductId: string; // tenant O — wompi checkout, two-tenant redirect-URL test
let multiTenantPProductId: string; // tenant P — wompi checkout, two-tenant redirect-URL test
let consentProductId: string; // tenant Q — plenty of stock, one cod checkout per authorization test

const BOGOTA_ADDRESS = {
  nombreCompleto: 'Ana Ejemplo',
  telefono: '3001234567',
  departamentoCode: '11',
  municipioName: 'Bogotá, D.C.',
  direccion: 'Calle 1 # 2-34',
};

/** Extracts the `ventia_cart` cookie value from a response's Set-Cookie header. */
function extractCartCookie(res: request.Response): string {
  const setCookie = res.headers['set-cookie'] as unknown as string[] | undefined;
  const raw = setCookie?.find((c) => c.startsWith('ventia_cart='));
  if (!raw) throw new Error('expected a ventia_cart Set-Cookie header');
  return raw.split(';')[0].split('=')[1];
}

/** Adds one product to a brand-new cart (no incoming cookie) and returns the
 * resulting `ventia_cart` cookie value for that session. */
async function newCartWithItem(domain: string, productId: string, qty: number): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/v1/storefront/cart/items')
    .set('x-tenant-domain', domain)
    .send({ productId, qty });
  expect(res.status).toBe(201);
  return extractCartCookie(res);
}

beforeAll(async () => {
  db = await startTestDb();
  // platformDb (exported by @ventia/db) is constructed at module-evaluation
  // time from process.env.DATABASE_URL, so env vars must be set BEFORE the
  // first import of @ventia/db or ../src/main — see cart.test.ts for the
  // same pattern.
  process.env.DATABASE_URL = db.url;
  process.env.REDIS_URL = 'redis://localhost:6379';
  // A real, valid 32-byte base64 key — the `wompi` tests below exercise REAL
  // encrypt/decrypt through PaymentsService.saveProviderCredentials /
  // getTenantProviderConfig, never mocked (same posture as
  // payments-service.test.ts / webhooks.test.ts).
  process.env.PAYMENTS_ENCRYPTION_KEY = Buffer.alloc(32, 13).toString('base64');

  // DomainResolver caches resolved tenants by domain in the shared dev Redis
  // for 60s (see cart.test.ts's identical comment) — flush this file's fixed
  // domains up front so a stale entry from a previous local run can't point
  // at a tenantId that doesn't exist in this run's fresh Postgres container.
  const cacheBuster = new Redis(process.env.REDIS_URL);
  await cacheBuster.del(...CHECKOUT_TEST_DOMAINS.map((d) => `tenant:domain:${d}`));
  await cacheBuster.quit();

  const { PrismaClient } = (await import('@ventia/db')) as { PrismaClient: typeof PrismaClientType };
  prisma = new PrismaClient({ datasources: { db: { url: db.url } } });

  // Tenant A: flat shipping, no COD restriction — the "everything should just
  // work" tenant, reused across the happy path, unconfigured-shipping-method,
  // and same-email-updates-Customer tests.
  const tenantA = await prisma.tenant.create({
    data: {
      slug: 'checkout-a',
      name: 'Checkout A',
      status: 'live',
      settings: {
        shipping: {
          methods: [{ id: 'flat-1', type: 'flat', label: 'Envío estándar', priceCents: 12000, enabled: true }],
        },
      },
    },
  });
  tenantAId = tenantA.id;
  await prisma.tenantDomain.create({ data: { tenantId: tenantAId, domain: 'checkout-a.ventia.localhost', isPrimary: true } });

  const productX = await prisma.product.create({
    data: { tenantId: tenantAId, name: 'Camiseta', slug: 'camiseta', priceCents: 45900, status: 'active', stock: 10 },
  });
  productXId = productX.id;
  const productY = await prisma.product.create({
    data: { tenantId: tenantAId, name: 'Gorra', slug: 'gorra', priceCents: 20000, status: 'active', stock: 5 },
  });
  productYId = productY.id;

  // Tenant B: insufficient stock on one of two lines.
  const tenantB = await prisma.tenant.create({
    data: {
      slug: 'checkout-b',
      name: 'Checkout B',
      status: 'live',
      settings: {
        shipping: {
          methods: [{ id: 'flat-1', type: 'flat', label: 'Envío estándar', priceCents: 12000, enabled: true }],
        },
      },
    },
  });
  tenantBId = tenantB.id;
  await prisma.tenantDomain.create({ data: { tenantId: tenantBId, domain: 'checkout-b.ventia.localhost', isPrimary: true } });

  const stockOkProduct = await prisma.product.create({
    data: { tenantId: tenantBId, name: 'Camisa OK', slug: 'camisa-ok', priceCents: 30000, status: 'active', stock: 10 },
  });
  stockOkProductId = stockOkProduct.id;
  const stockShortProduct = await prisma.product.create({
    data: { tenantId: tenantBId, name: 'Pantalón Escaso', slug: 'pantalon-escaso', priceCents: 40000, status: 'active', stock: 1 },
  });
  stockShortProductId = stockShortProduct.id;

  // Tenant C: COD restricted for departamento '11' (Bogotá — the address
  // every test in this file uses).
  const tenantC = await prisma.tenant.create({
    data: {
      slug: 'checkout-c',
      name: 'Checkout C',
      status: 'live',
      settings: {
        shipping: {
          methods: [{ id: 'flat-1', type: 'flat', label: 'Envío estándar', priceCents: 12000, enabled: true }],
          codRestrictedDepartamentos: ['11'],
        },
      },
    },
  });
  tenantCId = tenantC.id;
  await prisma.tenantDomain.create({ data: { tenantId: tenantCId, domain: 'checkout-c.ventia.localhost', isPrimary: true } });

  const codProduct = await prisma.product.create({
    data: { tenantId: tenantCId, name: 'Producto COD', slug: 'producto-cod', priceCents: 25000, status: 'active', stock: 10 },
  });
  codProductId = codProduct.id;

  // Tenant D: no shipping/products needed — used only for the "no cart
  // cookie at all" short-circuit test.
  const tenantD = await prisma.tenant.create({ data: { slug: 'checkout-d', name: 'Checkout D', status: 'live' } });
  tenantDId = tenantD.id;
  await prisma.tenantDomain.create({ data: { tenantId: tenantDId, domain: 'checkout-d.ventia.localhost', isPrimary: true } });

  // Tenant E: concurrency — plenty of stock so two simultaneous 1-qty
  // checkouts never collide on stock, only on order-number allocation.
  const tenantE = await prisma.tenant.create({
    data: {
      slug: 'checkout-e',
      name: 'Checkout E',
      status: 'live',
      settings: {
        shipping: {
          methods: [{ id: 'flat-1', type: 'flat', label: 'Envío estándar', priceCents: 12000, enabled: true }],
        },
      },
    },
  });
  tenantEId = tenantE.id;
  await prisma.tenantDomain.create({ data: { tenantId: tenantEId, domain: 'checkout-e.ventia.localhost', isPrimary: true } });

  const concurrencyProduct = await prisma.product.create({
    data: { tenantId: tenantEId, name: 'Producto Concurrente', slug: 'producto-concurrente', priceCents: 15000, status: 'active', stock: 100 },
  });
  concurrencyProductId = concurrencyProduct.id;

  // Tenant F: a product archived (pulled off sale by the merchant) AFTER
  // being added to a shopper's cart, but before checkout — must reject, not
  // silently create a paid order for an unpublished product.
  const tenantF = await prisma.tenant.create({
    data: {
      slug: 'checkout-f',
      name: 'Checkout F',
      status: 'live',
      settings: {
        shipping: {
          methods: [{ id: 'flat-1', type: 'flat', label: 'Envío estándar', priceCents: 12000, enabled: true }],
        },
      },
    },
  });
  tenantFId = tenantF.id;
  await prisma.tenantDomain.create({ data: { tenantId: tenantFId, domain: 'checkout-f.ventia.localhost', isPrimary: true } });

  const archivableProduct = await prisma.product.create({
    data: { tenantId: tenantFId, name: 'Producto Archivable', slug: 'producto-archivable', priceCents: 18000, status: 'active', stock: 10 },
  });
  archivableProductId = archivableProduct.id;

  // Tenant G: `wompi` happy path — plenty of stock, Wompi credentials saved
  // below (once `paymentsService` exists).
  const tenantG = await prisma.tenant.create({
    data: {
      slug: 'checkout-g',
      name: 'Checkout G',
      status: 'live',
      settings: {
        shipping: {
          methods: [{ id: 'flat-1', type: 'flat', label: 'Envío estándar', priceCents: 12000, enabled: true }],
        },
      },
    },
  });
  tenantGId = tenantG.id;
  await prisma.tenantDomain.create({ data: { tenantId: tenantGId, domain: 'checkout-g.ventia.localhost', isPrimary: true } });
  const wompiHappyProduct = await prisma.product.create({
    data: { tenantId: tenantGId, name: 'Producto Wompi', slug: 'producto-wompi', priceCents: 35000, status: 'active', stock: 10 },
  });
  wompiHappyProductId = wompiHappyProduct.id;

  // Tenant H: `wompi` checkout, insufficient stock — same shape/setup as
  // tenant B's cod insufficient-stock fixture, but with Wompi credentials
  // saved so the request reaches CheckoutService's `wompi` branch at all.
  const tenantH = await prisma.tenant.create({
    data: {
      slug: 'checkout-h',
      name: 'Checkout H',
      status: 'live',
      settings: {
        shipping: {
          methods: [{ id: 'flat-1', type: 'flat', label: 'Envío estándar', priceCents: 12000, enabled: true }],
        },
      },
    },
  });
  tenantHId = tenantH.id;
  await prisma.tenantDomain.create({ data: { tenantId: tenantHId, domain: 'checkout-h.ventia.localhost', isPrimary: true } });
  const wompiStockShortProduct = await prisma.product.create({
    data: { tenantId: tenantHId, name: 'Pantalón Escaso Wompi', slug: 'pantalon-escaso-wompi', priceCents: 40000, status: 'active', stock: 1 },
  });
  wompiStockShortProductId = wompiStockShortProduct.id;

  // Tenant I: `wompi` checkout for a tenant that NEVER configured Wompi
  // credentials — deliberately no saveProviderCredentials call for this one.
  const tenantI = await prisma.tenant.create({
    data: {
      slug: 'checkout-i',
      name: 'Checkout I',
      status: 'live',
      settings: {
        shipping: {
          methods: [{ id: 'flat-1', type: 'flat', label: 'Envío estándar', priceCents: 12000, enabled: true }],
        },
      },
    },
  });
  tenantIId = tenantI.id;
  await prisma.tenantDomain.create({ data: { tenantId: tenantIId, domain: 'checkout-i.ventia.localhost', isPrimary: true } });
  const wompiUnconfiguredProduct = await prisma.product.create({
    data: { tenantId: tenantIId, name: 'Producto Sin Wompi', slug: 'producto-sin-wompi', priceCents: 22000, status: 'active', stock: 10 },
  });
  wompiUnconfiguredProductId = wompiUnconfiguredProduct.id;

  // Tenant J: two concurrent `wompi` checkouts racing for the SAME single
  // unit of stock — exercises adjustStockLine's atomic floor check actually
  // failing for one of the two (both pass the shared per-line
  // `stock < item.qty` check on their own tx's initial read, since neither
  // has committed yet; the loser's reservation UPDATE then re-evaluates
  // against the winner's already-committed decrement and fails), and
  // CheckoutService's STOCK_BELOW_ZERO -> INSUFFICIENT_STOCK remap.
  const tenantJ = await prisma.tenant.create({
    data: {
      slug: 'checkout-j',
      name: 'Checkout J',
      status: 'live',
      settings: {
        shipping: {
          methods: [{ id: 'flat-1', type: 'flat', label: 'Envío estándar', priceCents: 12000, enabled: true }],
        },
      },
    },
  });
  tenantJId = tenantJ.id;
  await prisma.tenantDomain.create({ data: { tenantId: tenantJId, domain: 'checkout-j.ventia.localhost', isPrimary: true } });
  const wompiRaceProduct = await prisma.product.create({
    data: { tenantId: tenantJId, name: 'Producto Race Wompi', slug: 'producto-race-wompi', priceCents: 10000, status: 'active', stock: 1 },
  });
  wompiRaceProductId = wompiRaceProduct.id;

  // Tenant K: `wompi` credentials saved with ONLY publicKey/privateKey — no
  // integritySecret/eventsSecret (both optional on wompiCredentialsSchema,
  // since a merchant technically can save partial credentials via the admin
  // UI). Reviewer-found gap: checkout used to only check `!wompiConfig`
  // here, not that these two fields were actually present, so a checkout
  // would commit a real Order + decrement real stock before later failing
  // post-commit in WompiProvider.createCheckoutSession (which needs
  // integritySecret to sign the redirect) with no way back for the shopper.
  const tenantK = await prisma.tenant.create({
    data: {
      slug: 'checkout-k',
      name: 'Checkout K',
      status: 'live',
      settings: {
        shipping: {
          methods: [{ id: 'flat-1', type: 'flat', label: 'Envío estándar', priceCents: 12000, enabled: true }],
        },
      },
    },
  });
  tenantKId = tenantK.id;
  await prisma.tenantDomain.create({ data: { tenantId: tenantKId, domain: 'checkout-k.ventia.localhost', isPrimary: true } });
  const wompiIncompleteCredsProduct = await prisma.product.create({
    data: { tenantId: tenantKId, name: 'Producto Wompi Incompleto', slug: 'producto-wompi-incompleto', priceCents: 18000, status: 'active', stock: 10 },
  });
  wompiIncompleteCredsProductId = wompiIncompleteCredsProduct.id;

  // Tenant L: `mercadopago` checkout — no adapter exists yet (P3b Task 1 ships
  // deliberately before Tasks 2-4 add one), and this tenant never saved
  // mercadopago credentials either. Exercises the widened validation layer
  // (`mercadopago` is now an accepted `paymentMethod`) + the generalized
  // credential check (`input.paymentMethod !== 'cod'`) end-to-end, proving
  // the whole generalized chain still cleanly 400s — never a raw 500 —
  // for a `PaymentProviderId` with zero adapter code behind it.
  const tenantL = await prisma.tenant.create({
    data: {
      slug: 'checkout-l',
      name: 'Checkout L',
      status: 'live',
      settings: {
        shipping: {
          methods: [{ id: 'flat-1', type: 'flat', label: 'Envío estándar', priceCents: 12000, enabled: true }],
        },
      },
    },
  });
  tenantLId = tenantL.id;
  await prisma.tenantDomain.create({ data: { tenantId: tenantLId, domain: 'checkout-l.ventia.localhost', isPrimary: true } });
  const mercadopagoUnconfiguredProduct = await prisma.product.create({
    data: { tenantId: tenantLId, name: 'Producto Sin Mercado Pago', slug: 'producto-sin-mercadopago', priceCents: 22000, status: 'active', stock: 10 },
  });
  mercadopagoUnconfiguredProductId = mercadopagoUnconfiguredProduct.id;

  // Tenant M: `mercadopago` checkout, credentials saved but missing
  // eventsSecret — a phase-7 review finding: checkout.service.ts's
  // credential-completeness guard was hardcoded to wompi only, so this
  // exact case (present-but-incomplete mercadopago config) would have
  // sailed past it, created a real Order, decremented real stock, and only
  // failed forever afterward at every real webhook delivery.
  const tenantM = await prisma.tenant.create({
    data: {
      slug: 'checkout-m',
      name: 'Checkout M',
      status: 'live',
      settings: {
        shipping: {
          methods: [{ id: 'flat-1', type: 'flat', label: 'Envío estándar', priceCents: 12000, enabled: true }],
        },
      },
    },
  });
  tenantMId = tenantM.id;
  await prisma.tenantDomain.create({ data: { tenantId: tenantMId, domain: 'checkout-m.ventia.localhost', isPrimary: true } });
  const mercadopagoIncompleteCredsProduct = await prisma.product.create({
    data: { tenantId: tenantMId, name: 'Producto Mercado Pago Incompleto', slug: 'producto-mercadopago-incompleto', priceCents: 19000, status: 'active', stock: 10 },
  });
  mercadopagoIncompleteCredsProductId = mercadopagoIncompleteCredsProduct.id;

  // Tenant N: `epayco` checkout, credentials saved but missing
  // epaycoCustomerId — same phase-7 review finding as tenant M, for
  // ePayco's own two-field completeness requirement (eventsSecret AND
  // epaycoCustomerId together).
  const tenantN = await prisma.tenant.create({
    data: {
      slug: 'checkout-n',
      name: 'Checkout N',
      status: 'live',
      settings: {
        shipping: {
          methods: [{ id: 'flat-1', type: 'flat', label: 'Envío estándar', priceCents: 12000, enabled: true }],
        },
      },
    },
  });
  tenantNId = tenantN.id;
  await prisma.tenantDomain.create({ data: { tenantId: tenantNId, domain: 'checkout-n.ventia.localhost', isPrimary: true } });
  const epaycoIncompleteCredsProduct = await prisma.product.create({
    data: { tenantId: tenantNId, name: 'Producto ePayco Incompleto', slug: 'producto-epayco-incompleto', priceCents: 21000, status: 'active', stock: 10 },
  });
  epaycoIncompleteCredsProductId = epaycoIncompleteCredsProduct.id;

  // Tenants O and P: two DIFFERENT live tenants, both with working `wompi`
  // credentials and enough stock, existing solely so one test can drive a real
  // checkout on each and prove the redirect URLs differ. P's domain is
  // deliberately a fully custom one.
  const tenantO = await prisma.tenant.create({
    data: {
      slug: 'checkout-o',
      name: 'Checkout O',
      status: 'live',
      settings: {
        shipping: {
          methods: [{ id: 'flat-1', type: 'flat', label: 'Envío estándar', priceCents: 12000, enabled: true }],
        },
      },
    },
  });
  tenantOId = tenantO.id;
  await prisma.tenantDomain.create({ data: { tenantId: tenantOId, domain: 'checkout-o.ventia.localhost', isPrimary: true } });
  const multiTenantOProduct = await prisma.product.create({
    data: { tenantId: tenantOId, name: 'Producto Multi O', slug: 'producto-multi-o', priceCents: 33000, status: 'active', stock: 10 },
  });
  multiTenantOProductId = multiTenantOProduct.id;

  const tenantP = await prisma.tenant.create({
    data: {
      slug: 'checkout-p',
      name: 'Checkout P',
      status: 'live',
      settings: {
        shipping: {
          methods: [{ id: 'flat-1', type: 'flat', label: 'Envío estándar', priceCents: 12000, enabled: true }],
        },
      },
    },
  });
  tenantPId = tenantP.id;
  await prisma.tenantDomain.create({ data: { tenantId: tenantPId, domain: 'tienda-p.example.com', isPrimary: true } });
  const multiTenantPProduct = await prisma.product.create({
    data: { tenantId: tenantPId, name: 'Producto Multi P', slug: 'producto-multi-p', priceCents: 33000, status: 'active', stock: 10 },
  });
  multiTenantPProductId = multiTenantPProduct.id;

  // Tenant Q: the Ley 1581 authorization tests. Ordinary flat shipping and a
  // deep stock, so nothing about the authorization assertions can be confused
  // with a stock or shipping failure. Starts with NO published
  // `policy_privacy` content — one test depends on that, and another publishes
  // some for itself.
  const tenantQ = await prisma.tenant.create({
    data: {
      slug: 'checkout-q',
      name: 'Checkout Q',
      status: 'live',
      settings: {
        shipping: {
          methods: [{ id: 'flat-1', type: 'flat', label: 'Envío estándar', priceCents: 12000, enabled: true }],
        },
      },
    },
  });
  tenantQId = tenantQ.id;
  await prisma.tenantDomain.create({ data: { tenantId: tenantQId, domain: 'checkout-q.ventia.localhost', isPrimary: true } });
  const consentProduct = await prisma.product.create({
    data: { tenantId: tenantQId, name: 'Producto Consentimiento', slug: 'producto-consentimiento', priceCents: 50000, status: 'active', stock: 50 },
  });
  consentProductId = consentProduct.id;

  const { createApp } = await import('../src/main');
  app = await createApp();
  await app.init();

  // Real PaymentsService instance (same app graph CheckoutService's own
  // constructor-injected instance comes from) — used here only to SEED
  // credentials via the real saveProviderCredentials/encryption path, same
  // convention as payments-service.test.ts/webhooks.test.ts.
  const { PaymentsService } = await import('../src/payments/payments.service');
  paymentsService = app.get(PaymentsService);
  await paymentsService.saveProviderCredentials(tenantGId, 'wompi', FAKE_WOMPI_CREDS);
  await paymentsService.saveProviderCredentials(tenantHId, 'wompi', FAKE_WOMPI_CREDS);
  await paymentsService.saveProviderCredentials(tenantJId, 'wompi', FAKE_WOMPI_CREDS);
  // Identical credentials for O and P on purpose: the ONLY difference between
  // the two checkouts in the two-tenant redirect test is which tenant/domain
  // they run on, so a shared-global-base regression cannot hide behind a
  // credential difference.
  await paymentsService.saveProviderCredentials(tenantOId, 'wompi', FAKE_WOMPI_CREDS);
  await paymentsService.saveProviderCredentials(tenantPId, 'wompi', FAKE_WOMPI_CREDS);
  // Tenant I deliberately gets NO saved credentials.
  await paymentsService.saveProviderCredentials(tenantKId, 'wompi', {
    publicKey: FAKE_WOMPI_CREDS.publicKey,
    privateKey: FAKE_WOMPI_CREDS.privateKey,
    sandbox: true,
    // integritySecret/eventsSecret deliberately omitted.
  });
  await paymentsService.saveProviderCredentials(tenantMId, 'mercadopago', {
    publicKey: 'APP_USR-fake-pub-key',
    privateKey: 'APP_USR-fake-priv-key',
    sandbox: true,
    // eventsSecret deliberately omitted.
  });
  await paymentsService.saveProviderCredentials(tenantNId, 'epayco', {
    publicKey: 'fake-epayco-pub-key',
    privateKey: 'fake-epayco-priv-key',
    eventsSecret: 'fake-P_KEY',
    sandbox: true,
    // epaycoCustomerId (P_CUST_ID_CLIENTE) deliberately omitted.
  });

  // RESEND_API_KEY is unset in this test environment, so MailerModule's
  // factory (see src/mailer/mailer.module.ts) wires MAILER to a ConsoleMailer
  // instance — spying on its `send` method captures every email
  // CheckoutService's fire-and-forget sendOrderEmails(...) call sends,
  // without standing up a second app/module just to swap providers. Same
  // recording-double-via-spy pattern as test/email-verification.test.ts.
  sentMail = [];
  const mailer = app.get<Mailer>(MAILER);
  vi.spyOn(mailer, 'send').mockImplementation(async (msg) => {
    sentMail.push(msg);
  });
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
  await db.stop();
});

describe('POST /v1/storefront/checkout — happy path', () => {
  it('creates an Order + 2 OrderItems + 1 OrderEvent, deletes the Cart, and computes totals correctly', async () => {
    const addX = await request(app.getHttpServer())
      .post('/v1/storefront/cart/items')
      .set('x-tenant-domain', 'checkout-a.ventia.localhost')
      .send({ productId: productXId, qty: 2 });
    expect(addX.status).toBe(201);
    const cookieValue = extractCartCookie(addX);

    const addY = await request(app.getHttpServer())
      .post('/v1/storefront/cart/items')
      .set('x-tenant-domain', 'checkout-a.ventia.localhost')
      .set('Cookie', `ventia_cart=${cookieValue}`)
      .send({ productId: productYId, qty: 1 });
    expect(addY.status).toBe(201);

    // Hand-computed expectation, independent of the service's own formula:
    // lineX: 45900 * 2 = 91800 subtotal; 19% tax portion = 91800 - round(91800/1.19) = 14657.
    // lineY: 20000 * 1 = 20000 subtotal; 19% tax portion = 20000 - round(20000/1.19) = 3193.
    const expectedSubtotal = 91800 + 20000;
    // The IVA CONTAINED IN that subtotal, not an addition to it — SPEC.md §5's
    // "prices include IVA". Recorded on the order for the DIAN-ready
    // breakdown, and deliberately absent from the total below.
    const expectedTax = 14657 + 3193;
    const expectedShipping = 12000; // flat-1
    const expectedTotal = expectedSubtotal + expectedShipping;
    expect(expectedSubtotal).toBe(111800);
    expect(expectedTax).toBe(17850);
    expect(expectedTotal).toBe(123800);

    const before = await prisma.order.count({ where: { tenantId: tenantAId } });
    expect(before).toBe(0);

    const res = await request(app.getHttpServer())
      .post('/v1/storefront/checkout')
      .set('x-tenant-domain', 'checkout-a.ventia.localhost')
      .set('Cookie', `ventia_cart=${cookieValue}`)
      .send({
        email: 'ana@example.com',
        phone: '3001234567',
        address: BOGOTA_ADDRESS,
        shippingMethodId: 'flat-1',
        paymentMethod: 'cod',
        acceptedPrivacyPolicy: true,
      });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ orderNumber: 1, totalCents: expectedTotal });

    const orders = await prisma.order.findMany({ where: { tenantId: tenantAId } });
    expect(orders).toHaveLength(1);
    const order = orders[0];
    expect(order.number).toBe(1);
    expect(order.status).toBe('PENDING');
    expect(order.paymentStatus).toBe('COD');
    expect(order.subtotalCents).toBe(expectedSubtotal);
    expect(order.taxCents).toBe(expectedTax);
    expect(order.shippingCents).toBe(expectedShipping);
    expect(order.totalCents).toBe(expectedTotal);
    expect(order.shippingMethod).toBe('flat-1');
    expect(order.email).toBe('ana@example.com');

    const items = await prisma.orderItem.findMany({ where: { orderId: order.id }, orderBy: { priceCentsSnapshot: 'desc' } });
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      productId: productXId,
      nameSnapshot: 'Camiseta',
      priceCentsSnapshot: 45900,
      qty: 2,
      taxRateSnapshot: 'NINETEEN',
    });
    expect(items[1]).toMatchObject({
      productId: productYId,
      nameSnapshot: 'Gorra',
      priceCentsSnapshot: 20000,
      qty: 1,
      taxRateSnapshot: 'NINETEEN',
    });

    const events = await prisma.orderEvent.findMany({ where: { orderId: order.id } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'created', actor: 'shopper' });

    const cartGone = await prisma.cart.findFirst({ where: { tenantId: tenantAId, cookieKey: cookieValue } });
    expect(cartGone).toBeNull();

    const customer = await prisma.customer.findFirst({ where: { tenantId: tenantAId, email: 'ana@example.com' } });
    expect(customer).not.toBeNull();
    expect(customer?.ordersCount).toBe(1);
    expect(customer?.totalSpentCents).toBe(expectedTotal);

    // Success response must clear the cart cookie.
    const setCookie = res.headers['set-cookie'] as unknown as string[] | undefined;
    expect(setCookie?.some((c) => c.startsWith('ventia_cart=;') || c.includes('ventia_cart=;'))).toBe(true);

    // Post-checkout order emails are fire-and-forget (CheckoutService never
    // awaits sendOrderEmails(...) — see checkout.service.ts's doc comment),
    // so the HTTP response above can (and does) land before the mailer spy
    // records anything; a short fixed wait gives that background call a
    // chance to run before asserting on it. Tenant A never configured
    // `settings.storeInfo.contactEmail`, so only the 2 shopper-facing emails
    // fire here (no merchant alert) — see order-emails.test.ts for the
    // 2-vs-3 branching itself.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const orderMail = sentMail.filter((m) => m.to === 'ana@example.com');
    expect(orderMail.length).toBeGreaterThanOrEqual(2);
    expect(orderMail.some((m) => m.subject.includes('VNT-1'))).toBe(true);
  });
});

describe('POST /v1/storefront/checkout — insufficient stock rejects the whole order', () => {
  it('400 INSUFFICIENT_STOCK, and creates zero Order rows (no partial commit); cart survives', async () => {
    const addOk = await request(app.getHttpServer())
      .post('/v1/storefront/cart/items')
      .set('x-tenant-domain', 'checkout-b.ventia.localhost')
      .send({ productId: stockOkProductId, qty: 1 });
    expect(addOk.status).toBe(201);
    const cookieValue = extractCartCookie(addOk);

    const addShort = await request(app.getHttpServer())
      .post('/v1/storefront/cart/items')
      .set('x-tenant-domain', 'checkout-b.ventia.localhost')
      .set('Cookie', `ventia_cart=${cookieValue}`)
      // stockShortProduct only has 1 in stock; asking for 5 must fail.
      .send({ productId: stockShortProductId, qty: 5 });
    expect(addShort.status).toBe(201);

    const res = await request(app.getHttpServer())
      .post('/v1/storefront/checkout')
      .set('x-tenant-domain', 'checkout-b.ventia.localhost')
      .set('Cookie', `ventia_cart=${cookieValue}`)
      .send({
        email: 'stockfail@example.com',
        phone: '3009876543',
        address: BOGOTA_ADDRESS,
        shippingMethodId: 'flat-1',
        paymentMethod: 'cod',
        acceptedPrivacyPolicy: true,
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INSUFFICIENT_STOCK');
    expect(res.body.details).toMatchObject({ productId: stockShortProductId, available: 1 });

    const orderCount = await prisma.order.count({ where: { tenantId: tenantBId } });
    expect(orderCount).toBe(0);

    // Cart must survive a failed checkout — checkout failure must not delete it.
    const cartStillThere = await prisma.cart.findFirst({ where: { tenantId: tenantBId, cookieKey: cookieValue } });
    expect(cartStillThere).not.toBeNull();
  });
});

describe('POST /v1/storefront/checkout — product archived after being added to cart', () => {
  it('400 INSUFFICIENT_STOCK and creates zero Order rows, even though stock is still nonzero', async () => {
    const cookieValue = await newCartWithItem('checkout-f.ventia.localhost', archivableProductId, 1);

    // Merchant pulls the product off sale between add-to-cart and checkout —
    // its stock count is untouched, only status changes.
    await prisma.product.update({ where: { id: archivableProductId }, data: { status: 'archived' } });

    const res = await request(app.getHttpServer())
      .post('/v1/storefront/checkout')
      .set('x-tenant-domain', 'checkout-f.ventia.localhost')
      .set('Cookie', `ventia_cart=${cookieValue}`)
      .send({
        email: 'archived@example.com',
        phone: '3001112233',
        address: BOGOTA_ADDRESS,
        shippingMethodId: 'flat-1',
        paymentMethod: 'cod',
        acceptedPrivacyPolicy: true,
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INSUFFICIENT_STOCK');
    expect(res.body.details).toMatchObject({ productId: archivableProductId, available: 0 });

    const orderCount = await prisma.order.count({ where: { tenantId: tenantFId } });
    expect(orderCount).toBe(0);
  });
});

describe('POST /v1/storefront/checkout — COD-restricted departamento', () => {
  it('400 SHIPPING_METHOD_UNAVAILABLE when the address departamento disallows COD', async () => {
    const add = await request(app.getHttpServer())
      .post('/v1/storefront/cart/items')
      .set('x-tenant-domain', 'checkout-c.ventia.localhost')
      .send({ productId: codProductId, qty: 1 });
    expect(add.status).toBe(201);
    const cookieValue = extractCartCookie(add);

    const res = await request(app.getHttpServer())
      .post('/v1/storefront/checkout')
      .set('x-tenant-domain', 'checkout-c.ventia.localhost')
      .set('Cookie', `ventia_cart=${cookieValue}`)
      .send({
        email: 'cod@example.com',
        phone: '3001112233',
        address: BOGOTA_ADDRESS, // departamentoCode '11', which tenant C restricts
        shippingMethodId: 'flat-1',
        paymentMethod: 'cod',
        acceptedPrivacyPolicy: true,
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('SHIPPING_METHOD_UNAVAILABLE');

    const orderCount = await prisma.order.count({ where: { tenantId: tenantCId } });
    expect(orderCount).toBe(0);
  });
});

describe('POST /v1/storefront/checkout — unconfigured shipping method id', () => {
  it('400 SHIPPING_METHOD_UNAVAILABLE for a shippingMethodId that does not match any configured method', async () => {
    const add = await request(app.getHttpServer())
      .post('/v1/storefront/cart/items')
      .set('x-tenant-domain', 'checkout-a.ventia.localhost')
      .send({ productId: productXId, qty: 1 });
    expect(add.status).toBe(201);
    const cookieValue = extractCartCookie(add);

    const ordersBefore = await prisma.order.count({ where: { tenantId: tenantAId } });

    const res = await request(app.getHttpServer())
      .post('/v1/storefront/checkout')
      .set('x-tenant-domain', 'checkout-a.ventia.localhost')
      .set('Cookie', `ventia_cart=${cookieValue}`)
      .send({
        email: 'noship@example.com',
        phone: '3005556677',
        address: BOGOTA_ADDRESS,
        shippingMethodId: 'does-not-exist',
        paymentMethod: 'cod',
        acceptedPrivacyPolicy: true,
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('SHIPPING_METHOD_UNAVAILABLE');

    const ordersAfter = await prisma.order.count({ where: { tenantId: tenantAId } });
    expect(ordersAfter).toBe(ordersBefore);
  });
});

describe('POST /v1/storefront/checkout — no cart cookie at all', () => {
  it('400 CART_EMPTY without ever calling the service (no cart to build one from)', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/storefront/checkout')
      .set('x-tenant-domain', 'checkout-d.ventia.localhost')
      .send({
        email: 'nocart@example.com',
        phone: '3002223344',
        address: BOGOTA_ADDRESS,
        shippingMethodId: 'flat-1',
        paymentMethod: 'cod',
        acceptedPrivacyPolicy: true,
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('CART_EMPTY');
  });
});

describe('POST /v1/storefront/checkout — concurrency (pg_advisory_xact_lock safety)', () => {
  it('two simultaneous checkouts for the same tenant get different, non-colliding order numbers', async () => {
    // Two INDEPENDENT cart sessions (two different cookies) for the same
    // tenant, each with one valid line.
    const cookie1 = await newCartWithItem('checkout-e.ventia.localhost', concurrencyProductId, 1);
    const cookie2 = await newCartWithItem('checkout-e.ventia.localhost', concurrencyProductId, 1);
    expect(cookie1).not.toBe(cookie2);

    const before = await prisma.order.count({ where: { tenantId: tenantEId } });
    expect(before).toBe(0);

    // Fired via Promise.all (NOT sequential awaits) so both requests are
    // genuinely in flight at once — this is what actually exercises
    // pg_advisory_xact_lock's serialization of the order-number allocation,
    // rather than merely proving two sequential calls don't collide.
    const [res1, res2] = await Promise.all([
      request(app.getHttpServer())
        .post('/v1/storefront/checkout')
        .set('x-tenant-domain', 'checkout-e.ventia.localhost')
        .set('Cookie', `ventia_cart=${cookie1}`)
        .send({
          email: 'concurrent1@example.com',
          phone: '3001110000',
          address: BOGOTA_ADDRESS,
          shippingMethodId: 'flat-1',
          paymentMethod: 'cod',
          acceptedPrivacyPolicy: true,
        }),
      request(app.getHttpServer())
        .post('/v1/storefront/checkout')
        .set('x-tenant-domain', 'checkout-e.ventia.localhost')
        .set('Cookie', `ventia_cart=${cookie2}`)
        .send({
          email: 'concurrent2@example.com',
          phone: '3002220000',
          address: BOGOTA_ADDRESS,
          shippingMethodId: 'flat-1',
          paymentMethod: 'cod',
          acceptedPrivacyPolicy: true,
        }),
    ]);

    expect(res1.status).toBe(201);
    expect(res2.status).toBe(201);
    expect(res1.body.orderNumber).not.toBe(res2.body.orderNumber);
    expect([res1.body.orderNumber, res2.body.orderNumber].sort()).toEqual([1, 2]);

    const orders = await prisma.order.findMany({ where: { tenantId: tenantEId } });
    expect(orders).toHaveLength(2);
    // (tenantId, number) unique constraint intact — two distinct rows,
    // distinct numbers, no P2002 would have shown up as a 500 above.
    expect(new Set(orders.map((o) => o.number)).size).toBe(2);
  });
});

describe('POST /v1/storefront/checkout — concurrent checkout of the SAME cart', () => {
  it('one succeeds (201), the other gets a clean 400 CART_EMPTY (not an uncaught 500); exactly one Order is created', async () => {
    // Same cookie for both requests this time (unlike the order-numbering
    // concurrency test above, which deliberately used two DIFFERENT carts) —
    // this exercises a different race entirely: two requests racing to
    // check out the SAME guest cart. The advisory lock only serializes
    // order-NUMBER allocation, not this whole method, so both requests can
    // get past every earlier check before either commits; the loser's own
    // `tx.cart.delete(...)` then targets a row the winner's transaction
    // already deleted, which Prisma reports as P2025 ("record to delete
    // does not exist") — this must surface as a clean CART_EMPTY, not an
    // uncaught 500, and must not leave a second, partial Order behind.
    const cookie = await newCartWithItem('checkout-e.ventia.localhost', concurrencyProductId, 1);

    const before = await prisma.order.count({ where: { tenantId: tenantEId } });

    const [res1, res2] = await Promise.all([
      request(app.getHttpServer())
        .post('/v1/storefront/checkout')
        .set('x-tenant-domain', 'checkout-e.ventia.localhost')
        .set('Cookie', `ventia_cart=${cookie}`)
        .send({
          email: 'samecart1@example.com',
          phone: '3003330000',
          address: BOGOTA_ADDRESS,
          shippingMethodId: 'flat-1',
          paymentMethod: 'cod',
          acceptedPrivacyPolicy: true,
        }),
      request(app.getHttpServer())
        .post('/v1/storefront/checkout')
        .set('x-tenant-domain', 'checkout-e.ventia.localhost')
        .set('Cookie', `ventia_cart=${cookie}`)
        .send({
          email: 'samecart2@example.com',
          phone: '3004440000',
          address: BOGOTA_ADDRESS,
          shippingMethodId: 'flat-1',
          paymentMethod: 'cod',
          acceptedPrivacyPolicy: true,
        }),
    ]);

    const statuses = [res1.status, res2.status].sort();
    expect(statuses).toEqual([201, 400]);
    const failed = res1.status === 400 ? res1 : res2;
    expect(failed.body.error).toBe('CART_EMPTY');

    const after = await prisma.order.count({ where: { tenantId: tenantEId } });
    expect(after).toBe(before + 1);
  });
});

describe('POST /v1/storefront/checkout — repeat customer', () => {
  it('a second checkout for the same email updates the existing Customer instead of creating a duplicate', async () => {
    const before = await prisma.customer.findFirst({ where: { tenantId: tenantAId, email: 'ana@example.com' } });
    expect(before).not.toBeNull();
    expect(before?.ordersCount).toBe(1);

    const add = await request(app.getHttpServer())
      .post('/v1/storefront/cart/items')
      .set('x-tenant-domain', 'checkout-a.ventia.localhost')
      .send({ productId: productYId, qty: 1 });
    expect(add.status).toBe(201);
    const cookieValue = extractCartCookie(add);

    const res = await request(app.getHttpServer())
      .post('/v1/storefront/checkout')
      .set('x-tenant-domain', 'checkout-a.ventia.localhost')
      .set('Cookie', `ventia_cart=${cookieValue}`)
      .send({
        email: 'ana@example.com', // same email as the happy-path test above
        phone: '3001234567',
        address: BOGOTA_ADDRESS,
        shippingMethodId: 'flat-1',
        paymentMethod: 'cod',
        acceptedPrivacyPolicy: true,
      });
    expect(res.status).toBe(201);

    const count = await prisma.customer.count({ where: { tenantId: tenantAId, email: 'ana@example.com' } });
    expect(count).toBe(1);

    const after = await prisma.customer.findFirst({ where: { tenantId: tenantAId, email: 'ana@example.com' } });
    expect(after?.ordersCount).toBe(2);
    expect(after?.totalSpentCents).toBe((before?.totalSpentCents ?? 0) + res.body.totalCents);
  });
});

describe('POST /v1/storefront/checkout — wompi happy path', () => {
  it('201 with a redirectUrl string; Order is PENDING/PENDING with paymentProvider wompi and stockReservedUntil ~15min out; stock IS decremented immediately', async () => {
    const cookieValue = await newCartWithItem('checkout-g.ventia.localhost', wompiHappyProductId, 2);

    const stockBefore = await prisma.product.findUniqueOrThrow({ where: { id: wompiHappyProductId } });
    expect(stockBefore.stock).toBe(10);

    const beforeCall = Date.now();
    const res = await request(app.getHttpServer())
      .post('/v1/storefront/checkout')
      .set('x-tenant-domain', 'checkout-g.ventia.localhost')
      .set('Cookie', `ventia_cart=${cookieValue}`)
      .send({
        email: 'wompi-happy@example.com',
        phone: '3009990001',
        address: BOGOTA_ADDRESS,
        shippingMethodId: 'flat-1',
        paymentMethod: 'wompi',
        acceptedPrivacyPolicy: true,
      });

    expect(res.status).toBe(201);
    expect(res.body.orderNumber).toBe(1);
    expect(typeof res.body.totalCents).toBe('number');
    // The one field a `cod` response never has — checkout.service.ts's
    // `wompi` branch calls WompiProvider.createCheckoutSession and returns
    // its redirectUrl for the storefront to redirect the browser to.
    expect(typeof res.body.redirectUrl).toBe('string');
    expect(res.body.redirectUrl).toContain('https://checkout.wompi.co/');

    const order = await prisma.order.findFirstOrThrow({ where: { tenantId: tenantGId, number: 1 } });
    expect(order.status).toBe('PENDING');
    expect(order.paymentStatus).toBe('PENDING');
    expect(order.paymentProvider).toBe('wompi');
    expect(order.stockReservedUntil).not.toBeNull();
    // ~15 minutes out — asserted as a reasonable range (14–16 minutes from
    // the moment the request was issued), not an exact millisecond match,
    // since real wall-clock time elapses between `beforeCall` and the
    // transaction's own `new Date(Date.now() + 15*60_000)` write.
    const reservedUntilMs = order.stockReservedUntil!.getTime();
    expect(reservedUntilMs).toBeGreaterThan(beforeCall + 14 * 60_000);
    expect(reservedUntilMs).toBeLessThan(beforeCall + 16 * 60_000);

    // THE one behavioral difference from every `cod` test in this file:
    // stock is decremented immediately at checkout time (design decision 2 —
    // "reserved" IS the decrement), not left untouched the way a `cod`
    // order's stock is (see the happy-path `cod` test above, which never
    // asserts a stock delta because there isn't one).
    const stockAfter = await prisma.product.findUniqueOrThrow({ where: { id: wompiHappyProductId } });
    expect(stockAfter.stock).toBe(stockBefore.stock - 2);

    const movement = await prisma.inventoryMovement.findFirst({
      where: { productId: wompiHappyProductId, orderId: order.id },
    });
    expect(movement).toMatchObject({ delta: -2, reason: 'order_reserved' });

    // Success response must still clear the cart cookie, same as `cod`.
    const setCookie = res.headers['set-cookie'] as unknown as string[] | undefined;
    expect(setCookie?.some((c) => c.includes('ventia_cart=;'))).toBe(true);

    // No order-creation email is sent for `wompi` at this stage (see
    // checkout.service.ts's doc comment on this deliberate decision) — the
    // shopper hasn't paid yet, and sendOrderEmails' own COD-specific wording
    // would be actively misleading here.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const wompiMail = sentMail.filter((m) => m.to === 'wompi-happy@example.com');
    expect(wompiMail).toHaveLength(0);
  });
});

// ==== THE multi-tenancy regression test, end to end through the real HTTP
// ==== stack: two tenants, two DIFFERENT payment redirect base URLs.
//
// Before this fix, the Wompi/ePayco adapters resolved their storefront base
// from ONE global env var (`PAYMENTS_STOREFRONT_BASE_URL`), so both checkouts
// below produced a `redirect-url` pointing at the SAME storefront. That is not
// merely a cosmetic UX bug: the Wompi return page `PATCH`es the API, so tenant
// P's shopper landing on tenant O's storefront had O's proxy stamp
// `x-tenant-domain: O`, writing P's transaction id onto O's same-numbered
// order — which O's reconciliation worker then looked up with O's own
// credentials. Cross-tenant writes, no attacker required.
//
// Deliberately ONE test asserting on BOTH tenants (rather than two tests each
// pinning one URL): a regression that reintroduces a single global base can
// still satisfy two independent single-tenant assertions, but cannot satisfy
// `expect(hostO).not.toBe(hostP)`.
describe('POST /v1/storefront/checkout — two tenants get two different payment redirect base URLs', () => {
  it('builds each tenant’s Wompi redirect-url on ITS OWN public domain, with its own scheme', async () => {
    const cookieO = await newCartWithItem('checkout-o.ventia.localhost', multiTenantOProductId, 1);
    const resO = await request(app.getHttpServer())
      .post('/v1/storefront/checkout')
      .set('x-tenant-domain', 'checkout-o.ventia.localhost')
      .set('Cookie', `ventia_cart=${cookieO}`)
      .send({
        email: 'multi-o@example.com',
        phone: '3009990010',
        address: BOGOTA_ADDRESS,
        shippingMethodId: 'flat-1',
        paymentMethod: 'wompi',
        acceptedPrivacyPolicy: true,
      });
    expect(resO.status).toBe(201);

    const cookieP = await newCartWithItem('tienda-p.example.com', multiTenantPProductId, 1);
    const resP = await request(app.getHttpServer())
      .post('/v1/storefront/checkout')
      .set('x-tenant-domain', 'tienda-p.example.com')
      .set('Cookie', `ventia_cart=${cookieP}`)
      .send({
        email: 'multi-p@example.com',
        phone: '3009990011',
        address: BOGOTA_ADDRESS,
        shippingMethodId: 'flat-1',
        paymentMethod: 'wompi',
        acceptedPrivacyPolicy: true,
      });
    expect(resP.status).toBe(201);

    // Both are Wompi hosted-checkout URLs carrying a `redirect-url` param.
    const redirectO = new URL(resO.body.redirectUrl as string).searchParams.get('redirect-url')!;
    const redirectP = new URL(resP.body.redirectUrl as string).searchParams.get('redirect-url')!;

    // Each order number is 1 (per-tenant numbering), so the PATHS are
    // identical — only the ORIGIN may differ. That makes this assertion pin
    // exactly the thing that was broken and nothing else.
    expect(redirectO).toBe('http://checkout-o.ventia.localhost/pago/wompi-retorno/1');
    expect(redirectP).toBe('https://tienda-p.example.com/pago/wompi-retorno/1');
    expect(redirectO).not.toBe(redirectP);
    expect(new URL(redirectO).host).not.toBe(new URL(redirectP).host);
    expect(new URL(redirectO).pathname).toBe(new URL(redirectP).pathname);

    // The http/https decision is a documented rule, not an accident:
    // `*.localhost` is a reserved, unregistrable special-use TLD and is this
    // repo's dev stack (Caddy serves it on port 80), so it gets `http`; any
    // real registered domain defaults to `https`. See
    // `src/tenants/tenant-public-url.ts`.
    expect(new URL(redirectO).protocol).toBe('http:');
    expect(new URL(redirectP).protocol).toBe('https:');

    // Neither tenant's redirect may reference the other's storefront anywhere
    // in the whole checkout URL, not just in the parsed param.
    expect(resO.body.redirectUrl).not.toContain('tienda-p.example.com');
    expect(resP.body.redirectUrl).not.toContain('checkout-o.ventia.localhost');

    // Sanity: both really did create their own orders, on their own tenants.
    const orderO = await prisma.order.findFirstOrThrow({ where: { tenantId: tenantOId, number: 1 } });
    const orderP = await prisma.order.findFirstOrThrow({ where: { tenantId: tenantPId, number: 1 } });
    expect(orderO.paymentProvider).toBe('wompi');
    expect(orderP.paymentProvider).toBe('wompi');
    expect(orderO.id).not.toBe(orderP.id);
  });
});

describe('POST /v1/storefront/checkout — wompi insufficient stock rejects the whole order', () => {
  it('400 INSUFFICIENT_STOCK with the EXACT SAME shape as the cod insufficient-stock test; zero side effects', async () => {
    const cookieValue = await newCartWithItem('checkout-h.ventia.localhost', wompiStockShortProductId, 5);

    const res = await request(app.getHttpServer())
      .post('/v1/storefront/checkout')
      .set('x-tenant-domain', 'checkout-h.ventia.localhost')
      .set('Cookie', `ventia_cart=${cookieValue}`)
      .send({
        email: 'wompi-stockfail@example.com',
        phone: '3009990002',
        address: BOGOTA_ADDRESS,
        shippingMethodId: 'flat-1',
        paymentMethod: 'wompi',
        acceptedPrivacyPolicy: true,
      });

    // Side-by-side with the cod insufficient-stock test above: same error
    // code, same `details` shape (`{productId, available}`), same 400 status.
    // This is the SHARED per-line stock check both branches run before ever
    // branching on paymentMethod — not the wompi-only STOCK_BELOW_ZERO remap
    // (see this file's wompi-race test below for that).
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INSUFFICIENT_STOCK');
    expect(res.body.details).toMatchObject({ productId: wompiStockShortProductId, available: 1 });

    const orderCount = await prisma.order.count({ where: { tenantId: tenantHId } });
    expect(orderCount).toBe(0);

    const product = await prisma.product.findUniqueOrThrow({ where: { id: wompiStockShortProductId } });
    expect(product.stock).toBe(1); // untouched — the whole transaction rolled back

    const cartStillThere = await prisma.cart.findFirst({ where: { tenantId: tenantHId, cookieKey: cookieValue } });
    expect(cartStillThere).not.toBeNull();
  });
});

describe('POST /v1/storefront/checkout — wompi checkout for a tenant with no Wompi credentials configured', () => {
  it('400 PAYMENT_PROVIDER_NOT_CONFIGURED, with ZERO DB side effects (no Order, no stock decrement) — the check runs before the transaction opens', async () => {
    const cookieValue = await newCartWithItem('checkout-i.ventia.localhost', wompiUnconfiguredProductId, 1);

    const stockBefore = await prisma.product.findUniqueOrThrow({ where: { id: wompiUnconfiguredProductId } });

    const res = await request(app.getHttpServer())
      .post('/v1/storefront/checkout')
      .set('x-tenant-domain', 'checkout-i.ventia.localhost')
      .set('Cookie', `ventia_cart=${cookieValue}`)
      .send({
        email: 'wompi-unconfigured@example.com',
        phone: '3009990003',
        address: BOGOTA_ADDRESS,
        shippingMethodId: 'flat-1',
        paymentMethod: 'wompi',
        acceptedPrivacyPolicy: true,
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('PAYMENT_PROVIDER_NOT_CONFIGURED');

    // No Order, no OrderItem, no stock touched — this config check happens
    // BEFORE checkout.service.ts even opens its platformDb.$transaction, so
    // there is genuinely nothing to roll back, not merely "the transaction
    // rolled back".
    const orderCount = await prisma.order.count({ where: { tenantId: tenantIId } });
    expect(orderCount).toBe(0);

    const stockAfter = await prisma.product.findUniqueOrThrow({ where: { id: wompiUnconfiguredProductId } });
    expect(stockAfter.stock).toBe(stockBefore.stock);

    // The cart must also survive, exactly like any other pre-transaction
    // rejection in this file (e.g. the "no cart cookie" test).
    const cartStillThere = await prisma.cart.findFirst({ where: { tenantId: tenantIId, cookieKey: cookieValue } });
    expect(cartStillThere).not.toBeNull();
  });
});

describe('POST /v1/storefront/checkout — wompi credentials saved but missing integritySecret/eventsSecret', () => {
  it('400 PAYMENT_PROVIDER_NOT_CONFIGURED, with ZERO DB side effects — reviewer-found gap: a present-but-incomplete config must fail BEFORE the transaction, same as a wholly-absent one', async () => {
    const cookieValue = await newCartWithItem('checkout-k.ventia.localhost', wompiIncompleteCredsProductId, 1);

    const stockBefore = await prisma.product.findUniqueOrThrow({ where: { id: wompiIncompleteCredsProductId } });

    const res = await request(app.getHttpServer())
      .post('/v1/storefront/checkout')
      .set('x-tenant-domain', 'checkout-k.ventia.localhost')
      .set('Cookie', `ventia_cart=${cookieValue}`)
      .send({
        email: 'wompi-incomplete@example.com',
        phone: '3009990004',
        address: BOGOTA_ADDRESS,
        shippingMethodId: 'flat-1',
        paymentMethod: 'wompi',
        acceptedPrivacyPolicy: true,
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('PAYMENT_PROVIDER_NOT_CONFIGURED');

    // Before this fix, this check only looked at `!wompiConfig` — a present
    // config missing integritySecret/eventsSecret would sail past it, open
    // the transaction, create a real Order, and decrement real stock, only
    // to fail later in WompiProvider.createCheckoutSession (post-commit,
    // with no way to undo it from the shopper's side). Asserting zero
    // side effects here is the actual regression test for that gap.
    const orderCount = await prisma.order.count({ where: { tenantId: tenantKId } });
    expect(orderCount).toBe(0);

    const stockAfter = await prisma.product.findUniqueOrThrow({ where: { id: wompiIncompleteCredsProductId } });
    expect(stockAfter.stock).toBe(stockBefore.stock);

    const cartStillThere = await prisma.cart.findFirst({ where: { tenantId: tenantKId, cookieKey: cookieValue } });
    expect(cartStillThere).not.toBeNull();
  });
});

describe('POST /v1/storefront/checkout — mercadopago credentials saved but missing eventsSecret', () => {
  it('400 PAYMENT_PROVIDER_NOT_CONFIGURED, with ZERO DB side effects — phase-7 review gap: the completeness guard was hardcoded to wompi only', async () => {
    const cookieValue = await newCartWithItem('checkout-m.ventia.localhost', mercadopagoIncompleteCredsProductId, 1);

    const stockBefore = await prisma.product.findUniqueOrThrow({ where: { id: mercadopagoIncompleteCredsProductId } });

    const res = await request(app.getHttpServer())
      .post('/v1/storefront/checkout')
      .set('x-tenant-domain', 'checkout-m.ventia.localhost')
      .set('Cookie', `ventia_cart=${cookieValue}`)
      .send({
        email: 'mercadopago-incomplete@example.com',
        phone: '3009990005',
        address: BOGOTA_ADDRESS,
        shippingMethodId: 'flat-1',
        paymentMethod: 'mercadopago',
        acceptedPrivacyPolicy: true,
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('PAYMENT_PROVIDER_NOT_CONFIGURED');

    // Before this fix, a present-but-incomplete mercadopago config would
    // sail past the check (hardcoded to `=== 'wompi'`), open the
    // transaction, create a real Order, and decrement real stock, only to
    // fail FOREVER at every real webhook delivery afterward (no way back).
    const orderCount = await prisma.order.count({ where: { tenantId: tenantMId } });
    expect(orderCount).toBe(0);

    const stockAfter = await prisma.product.findUniqueOrThrow({ where: { id: mercadopagoIncompleteCredsProductId } });
    expect(stockAfter.stock).toBe(stockBefore.stock);

    const cartStillThere = await prisma.cart.findFirst({ where: { tenantId: tenantMId, cookieKey: cookieValue } });
    expect(cartStillThere).not.toBeNull();
  });
});

describe('POST /v1/storefront/checkout — epayco credentials saved but missing epaycoCustomerId', () => {
  it('400 PAYMENT_PROVIDER_NOT_CONFIGURED, with ZERO DB side effects — same phase-7 review gap, for ePayco\'s own two-field requirement', async () => {
    const cookieValue = await newCartWithItem('checkout-n.ventia.localhost', epaycoIncompleteCredsProductId, 1);

    const stockBefore = await prisma.product.findUniqueOrThrow({ where: { id: epaycoIncompleteCredsProductId } });

    const res = await request(app.getHttpServer())
      .post('/v1/storefront/checkout')
      .set('x-tenant-domain', 'checkout-n.ventia.localhost')
      .set('Cookie', `ventia_cart=${cookieValue}`)
      .send({
        email: 'epayco-incomplete@example.com',
        phone: '3009990006',
        address: BOGOTA_ADDRESS,
        shippingMethodId: 'flat-1',
        paymentMethod: 'epayco',
        acceptedPrivacyPolicy: true,
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('PAYMENT_PROVIDER_NOT_CONFIGURED');

    const orderCount = await prisma.order.count({ where: { tenantId: tenantNId } });
    expect(orderCount).toBe(0);

    const stockAfter = await prisma.product.findUniqueOrThrow({ where: { id: epaycoIncompleteCredsProductId } });
    expect(stockAfter.stock).toBe(stockBefore.stock);

    const cartStillThere = await prisma.cart.findFirst({ where: { tenantId: tenantNId, cookieKey: cookieValue } });
    expect(cartStillThere).not.toBeNull();
  });
});

describe('POST /v1/storefront/checkout — invalid paymentMethod', () => {
  it("400 VALIDATION_FAILED for a paymentMethod that is neither 'cod' nor 'wompi'", async () => {
    const cookieValue = await newCartWithItem('checkout-a.ventia.localhost', productXId, 1);

    const res = await request(app.getHttpServer())
      .post('/v1/storefront/checkout')
      .set('x-tenant-domain', 'checkout-a.ventia.localhost')
      .set('Cookie', `ventia_cart=${cookieValue}`)
      .send({
        email: 'badmethod@example.com',
        phone: '3009990004',
        address: BOGOTA_ADDRESS,
        shippingMethodId: 'flat-1',
        paymentMethod: 'paypal',
        acceptedPrivacyPolicy: true,
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_FAILED');
    expect(res.body.details).toHaveProperty('paymentMethod');

    const orderCount = await prisma.order.count({ where: { tenantId: tenantAId } });
    // No new order for tenant A beyond whatever earlier tests in this file
    // already created — this request never reaches CheckoutService at all
    // (parseCheckoutBody throws before that).
    const cartStillThere = await prisma.cart.findFirst({ where: { tenantId: tenantAId, cookieKey: cookieValue } });
    expect(cartStillThere).not.toBeNull();
    expect(orderCount).toBeGreaterThanOrEqual(0);
  });
});

describe('POST /v1/storefront/checkout — wompi concurrent reservation race (adjustStockLine STOCK_BELOW_ZERO -> INSUFFICIENT_STOCK remap)', () => {
  it('one wompi checkout succeeds (201, stock -> 0), the other gets a clean 400 INSUFFICIENT_STOCK (not a raw STOCK_BELOW_ZERO/500)', async () => {
    // Both carts pass the SHARED per-line stock check (each transaction's own
    // read sees stock=1, qty=1, 1 >= 1) since neither has committed yet —
    // this specifically exercises adjustStockLine's OWN atomic floor check
    // (the one keyed on the row's actually-committed value at UPDATE time),
    // not the earlier shared snapshot check the wompi-insufficient-stock test
    // above exercises.
    const cookie1 = await newCartWithItem('checkout-j.ventia.localhost', wompiRaceProductId, 1);
    const cookie2 = await newCartWithItem('checkout-j.ventia.localhost', wompiRaceProductId, 1);
    expect(cookie1).not.toBe(cookie2);

    const [res1, res2] = await Promise.all([
      request(app.getHttpServer())
        .post('/v1/storefront/checkout')
        .set('x-tenant-domain', 'checkout-j.ventia.localhost')
        .set('Cookie', `ventia_cart=${cookie1}`)
        .send({
          email: 'wompi-race1@example.com',
          phone: '3009990005',
          address: BOGOTA_ADDRESS,
          shippingMethodId: 'flat-1',
          paymentMethod: 'wompi',
          acceptedPrivacyPolicy: true,
        }),
      request(app.getHttpServer())
        .post('/v1/storefront/checkout')
        .set('x-tenant-domain', 'checkout-j.ventia.localhost')
        .set('Cookie', `ventia_cart=${cookie2}`)
        .send({
          email: 'wompi-race2@example.com',
          phone: '3009990006',
          address: BOGOTA_ADDRESS,
          shippingMethodId: 'flat-1',
          paymentMethod: 'wompi',
          acceptedPrivacyPolicy: true,
        }),
    ]);

    const statuses = [res1.status, res2.status].sort();
    expect(statuses).toEqual([201, 400]);

    const failed = res1.status === 400 ? res1 : res2;
    // The critical assertion: the shopper-facing error is the SAME
    // INSUFFICIENT_STOCK shape as every other stock rejection in this file —
    // never the internal STOCK_BELOW_ZERO code adjustStockLine itself throws.
    expect(failed.body.error).toBe('INSUFFICIENT_STOCK');
    expect(failed.body.details).toMatchObject({ productId: wompiRaceProductId, available: 0 });

    const orderCount = await prisma.order.count({ where: { tenantId: tenantJId } });
    expect(orderCount).toBe(1);

    const product = await prisma.product.findUniqueOrThrow({ where: { id: wompiRaceProductId } });
    expect(product.stock).toBe(0); // decremented exactly once, by the winner only
  });
});

describe('POST /v1/storefront/checkout — mercadopago checkout, no adapter/credentials configured yet (P3b Task 1)', () => {
  it("400 PAYMENT_PROVIDER_NOT_CONFIGURED for paymentMethod 'mercadopago', with ZERO DB side effects — the widened validation layer + generalized credential check reject this cleanly even though no mercadopago adapter exists yet", async () => {
    const cookieValue = await newCartWithItem('checkout-l.ventia.localhost', mercadopagoUnconfiguredProductId, 1);

    const stockBefore = await prisma.product.findUniqueOrThrow({ where: { id: mercadopagoUnconfiguredProductId } });

    const res = await request(app.getHttpServer())
      .post('/v1/storefront/checkout')
      .set('x-tenant-domain', 'checkout-l.ventia.localhost')
      .set('Cookie', `ventia_cart=${cookieValue}`)
      .send({
        email: 'mercadopago-unconfigured@example.com',
        phone: '3009990007',
        address: BOGOTA_ADDRESS,
        shippingMethodId: 'flat-1',
        paymentMethod: 'mercadopago',
        acceptedPrivacyPolicy: true,
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('PAYMENT_PROVIDER_NOT_CONFIGURED');

    // Same "zero side effects" shape as the wompi-unconfigured test above —
    // this check runs before checkout.service.ts ever opens its transaction.
    const orderCount = await prisma.order.count({ where: { tenantId: tenantLId } });
    expect(orderCount).toBe(0);

    const stockAfter = await prisma.product.findUniqueOrThrow({ where: { id: mercadopagoUnconfiguredProductId } });
    expect(stockAfter.stock).toBe(stockBefore.stock);

    const cartStillThere = await prisma.cart.findFirst({ where: { tenantId: tenantLId, cookieKey: cookieValue } });
    expect(cartStillThere).not.toBeNull();
  });
});

/**
 * Attribution (SPEC.md §7): an order placed from a cart the AI agent built
 * must be identifiable as AI-assisted. Every "ventas asistidas por IA" number
 * the merchant is shown reads `Order.source`, so if it is hardcoded the KPI
 * is silently, permanently zero — the kind of bug that looks like "the agent
 * isn't selling anything" rather than like a bug.
 */
describe('POST /v1/storefront/checkout — order source is inherited from the cart', () => {
  it('marks an order from an agent-built cart as source=agent', async () => {
    // Shaped exactly like what `create_cart_link` writes: a fresh cart with
    // its own key and `source: 'agent'`.
    const cart = await prisma.cart.create({
      data: { tenantId: tenantAId, cookieKey: crypto.randomUUID(), source: 'agent' },
    });
    await prisma.cartItem.create({ data: { tenantId: tenantAId, cartId: cart.id, productId: productXId, qty: 1 } });

    const res = await request(app.getHttpServer())
      .post('/v1/storefront/checkout')
      .set('x-tenant-domain', 'checkout-a.ventia.localhost')
      .set('Cookie', `ventia_cart=${cart.cookieKey}`)
      .send({
        email: 'agent-attributed@example.com',
        phone: '3009990077',
        address: BOGOTA_ADDRESS,
        shippingMethodId: 'flat-1',
        paymentMethod: 'cod',
        acceptedPrivacyPolicy: true,
      });

    expect(res.status).toBe(201);
    const order = await prisma.order.findFirstOrThrow({
      where: { tenantId: tenantAId, email: 'agent-attributed@example.com' },
    });
    expect(order.source).toBe('agent');
  });

  it('still marks an ordinary shopper cart as source=web', async () => {
    const cookieValue = await newCartWithItem('checkout-a.ventia.localhost', productXId, 1);

    const res = await request(app.getHttpServer())
      .post('/v1/storefront/checkout')
      .set('x-tenant-domain', 'checkout-a.ventia.localhost')
      .set('Cookie', `ventia_cart=${cookieValue}`)
      .send({
        email: 'web-attributed@example.com',
        phone: '3009990078',
        address: BOGOTA_ADDRESS,
        shippingMethodId: 'flat-1',
        paymentMethod: 'cod',
        acceptedPrivacyPolicy: true,
      });

    expect(res.status).toBe(201);
    const order = await prisma.order.findFirstOrThrow({
      where: { tenantId: tenantAId, email: 'web-attributed@example.com' },
    });
    expect(order.source).toBe('web');
  });
});

/**
 * SPEC.md §5's totals rule, pinned on its own rather than left implicit in the
 * happy path's expected numbers.
 *
 * > Totals: Colombian retail convention — **prices include IVA**. Order stores
 * > the tax breakdown per line derived from each product's tax rate
 * > (`price_cents - price_cents / (1 + rate)` for the tax portion).
 *
 * The code read `subtotal + tax + shipping` for the whole of P2b/P2c/P3,
 * charging every shopper the IVA contained in their own basket a second time.
 * A happy-path test whose expected total is computed the same wrong way cannot
 * catch that, which is why this states the RULE and derives nothing.
 */
describe('POST /v1/storefront/checkout — prices include IVA (SPEC §5)', () => {
  it('charges the sticker price plus shipping, and nothing else', async () => {
    const cookieValue = await newCartWithItem('checkout-a.ventia.localhost', productXId, 1);

    const res = await request(app.getHttpServer())
      .post('/v1/storefront/checkout')
      .set('x-tenant-domain', 'checkout-a.ventia.localhost')
      .set('Cookie', `ventia_cart=${cookieValue}`)
      .send({
        email: 'iva-inclusive@example.com',
        phone: '3009990099',
        address: BOGOTA_ADDRESS,
        shippingMethodId: 'flat-1',
        paymentMethod: 'cod',
        acceptedPrivacyPolicy: true,
      });

    expect(res.status).toBe(201);
    const order = await prisma.order.findFirstOrThrow({
      where: { tenantId: tenantAId, email: 'iva-inclusive@example.com' },
    });

    // productX is 45.900 at 19% IVA; flat-1 ships for 12.000. The shopper was
    // quoted 45.900 on the product page, so that is what the product costs.
    expect(order.subtotalCents).toBe(45_900);
    expect(order.shippingCents).toBe(12_000);
    expect(order.totalCents).toBe(57_900);
  });

  it('records the IVA CONTAINED IN the price, for the DIAN breakdown', async () => {
    const order = await prisma.order.findFirstOrThrow({
      where: { tenantId: tenantAId, email: 'iva-inclusive@example.com' },
    });

    // 45.900 - round(45.900 / 1.19) = 7.329. Strictly less than the subtotal,
    // which is the arithmetic signature of an INCLUDED tax: an added 19% would
    // be 8.721 and would push the total to 66.621.
    expect(order.taxCents).toBe(45_900 - Math.round(45_900 / 1.19));
    expect(order.taxCents).toBeLessThan(order.subtotalCents);
    expect(order.totalCents).toBe(order.subtotalCents + order.shippingCents);
  });

  it('is unaffected by a zero-rated or excluded product', async () => {
    // `excluido` and `0` products have no IVA portion at all; the total is
    // still price + shipping, so the rule holds without a special case.
    const zeroRated = await prisma.product.create({
      data: {
        tenantId: tenantAId,
        name: 'Libro Excluido',
        slug: `libro-excluido-${Date.now()}`,
        priceCents: 30_000,
        status: 'active',
        stock: 5,
        taxRate: 'EXCLUIDO',
      },
    });
    const cookieValue = await newCartWithItem('checkout-a.ventia.localhost', zeroRated.id, 1);

    await request(app.getHttpServer())
      .post('/v1/storefront/checkout')
      .set('x-tenant-domain', 'checkout-a.ventia.localhost')
      .set('Cookie', `ventia_cart=${cookieValue}`)
      .send({
        email: 'iva-excluido@example.com',
        phone: '3009990098',
        address: BOGOTA_ADDRESS,
        shippingMethodId: 'flat-1',
        paymentMethod: 'cod',
        acceptedPrivacyPolicy: true,
      });

    const order = await prisma.order.findFirstOrThrow({
      where: { tenantId: tenantAId, email: 'iva-excluido@example.com' },
    });
    expect(order.taxCents).toBe(0);
    expect(order.totalCents).toBe(30_000 + 12_000);
  });
});

/**
 * Ley 1581 de 2012 (Habeas Data), SPEC.md §9.
 *
 * Two obligations are being tested, and they are not the same obligation:
 *
 *  - art. 9 — the authorization must be PRIOR, EXPRESS and INFORMED. Colombian
 *    law has no GDPR-style "necessary for the performance of a contract"
 *    basis; art. 10's exceptions are public-register data, public-entity
 *    requests, medical emergencies and historical/statistical/scientific
 *    processing. So a checkout without an authorization is not a lawful
 *    collection on a weaker basis, it is an unlawful one — and the API, not
 *    only the storefront's checkbox, has to refuse it.
 *  - art. 8 lit. e) — the Titular may demand *prueba de la autorización*, and
 *    Decreto 1377 art. 12 makes keeping that proof the Responsable's duty. An
 *    authorization obtained and not recorded is, in front of the SIC, an
 *    authorization not obtained.
 */
describe('POST /v1/storefront/checkout — Ley 1581 authorization (SPEC §9)', () => {
  const CONSENT_ADDRESS = { ...BOGOTA_ADDRESS };

  function consentCheckout(cookieValue: string, body: Record<string, unknown>) {
    return request(app.getHttpServer())
      .post('/v1/storefront/checkout')
      .set('x-tenant-domain', 'checkout-q.ventia.localhost')
      .set('Cookie', `ventia_cart=${cookieValue}`)
      .send(body);
  }

  it('400 VALIDATION_FAILED without an authorization, with ZERO side effects — no Order, no Customer, and the cart survives', async () => {
    const cookieValue = await newCartWithItem('checkout-q.ventia.localhost', consentProductId, 1);
    const ordersBefore = await prisma.order.count({ where: { tenantId: tenantQId } });

    const res = await consentCheckout(cookieValue, {
      email: 'sin-autorizacion@example.com',
      phone: '3009990101',
      address: CONSENT_ADDRESS,
      shippingMethodId: 'flat-1',
      paymentMethod: 'cod',
      // acceptedPrivacyPolicy deliberately absent — a client that never asked.
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_FAILED');
    expect(res.body.details.acceptedPrivacyPolicy).toBeTruthy();

    // The whole point: the shopper's name, e-mail, phone and address were in
    // that request body and NONE of it may be stored, because there was no
    // lawful basis to store it. Not "stored and flagged" — not stored.
    expect(await prisma.order.count({ where: { tenantId: tenantQId } })).toBe(ordersBefore);
    expect(
      await prisma.customer.count({ where: { tenantId: tenantQId, email: 'sin-autorizacion@example.com' } }),
    ).toBe(0);
    // And the shopper does not lose their cart over it — this is a fixable
    // mistake, not a dead end.
    const cart = await prisma.cart.findFirst({ where: { tenantId: tenantQId, cookieKey: cookieValue } });
    expect(cart).not.toBeNull();
  });

  it('400s an explicit false, and every truthy near-miss — only a real boolean true is an authorization', async () => {
    // `"false"`, `1` and `[]` are all truthy in JavaScript. A shopper's
    // authorization is not a field where a caller's sloppy encoding gets read
    // in their favour, so the check is `=== true`.
    for (const value of [false, 'true', 'false', 1, 0, [], {}, null] as unknown[]) {
      const cookieValue = await newCartWithItem('checkout-q.ventia.localhost', consentProductId, 1);
      const res = await consentCheckout(cookieValue, {
        email: `casi-${String(typeof value)}-${Math.random().toString(36).slice(2, 8)}@example.com`,
        phone: '3009990102',
        address: CONSENT_ADDRESS,
        shippingMethodId: 'flat-1',
        paymentMethod: 'cod',
        acceptedPrivacyPolicy: value,
      });
      expect(res.status).toBe(400);
      expect(res.body.details.acceptedPrivacyPolicy).toBeTruthy();
    }
  });

  it('records the prueba de la autorización on the order: WHEN it was given, at the SERVER clock, and against WHICH policy', async () => {
    const cookieValue = await newCartWithItem('checkout-q.ventia.localhost', consentProductId, 1);

    // A client trying to dictate its own evidence. Both values must be
    // ignored: the party whose authorization is being evidenced cannot also
    // be the source of the evidence.
    const before = new Date();
    const res = await consentCheckout(cookieValue, {
      email: 'con-autorizacion@example.com',
      phone: '3009990103',
      address: CONSENT_ADDRESS,
      shippingMethodId: 'flat-1',
      paymentMethod: 'cod',
      acceptedPrivacyPolicy: true,
      privacyAcceptedAt: '1999-01-01T00:00:00.000Z',
      privacyPolicyVersion: 'sha256:deadbeefdeadbeef',
    });
    const after = new Date();
    expect(res.status).toBe(201);

    const order = await prisma.order.findFirstOrThrow({
      where: { tenantId: tenantQId, email: 'con-autorizacion@example.com' },
    });

    expect(order.privacyAcceptedAt).not.toBeNull();
    const acceptedAt = order.privacyAcceptedAt as Date;
    expect(acceptedAt.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
    expect(acceptedAt.getTime()).toBeLessThanOrEqual(after.getTime() + 1000);
    expect(acceptedAt.getTime()).not.toBe(new Date('1999-01-01T00:00:00.000Z').getTime());
    expect(order.privacyPolicyVersion).not.toBe('sha256:deadbeefdeadbeef');

    // Tenant Q has published no política de tratamiento, and the recorded
    // version says exactly that rather than a plausible-looking hash. A
    // merchant auditing their orders has to be able to SEE which of their
    // sales were authorized against nothing they wrote.
    expect(order.privacyPolicyVersion).toBe(NO_PUBLISHED_POLICY_VERSION);
  });

  it('fingerprints the policy actually published at that moment, and a new fingerprint once the merchant edits it', async () => {
    const policy = {
      title: 'Política de tratamiento de datos personales',
      bodyMd: 'En Checkout Q tratamos sus datos personales con responsabilidad.',
    };
    await prisma.tenantContent.create({
      data: { tenantId: tenantQId, type: 'policy_privacy', ...policy },
    });

    const firstCookie = await newCartWithItem('checkout-q.ventia.localhost', consentProductId, 1);
    expect(
      (
        await consentCheckout(firstCookie, {
          email: 'politica-v1@example.com',
          phone: '3009990104',
          address: CONSENT_ADDRESS,
          shippingMethodId: 'flat-1',
          paymentMethod: 'cod',
          acceptedPrivacyPolicy: true,
        })
      ).status,
    ).toBe(201);

    const first = await prisma.order.findFirstOrThrow({
      where: { tenantId: tenantQId, email: 'politica-v1@example.com' },
    });
    // Reproducible from the text itself — which is the whole value of a
    // fingerprint: hand it a candidate policy and it tells you whether that
    // is the one the shopper was pointed at.
    expect(first.privacyPolicyVersion).toBe(privacyPolicyVersionFor(policy));
    expect(first.privacyPolicyVersion).toMatch(/^sha256:[0-9a-f]{16}$/);

    // The merchant rewrites their policy. Orders placed afterwards must not
    // silently claim to have been authorized against the old text, and orders
    // placed before must not be retconned into the new one.
    const revised = { ...policy, bodyMd: `${policy.bodyMd} Actualizada en agosto.` };
    await prisma.tenantContent.update({
      where: { tenantId_type: { tenantId: tenantQId, type: 'policy_privacy' } },
      data: revised,
    });

    const secondCookie = await newCartWithItem('checkout-q.ventia.localhost', consentProductId, 1);
    await consentCheckout(secondCookie, {
      email: 'politica-v2@example.com',
      phone: '3009990105',
      address: CONSENT_ADDRESS,
      shippingMethodId: 'flat-1',
      paymentMethod: 'cod',
      acceptedPrivacyPolicy: true,
    });

    const second = await prisma.order.findFirstOrThrow({
      where: { tenantId: tenantQId, email: 'politica-v2@example.com' },
    });
    expect(second.privacyPolicyVersion).toBe(privacyPolicyVersionFor(revised));
    expect(second.privacyPolicyVersion).not.toBe(first.privacyPolicyVersion);

    const firstAgain = await prisma.order.findUniqueOrThrow({ where: { id: first.id } });
    expect(firstAgain.privacyPolicyVersion).toBe(first.privacyPolicyVersion);
  });

  it('holds no personal data: the recorded evidence is identical for two different shoppers', async () => {
    // Why this matters: it is what makes the Ley 1581 anonymizer's decision to
    // LEAVE these two columns alone correct (see
    // test/privacy-anonymize.test.ts). If the fingerprint were per-shopper it
    // would be a pseudonymous identifier and would have to be erased on a
    // supresión request, taking the proof of authorization with it.
    const shoppers = ['sin-pii-uno@example.com', 'sin-pii-dos@example.com'];
    for (const email of shoppers) {
      const cookieValue = await newCartWithItem('checkout-q.ventia.localhost', consentProductId, 1);
      await consentCheckout(cookieValue, {
        email,
        phone: '3009990106',
        address: { ...CONSENT_ADDRESS, nombreCompleto: `Titular ${email}` },
        shippingMethodId: 'flat-1',
        paymentMethod: 'cod',
        acceptedPrivacyPolicy: true,
      });
    }

    const [a, b] = await Promise.all(
      shoppers.map((email) =>
        prisma.order.findFirstOrThrow({ where: { tenantId: tenantQId, email } }),
      ),
    );
    expect(a.privacyPolicyVersion).toBe(b.privacyPolicyVersion);
    for (const order of [a, b]) {
      const version = order.privacyPolicyVersion as string;
      expect(version).not.toContain('@');
      expect(version).not.toContain('3009990106');
    }
  });
});
