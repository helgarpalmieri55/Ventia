import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import Redis from 'ioredis';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient as PrismaClientType } from '@ventia/db';
import { startTestDb } from './helpers';

const CHECKOUT_TEST_DOMAINS = [
  'checkout-a.ventia.localhost',
  'checkout-b.ventia.localhost',
  'checkout-c.ventia.localhost',
  'checkout-d.ventia.localhost',
  'checkout-e.ventia.localhost',
];

let db: Awaited<ReturnType<typeof startTestDb>>;
let prisma: PrismaClientType;
let app: INestApplication;

// tenantId fixtures, populated in beforeAll.
let tenantAId: string; // happy path + unconfigured-shipping-method + same-email reuse
let tenantBId: string; // insufficient stock
let tenantCId: string; // COD-restricted departamento
let tenantDId: string; // no cart cookie at all
let tenantEId: string; // concurrency

// Product fixture ids, populated in beforeAll.
let productXId: string; // tenant A — 45900 cents
let productYId: string; // tenant A — 20000 cents
let stockOkProductId: string; // tenant B — enough stock
let stockShortProductId: string; // tenant B — insufficient stock
let codProductId: string; // tenant C
let concurrencyProductId: string; // tenant E — plenty of stock

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

  const { createApp } = await import('../src/main');
  app = await createApp();
  await app.init();
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
    const expectedTax = 14657 + 3193;
    const expectedShipping = 12000; // flat-1
    const expectedTotal = expectedSubtotal + expectedTax + expectedShipping;
    expect(expectedSubtotal).toBe(111800);
    expect(expectedTax).toBe(17850);
    expect(expectedTotal).toBe(141650);

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
      });
    expect(res.status).toBe(201);

    const count = await prisma.customer.count({ where: { tenantId: tenantAId, email: 'ana@example.com' } });
    expect(count).toBe(1);

    const after = await prisma.customer.findFirst({ where: { tenantId: tenantAId, email: 'ana@example.com' } });
    expect(after?.ordersCount).toBe(2);
    expect(after?.totalSpentCents).toBe((before?.totalSpentCents ?? 0) + res.body.totalCents);
  });
});
