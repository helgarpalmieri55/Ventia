import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import Redis from 'ioredis';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient as PrismaClientType } from '@ventia/db';
import { startTestDb } from './helpers';

const CART_TEST_DOMAINS = ['cart-a.ventia.localhost', 'cart-b.ventia.localhost'];

let db: Awaited<ReturnType<typeof startTestDb>>;
let prisma: PrismaClientType;
let app: INestApplication;
let tenantAId: string;
let tenantBId: string;

// Fixture product ids, populated in beforeAll.
let activeProductId: string;
let variantProductId: string; // has variantA
let variantAId: string;
let otherVariantProductId: string; // has variantB, a DIFFERENT product than variantProductId
let variantBId: string;
let draftProductId: string;
let archivedProductId: string;
let tenantBProductId: string;

/** Extracts the `ventia_cart` cookie value from a response's Set-Cookie header. */
function extractCartCookie(res: request.Response): string {
  const setCookie = res.headers['set-cookie'] as unknown as string[] | undefined;
  const raw = setCookie?.find((c) => c.startsWith('ventia_cart='));
  if (!raw) throw new Error('expected a ventia_cart Set-Cookie header');
  return raw.split(';')[0].split('=')[1];
}

beforeAll(async () => {
  db = await startTestDb();
  // platformDb (exported by @ventia/db) is constructed at module-evaluation
  // time from process.env.DATABASE_URL, so env vars must be set BEFORE the
  // first import of @ventia/db or ../src/main — see storefront-categories.test.ts
  // for the same pattern.
  process.env.DATABASE_URL = db.url;
  process.env.REDIS_URL = 'redis://localhost:6379';

  // DomainResolver caches resolved tenants by domain string in this shared
  // dev Redis instance for 60s (see storefront-products.test.ts's comment on
  // the same hazard). This file reuses fixed domain names across repeated
  // local test runs during development, which — unlike the cross-FILE
  // collision that comment describes — is a same-domain, DIFFERENT-container
  // collision: a stale cache entry from a previous run would point at a
  // tenantId that no longer exists in THIS run's fresh Postgres container.
  // Proactively flush just these domains' cache keys so every run starts
  // from a clean resolution regardless of recent prior runs.
  const cacheBuster = new Redis(process.env.REDIS_URL);
  await cacheBuster.del(...CART_TEST_DOMAINS.map((d) => `tenant:domain:${d}`));
  await cacheBuster.quit();

  const { PrismaClient } = (await import('@ventia/db')) as { PrismaClient: typeof PrismaClientType };
  prisma = new PrismaClient({ datasources: { db: { url: db.url } } });

  const tenantA = await prisma.tenant.create({ data: { slug: 'cart-a', name: 'Cart A', status: 'live' } });
  tenantAId = tenantA.id;
  await prisma.tenantDomain.create({ data: { tenantId: tenantA.id, domain: 'cart-a.ventia.localhost', isPrimary: true } });

  const tenantB = await prisma.tenant.create({ data: { slug: 'cart-b', name: 'Cart B', status: 'live' } });
  tenantBId = tenantB.id;
  await prisma.tenantDomain.create({ data: { tenantId: tenantB.id, domain: 'cart-b.ventia.localhost', isPrimary: true } });

  const activeProduct = await prisma.product.create({
    data: { tenantId: tenantAId, name: 'Camiseta', slug: 'camiseta', priceCents: 45900, status: 'active', stock: 10 },
  });
  activeProductId = activeProduct.id;

  const variantProduct = await prisma.product.create({
    data: { tenantId: tenantAId, name: 'Zapato', slug: 'zapato', priceCents: 100000, status: 'active', stock: 10 },
  });
  variantProductId = variantProduct.id;
  const variantA = await prisma.productVariant.create({
    data: { tenantId: tenantAId, productId: variantProductId, option1: '42', stock: 5 },
  });
  variantAId = variantA.id;

  const otherVariantProduct = await prisma.product.create({
    data: { tenantId: tenantAId, name: 'Gorra', slug: 'gorra', priceCents: 30000, status: 'active', stock: 10 },
  });
  otherVariantProductId = otherVariantProduct.id;
  const variantB = await prisma.productVariant.create({
    data: { tenantId: tenantAId, productId: otherVariantProductId, option1: 'Única', stock: 5 },
  });
  variantBId = variantB.id;

  const draftProduct = await prisma.product.create({
    data: { tenantId: tenantAId, name: 'Borrador', slug: 'borrador', priceCents: 1000, status: 'draft' },
  });
  draftProductId = draftProduct.id;

  const archivedProduct = await prisma.product.create({
    data: { tenantId: tenantAId, name: 'Viejo', slug: 'viejo', priceCents: 1000, status: 'archived' },
  });
  archivedProductId = archivedProduct.id;

  const tenantBProduct = await prisma.product.create({
    data: { tenantId: tenantBId, name: 'Producto B', slug: 'producto-b', priceCents: 20000, status: 'active', stock: 10 },
  });
  tenantBProductId = tenantBProduct.id;

  const { createApp } = await import('../src/main');
  app = await createApp();
  await app.init();
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
  await db.stop();
});

describe('GET /v1/storefront/cart', () => {
  it('returns an empty cart with cookieKey: null and creates no Cart row when there is no cookie', async () => {
    const before = await prisma.cart.count({ where: { tenantId: tenantBId } });
    const res = await request(app.getHttpServer())
      .get('/v1/storefront/cart')
      .set('x-tenant-domain', 'cart-b.ventia.localhost');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ cookieKey: null, lines: [], subtotalCents: 0, taxCents: 0 });
    const after = await prisma.cart.count({ where: { tenantId: tenantBId } });
    expect(after).toBe(before);
  });
});

describe('POST /v1/storefront/cart/items', () => {
  it('creates a Cart row and sets the ventia_cart cookie on the first add', async () => {
    const before = await prisma.cart.count({ where: { tenantId: tenantAId } });
    const res = await request(app.getHttpServer())
      .post('/v1/storefront/cart/items')
      .set('x-tenant-domain', 'cart-a.ventia.localhost')
      .send({ productId: activeProductId, qty: 2 });
    expect(res.status).toBe(201);
    expect(res.body.lines).toHaveLength(1);
    expect(res.body.lines[0]).toMatchObject({ productId: activeProductId, variantId: null, qty: 2, name: 'Camiseta' });
    const cookieValue = extractCartCookie(res);
    expect(cookieValue).toBeTruthy();
    const after = await prisma.cart.count({ where: { tenantId: tenantAId } });
    expect(after).toBe(before + 1);
  });

  it('merges qty into the existing line for the same (productId, variantId) rather than duplicating', async () => {
    const first = await request(app.getHttpServer())
      .post('/v1/storefront/cart/items')
      .set('x-tenant-domain', 'cart-a.ventia.localhost')
      .send({ productId: variantProductId, variantId: variantAId, qty: 1 });
    expect(first.status).toBe(201);
    const cookieValue = extractCartCookie(first);

    const second = await request(app.getHttpServer())
      .post('/v1/storefront/cart/items')
      .set('x-tenant-domain', 'cart-a.ventia.localhost')
      .set('Cookie', `ventia_cart=${cookieValue}`)
      .send({ productId: variantProductId, variantId: variantAId, qty: 3 });
    expect(second.status).toBe(201);

    const linesForVariant = second.body.lines.filter((l: { productId: string; variantId: string | null }) =>
      l.productId === variantProductId && l.variantId === variantAId,
    );
    expect(linesForVariant).toHaveLength(1);
    expect(linesForVariant[0].qty).toBe(4);
  });

  it('404s PRODUCT_NOT_FOUND for a draft product', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/storefront/cart/items')
      .set('x-tenant-domain', 'cart-a.ventia.localhost')
      .send({ productId: draftProductId, qty: 1 });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('PRODUCT_NOT_FOUND');
  });

  it('404s PRODUCT_NOT_FOUND for an archived product', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/storefront/cart/items')
      .set('x-tenant-domain', 'cart-a.ventia.localhost')
      .send({ productId: archivedProductId, qty: 1 });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('PRODUCT_NOT_FOUND');
  });

  it('404s PRODUCT_NOT_FOUND when the variant belongs to a DIFFERENT product than the one specified', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/storefront/cart/items')
      .set('x-tenant-domain', 'cart-a.ventia.localhost')
      // variantBId really belongs to otherVariantProductId, not variantProductId
      .send({ productId: variantProductId, variantId: variantBId, qty: 1 });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('PRODUCT_NOT_FOUND');
  });
});

describe('PATCH/DELETE /v1/storefront/cart/items/:id (same-tenant happy path)', () => {
  it('updates an item\'s qty, then removes it, recalculating totals each time', async () => {
    const addRes = await request(app.getHttpServer())
      .post('/v1/storefront/cart/items')
      .set('x-tenant-domain', 'cart-a.ventia.localhost')
      .send({ productId: otherVariantProductId, variantId: variantBId, qty: 1 });
    expect(addRes.status).toBe(201);
    const cookieValue = extractCartCookie(addRes);
    const itemId: string = addRes.body.lines.find(
      (l: { productId: string; id: string }) => l.productId === otherVariantProductId,
    ).id;
    // Gorra: priceCents 30000, qty 1 -> subtotal 30000.
    expect(addRes.body.subtotalCents).toBe(30000);

    const patchRes = await request(app.getHttpServer())
      .patch(`/v1/storefront/cart/items/${itemId}`)
      .set('x-tenant-domain', 'cart-a.ventia.localhost')
      .set('Cookie', `ventia_cart=${cookieValue}`)
      .send({ qty: 3 });
    expect(patchRes.status).toBe(200);
    const patchedLine = patchRes.body.lines.find((l: { id: string }) => l.id === itemId);
    expect(patchedLine.qty).toBe(3);
    expect(patchRes.body.subtotalCents).toBe(90000);

    const deleteRes = await request(app.getHttpServer())
      .delete(`/v1/storefront/cart/items/${itemId}`)
      .set('x-tenant-domain', 'cart-a.ventia.localhost')
      .set('Cookie', `ventia_cart=${cookieValue}`);
    expect(deleteRes.status).toBe(200);
    expect(deleteRes.body.lines.some((l: { id: string }) => l.id === itemId)).toBe(false);
    expect(await prisma.cartItem.findUnique({ where: { id: itemId } })).toBeNull();
  });
});

describe('cross-tenant isolation', () => {
  it('never lets tenant A\'s cart cookie reach tenant B\'s cart, even against a real item id', async () => {
    // Tenant A creates a real cart with a real item.
    const addRes = await request(app.getHttpServer())
      .post('/v1/storefront/cart/items')
      .set('x-tenant-domain', 'cart-a.ventia.localhost')
      .send({ productId: activeProductId, qty: 1 });
    expect(addRes.status).toBe(201);
    const tenantACookie = extractCartCookie(addRes);
    const tenantAItemId = addRes.body.lines[0].id;

    // Tenant B independently has its own real cart with its own real item,
    // so the isolation check below is against a tenant with genuine cart
    // data of its own, not an empty one.
    const tenantBAddRes = await request(app.getHttpServer())
      .post('/v1/storefront/cart/items')
      .set('x-tenant-domain', 'cart-b.ventia.localhost')
      .send({ productId: tenantBProductId, qty: 1 });
    expect(tenantBAddRes.status).toBe(201);

    // Confirm tenant A's own PATCH with its own cookie genuinely works —
    // this proves any subsequent 404 against tenant B is isolation, not a
    // broken update path.
    const selfPatch = await request(app.getHttpServer())
      .patch(`/v1/storefront/cart/items/${tenantAItemId}`)
      .set('x-tenant-domain', 'cart-a.ventia.localhost')
      .set('Cookie', `ventia_cart=${tenantACookie}`)
      .send({ qty: 9 });
    expect(selfPatch.status).toBe(200);

    // Now replay tenant A's real cookie value AND its real item id, but
    // against tenant B's domain. CartCookieGuard resolves the cart by
    // (tenantId, cookieKey) — tenant B has no Cart row with this cookieKey
    // (it belongs to tenant A), so it must resolve to no cart at all, and
    // the PATCH/DELETE must 404 rather than ever touching tenant A's data.
    const crossPatch = await request(app.getHttpServer())
      .patch(`/v1/storefront/cart/items/${tenantAItemId}`)
      .set('x-tenant-domain', 'cart-b.ventia.localhost')
      .set('Cookie', `ventia_cart=${tenantACookie}`)
      .send({ qty: 999 });
    expect(crossPatch.status).toBe(404);

    const crossDelete = await request(app.getHttpServer())
      .delete(`/v1/storefront/cart/items/${tenantAItemId}`)
      .set('x-tenant-domain', 'cart-b.ventia.localhost')
      .set('Cookie', `ventia_cart=${tenantACookie}`);
    expect(crossDelete.status).toBe(404);

    // Tenant A's item survives untouched (qty from selfPatch above, not 999,
    // and not deleted) — the cross-tenant requests truly had no effect.
    const verify = await request(app.getHttpServer())
      .get('/v1/storefront/cart')
      .set('x-tenant-domain', 'cart-a.ventia.localhost')
      .set('Cookie', `ventia_cart=${tenantACookie}`);
    const survivingLine = verify.body.lines.find((l: { id: string }) => l.id === tenantAItemId);
    expect(survivingLine).toBeDefined();
    expect(survivingLine.qty).toBe(9);

    // Tenant B's own cart is also unaffected by the cross-tenant attempt
    // against it (still just its own single item, untouched).
    const tenantBCookie = extractCartCookie(tenantBAddRes);
    const verifyB = await request(app.getHttpServer())
      .get('/v1/storefront/cart')
      .set('x-tenant-domain', 'cart-b.ventia.localhost')
      .set('Cookie', `ventia_cart=${tenantBCookie}`);
    expect(verifyB.body.lines).toHaveLength(1);
    expect(verifyB.body.lines[0].productId).toBe(tenantBProductId);
    expect(verifyB.body.lines[0].qty).toBe(1);
  });
});

/**
 * Adopting an agent-built cart — the other half of `create_cart_link`.
 *
 * The tool returns `/carrito?c=<key>`; without this endpoint that link opens
 * an empty cart and everything the agent assembled is lost.
 */
describe('POST /v1/storefront/cart/adopt', () => {
  async function agentCart(tenantId: string, productId: string) {
    const cart = await prisma.cart.create({
      data: { tenantId, cookieKey: crypto.randomUUID(), source: 'agent' },
    });
    await prisma.cartItem.create({ data: { tenantId, cartId: cart.id, productId, qty: 2 } });
    return cart.cookieKey;
  }

  it('hands the shopper the agent\'s cart and sets the cookie to it', async () => {
    const cookieKey = await agentCart(tenantAId, activeProductId);

    const res = await request(app.getHttpServer())
      .post('/v1/storefront/cart/adopt')
      .set('x-tenant-domain', 'cart-a.ventia.localhost')
      .send({ cookieKey });

    expect(res.status).toBe(201);
    expect(res.body.lines).toHaveLength(1);
    expect(res.body.lines[0].qty).toBe(2);
    // The cookie is what makes every LATER call — read, update, checkout —
    // see this cart rather than the shopper's old one.
    expect(extractCartCookie(res)).toBe(cookieKey);
  });

  it('refuses a cart from another store', async () => {
    const cookieKey = await agentCart(tenantBId, tenantBProductId);

    const res = await request(app.getHttpServer())
      .post('/v1/storefront/cart/adopt')
      .set('x-tenant-domain', 'cart-a.ventia.localhost')
      .send({ cookieKey });

    expect(res.status).toBe(404);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('refuses a plain web cart, so a leaked cookie key is not a usable link', async () => {
    // Adoption is restricted to carts the agent itself created: a URL leaks
    // far more readily than an HttpOnly cookie (history, referrers, a
    // forwarded WhatsApp message), and nothing needs the wider power.
    const addRes = await request(app.getHttpServer())
      .post('/v1/storefront/cart/items')
      .set('x-tenant-domain', 'cart-a.ventia.localhost')
      .send({ productId: activeProductId, variantId: null, qty: 1 });
    const webCookieKey = extractCartCookie(addRes);

    const res = await request(app.getHttpServer())
      .post('/v1/storefront/cart/adopt')
      .set('x-tenant-domain', 'cart-a.ventia.localhost')
      .send({ cookieKey: webCookieKey });

    expect(res.status).toBe(404);
  });

  it('answers a nonexistent key exactly like a foreign one', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/storefront/cart/adopt')
      .set('x-tenant-domain', 'cart-a.ventia.localhost')
      .send({ cookieKey: crypto.randomUUID() });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('CART_NOT_FOUND');
  });

  it('leaves the shopper\'s previous cart intact rather than merging or deleting it', async () => {
    const addRes = await request(app.getHttpServer())
      .post('/v1/storefront/cart/items')
      .set('x-tenant-domain', 'cart-a.ventia.localhost')
      .send({ productId: activeProductId, variantId: null, qty: 3 });
    const oldCookieKey = extractCartCookie(addRes);
    const cookieKey = await agentCart(tenantAId, activeProductId);

    await request(app.getHttpServer())
      .post('/v1/storefront/cart/adopt')
      .set('x-tenant-domain', 'cart-a.ventia.localhost')
      .set('Cookie', `ventia_cart=${oldCookieKey}`)
      .send({ cookieKey });

    // Clicking a link must not destroy something the shopper built.
    const old = await prisma.cart.findFirst({
      where: { tenantId: tenantAId, cookieKey: oldCookieKey },
      include: { items: true },
    });
    expect(old?.items).toHaveLength(1);
    expect(old?.items[0].qty).toBe(3);
  });

  it('400s a request with no key', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/storefront/cart/adopt')
      .set('x-tenant-domain', 'cart-a.ventia.localhost')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_FAILED');
  });
});

describe('cart lines carry a thumbnail', () => {
  it('projects the product\'s FIRST image, and null when it has none', async () => {
    // Without this the cart is the one surface in the store that shows a
    // shopper only text, at the moment they are deciding whether to pay.
    // First-by-position, so the same product is not two different photos on
    // two screens of one purchase.
    await prisma.productImage.createMany({
      data: [
        { tenantId: tenantAId, productId: activeProductId, url: 'https://cdn.example/segunda.jpg', position: 1 },
        { tenantId: tenantAId, productId: activeProductId, url: 'https://cdn.example/primera.jpg', position: 0 },
      ],
    });

    const withImage = await request(app.getHttpServer())
      .post('/v1/storefront/cart/items')
      .set('x-tenant-domain', 'cart-a.ventia.localhost')
      .send({ productId: activeProductId, qty: 1 });
    expect(withImage.status).toBe(201);
    expect(withImage.body.lines[0].imageUrl).toBe('https://cdn.example/primera.jpg');

    const withoutImage = await request(app.getHttpServer())
      .post('/v1/storefront/cart/items')
      .set('x-tenant-domain', 'cart-a.ventia.localhost')
      .set('Cookie', `ventia_cart=${extractCartCookie(withImage)}`)
      .send({ productId: variantProductId, variantId: variantAId, qty: 1 });

    const line = withoutImage.body.lines.find(
      (l: { productId: string }) => l.productId === variantProductId,
    );
    // `null`, not an empty string or a missing key: the storefront draws its
    // own placeholder, and it has to be able to tell "no photo" from "field
    // not sent by an older API".
    expect(line.imageUrl).toBeNull();
  });
});
