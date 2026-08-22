import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient as PrismaClientType } from '@ventia/db';
import { startTestDb } from './helpers';
import type { signUpWithTenant as SignUpWithTenant } from './admin-helpers';
import { MAILER, type MailMessage } from '../src/mailer/mailer';

/**
 * Product reviews, end to end.
 *
 * Almost everything asserted here is about ONE property: a review requires a
 * real purchase, proven server-side. The `Review` model's doc comment explains
 * why that property carries the whole feature — it is what replaces a
 * moderation queue, so if it can be sidestepped there is nothing behind it.
 * The tests that matter most are therefore the ones that try to sidestep it:
 * an unpaid order, a cancelled one, an order for a different product, an
 * unverified address, and an `orderId` supplied by the client.
 *
 * The second property is that reviews are LIVE the moment they are posted.
 * There is no approval step to wait for, and `publishes immediately` below
 * exists to fail loudly if anyone ever adds one.
 */

const RUN = Date.now().toString(36);
const DOMAIN = `resenas-${RUN}.ventia.localhost`;
const OTHER_DOMAIN = `resenas-otra-${RUN}.ventia.localhost`;
const PASSWORD = 'una-contraseña-larga';

let db: Awaited<ReturnType<typeof startTestDb>>;
let prisma: PrismaClientType;
let app: INestApplication;
let signUpWithTenant: typeof SignUpWithTenant;
let sent: MailMessage[];

let tenantId: string;
let otherTenantId: string;
let adminCookie: string;
let otherAdminCookie: string;
let camisaId: string;
let gorraId: string;
let borradorId: string;

let orderNumber = 1000;

beforeAll(async () => {
  db = await startTestDb();
  process.env.DATABASE_URL = db.url;
  process.env.REDIS_URL = 'redis://localhost:6379';

  const { createApp } = await import('../src/main');
  app = await createApp();

  sent = [];
  const mailer = app.get(MAILER);
  vi.spyOn(mailer, 'send').mockImplementation(async (msg: MailMessage) => {
    sent.push(msg);
  });

  await app.init();
  ({ platformDb: prisma } = await import('@ventia/db'));
  ({ signUpWithTenant } = await import('./admin-helpers'));

  // The merchant's own tenant is created through the admin helper (it makes
  // the tenant AND the session in one step), then given a storefront domain so
  // the same tenant is reachable from both sides of this feature.
  ({ cookie: adminCookie, tenantId } = await signUpWithTenant(`resenas-owner-${RUN}@demo.co`, 'owner'));
  await prisma.tenantDomain.create({ data: { tenantId, domain: DOMAIN, isPrimary: true } });

  ({ cookie: otherAdminCookie, tenantId: otherTenantId } = await signUpWithTenant(
    `resenas-otro-${RUN}@demo.co`,
    'owner',
  ));
  await prisma.tenantDomain.create({ data: { tenantId: otherTenantId, domain: OTHER_DOMAIN, isPrimary: true } });

  camisaId = (
    await prisma.product.create({
      data: { tenantId, name: 'Camisa', slug: 'camisa', priceCents: 80_000, status: 'active', stock: 10 },
    })
  ).id;
  gorraId = (
    await prisma.product.create({
      data: { tenantId, name: 'Gorra', slug: 'gorra', priceCents: 30_000, status: 'active', stock: 10 },
    })
  ).id;
  borradorId = (
    await prisma.product.create({
      data: { tenantId, name: 'Borrador', slug: 'borrador', priceCents: 10_000, status: 'draft', stock: 1 },
    })
  ).id;
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
  await db.stop();
});

// ---- fixtures -------------------------------------------------------------

/** An order the merchant's CRM knows about, with `productId` in it. Created
 * with Prisma rather than by driving checkout: what is under test is how the
 * review endpoint READS an order, so the states it has to distinguish
 * (unpaid, cancelled, someone else's) need to be settable directly. */
async function createOrder(options: {
  customerId: string;
  productId: string;
  status?: 'PENDING' | 'CONFIRMED' | 'PREPARING' | 'SHIPPED' | 'DELIVERED' | 'CANCELLED';
  paymentStatus?: 'PENDING' | 'PAID' | 'FAILED' | 'EXPIRED' | 'COD';
  createdAt?: Date;
}): Promise<string> {
  orderNumber += 1;
  const order = await prisma.order.create({
    data: {
      tenantId,
      number: orderNumber,
      reference: `VNT-TEST-${RUN}-${orderNumber}`,
      customerId: options.customerId,
      status: options.status ?? 'CONFIRMED',
      paymentStatus: options.paymentStatus ?? 'COD',
      email: `pedido-${orderNumber}@example.com`,
      phone: '3001112233',
      shippingAddress: { linea1: 'Calle 1', ciudad: 'Bogotá' },
      subtotalCents: 80_000,
      taxCents: 0,
      totalCents: 80_000,
      ...(options.createdAt ? { createdAt: options.createdAt } : {}),
      items: {
        create: [
          {
            tenantId,
            productId: options.productId,
            nameSnapshot: 'Artículo',
            priceCentsSnapshot: 80_000,
            qty: 1,
            taxRateSnapshot: 'NINETEEN',
          },
        ],
      },
    },
  });
  return order.id;
}

async function createCustomer(email: string): Promise<string> {
  return (await prisma.customer.create({ data: { tenantId, email, name: 'Cliente Prueba' } })).id;
}

/** The link out of the most recent email of this kind (same helper as
 * `shopper-accounts.test.ts`). */
function lastLinkFor(subjectFragment: string): string {
  const message = [...sent].reverse().find((m) => m.subject.includes(subjectFragment));
  const match = message?.text.match(/token=([^\s&]+)/);
  if (!match) throw new Error(`no link in a "${subjectFragment}" email`);
  return decodeURIComponent(match[1]);
}

function account(path: string, method: 'get' | 'post' = 'get', domain = DOMAIN) {
  return request(app.getHttpServer())[method](`/v1/storefront/account${path}`).set('x-tenant-domain', domain);
}

/** Registers a shopper, optionally confirms their address, signs them in and
 * returns the session cookie. */
async function signUpShopper(email: string, options: { verify?: boolean; name?: string } = {}): Promise<string> {
  await account('/register', 'post').send({ email, password: PASSWORD, ...(options.name ? { name: options.name } : {}) });
  if (options.verify !== false) {
    const token = lastLinkFor('Confirma tu correo');
    const verified = await account('/verify-email', 'post').send({ token });
    expect(verified.status).toBe(200);
  }
  const signIn = await account('/sign-in', 'post').send({ email, password: PASSWORD });
  expect(signIn.status).toBe(200);
  const cookies = signIn.headers['set-cookie'] as unknown as string[];
  const session = cookies.find((c) => c.startsWith('ventia_shopper='));
  if (!session) throw new Error('sign-in returned no shopper session cookie');
  return session.split(';')[0];
}

function publicReviews(slug: string, query = '', domain = DOMAIN) {
  return request(app.getHttpServer())
    .get(`/v1/storefront/products/${slug}/reviews${query}`)
    .set('x-tenant-domain', domain);
}

function postReview(cookie: string, body: unknown, domain = DOMAIN) {
  return request(app.getHttpServer())
    .post('/v1/storefront/account/reviews')
    .set('x-tenant-domain', domain)
    .set('cookie', cookie)
    .send(body);
}

function eligibility(cookie: string, productId: string, domain = DOMAIN) {
  return request(app.getHttpServer())
    .get(`/v1/storefront/account/reviews?productId=${productId}`)
    .set('x-tenant-domain', domain)
    .set('cookie', cookie);
}

// ---- the public read ------------------------------------------------------

describe('GET /v1/storefront/products/:slug/reviews', () => {
  it('says a product with no reviews has NO rating, not a rating of zero', async () => {
    const res = await publicReviews('gorra');

    expect(res.status).toBe(200);
    // `null`, never 0 — a 0 would render as the worst possible score on every
    // product the store has just added.
    expect(res.body.summary).toEqual({
      average: null,
      count: 0,
      distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
    });
    expect(res.body.reviews).toEqual([]);
  });

  it('404s for a draft product exactly as the product page does', async () => {
    // Answering `{reviews: []}` here would confirm the slug exists to anyone
    // guessing at products the merchant has not published.
    const res = await publicReviews('borrador');
    expect(res.status).toBe(404);
    expect(borradorId).toBeTruthy();
  });

  it('404s for a slug that does not exist', async () => {
    expect((await publicReviews('no-existe')).status).toBe(404);
  });

  it('rejects a nonsense page number instead of computing a nonsense OFFSET', async () => {
    expect((await publicReviews('gorra', '?page=abc')).status).toBe(400);
    expect((await publicReviews('gorra', '?page=0')).status).toBe(400);
    expect((await publicReviews('gorra', '?page=1.5')).status).toBe(400);
  });
});

// ---- the purchase requirement --------------------------------------------

describe('a review requires a purchase, proven server-side', () => {
  it('401s with no shopper session at all', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/storefront/account/reviews')
      .set('x-tenant-domain', DOMAIN)
      .send({ productId: camisaId, rating: 5 });
    expect(res.status).toBe(401);
  });

  it('refuses a shopper who has never bought anything', async () => {
    const cookie = await signUpShopper(`curiosa-${RUN}@example.com`);

    const res = await postReview(cookie, { productId: camisaId, rating: 5, bodyMd: 'Se ve linda' });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'PURCHASE_REQUIRED' });
  });

  it('refuses an order that is still PENDING and unpaid', async () => {
    // The cheapest attack on this whole design: a cash-on-delivery checkout
    // costs nothing but a form submission, so if a pending order entitled its
    // author to review, the purchase requirement would mean nothing.
    const email = `pendiente-${RUN}@example.com`;
    const customerId = await createCustomer(email);
    await createOrder({ customerId, productId: camisaId, status: 'PENDING', paymentStatus: 'PENDING' });
    const cookie = await signUpShopper(email);

    const res = await postReview(cookie, { productId: camisaId, rating: 1 });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'PURCHASE_REQUIRED' });
  });

  it('refuses a CANCELLED order even when it was paid', async () => {
    const email = `cancelada-${RUN}@example.com`;
    const customerId = await createCustomer(email);
    await createOrder({ customerId, productId: camisaId, status: 'CANCELLED', paymentStatus: 'PAID' });
    const cookie = await signUpShopper(email);

    const res = await postReview(cookie, { productId: camisaId, rating: 5 });

    expect(res.status).toBe(403);
  });

  it('refuses an order that contains a DIFFERENT product', async () => {
    const email = `otro-producto-${RUN}@example.com`;
    const customerId = await createCustomer(email);
    await createOrder({ customerId, productId: gorraId, status: 'DELIVERED' });
    const cookie = await signUpShopper(email);

    expect((await postReview(cookie, { productId: camisaId, rating: 5 })).status).toBe(403);
    // ...and the same shopper CAN review the thing they actually bought.
    expect((await postReview(cookie, { productId: gorraId, rating: 4 })).status).toBe(201);
  });

  it('refuses an unconfirmed address, and refuses it BEFORE looking at orders', async () => {
    // The account is linked to the merchant's customer row by matching email,
    // and anyone can register with someone else's. Reviewing off an unverified
    // link would publish a "compra verificada" claim the platform cannot back.
    const email = `sin-confirmar-${RUN}@example.com`;
    const customerId = await createCustomer(email);
    await createOrder({ customerId, productId: camisaId, status: 'DELIVERED' });
    const cookie = await signUpShopper(email, { verify: false });

    const res = await postReview(cookie, { productId: camisaId, rating: 5 });

    expect(res.status).toBe(403);
    // EMAIL_NOT_VERIFIED and not PURCHASE_REQUIRED: the purchase lookup walks
    // the very link that is unverified, so answering from it would turn this
    // route into an oracle for "has this address bought this product".
    expect(res.body).toEqual({ error: 'EMAIL_NOT_VERIFIED' });
  });

  it('accepts a cash-on-delivery order the merchant has confirmed', async () => {
    // COD never reaches paymentStatus PAID — the courier collects. The
    // merchant moving it out of PENDING is them vouching for the sale.
    const email = `contraentrega-${RUN}@example.com`;
    const customerId = await createCustomer(email);
    await createOrder({ customerId, productId: gorraId, status: 'CONFIRMED', paymentStatus: 'COD' });
    const cookie = await signUpShopper(email);

    expect((await postReview(cookie, { productId: gorraId, rating: 5 })).status).toBe(201);
  });
});

describe('the entitling order is chosen by the server', () => {
  const email = `entitling-${RUN}@example.com`;
  let cookie: string;
  let firstOrderId: string;

  beforeAll(async () => {
    const customerId = await createCustomer(email);
    firstOrderId = await createOrder({
      customerId,
      productId: camisaId,
      status: 'DELIVERED',
      createdAt: new Date('2026-01-05T12:00:00Z'),
    });
    await createOrder({
      customerId,
      productId: camisaId,
      status: 'DELIVERED',
      createdAt: new Date('2026-06-05T12:00:00Z'),
    });
    cookie = await signUpShopper(email, { name: 'Ana Gómez' });
  });

  it('ignores an orderId in the request body and stores the EARLIEST qualifying order', async () => {
    // The order id is never client-supplied: accepting one would reduce the
    // purchase requirement to "name any order id".
    const foreignOrder = await createOrder({
      customerId: await createCustomer(`ajeno-${RUN}@example.com`),
      productId: camisaId,
      status: 'DELIVERED',
    });

    const res = await postReview(cookie, {
      productId: camisaId,
      rating: 5,
      title: 'Quedó perfecta',
      bodyMd: 'Llegó en dos días.',
      orderId: foreignOrder,
    });

    expect(res.status).toBe(201);
    const stored = await prisma.review.findUniqueOrThrow({ where: { id: res.body.review.id } });
    expect(stored.orderId).not.toBe(foreignOrder);
    // Earliest, so the stored order never changes meaning when the shopper
    // buys the same thing again.
    expect(stored.orderId).toBe(firstOrderId);
  });

  it('publishes immediately — no pending state, no approval step', async () => {
    const stored = await prisma.review.findFirstOrThrow({ where: { productId: camisaId, rating: 5 } });
    expect(stored.status).toBe('published');

    const res = await publicReviews('camisa');
    expect(res.body.reviews.some((r: { title: string | null }) => r.title === 'Quedó perfecta')).toBe(true);
  });

  it('publishes an abbreviated name, never the full name and never the email', async () => {
    const res = await publicReviews('camisa');
    const mine = res.body.reviews.find((r: { title: string | null }) => r.title === 'Quedó perfecta');
    expect(mine.authorLabel).toBe('Ana G.');
    expect(JSON.stringify(res.body)).not.toContain(email);
  });

  it('refuses a second review of the same product', async () => {
    const res = await postReview(cookie, { productId: camisaId, rating: 1 });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'REVIEW_ALREADY_EXISTS' });
  });

  it('validates the rating rather than letting it reach an average', async () => {
    for (const rating of [0, 6, '5', 2.5]) {
      const res = await postReview(cookie, { productId: camisaId, rating });
      expect(res.status).toBe(400);
    }
  });

  it('does not let a session from one store review a product in another', async () => {
    // Presented at the OTHER store's domain, this cookie resolves to no
    // session at all — sessions are per store.
    const res = await postReview(cookie, { productId: camisaId, rating: 5 }, OTHER_DOMAIN);
    expect(res.status).toBe(401);
  });
});

// ---- what the shopper is told --------------------------------------------

describe('GET /v1/storefront/account/reviews (eligibility)', () => {
  it('401s for a visitor with no session, which the storefront reads as "sign in"', async () => {
    const res = await request(app.getHttpServer())
      .get(`/v1/storefront/account/reviews?productId=${camisaId}`)
      .set('x-tenant-domain', DOMAIN);
    expect(res.status).toBe(401);
  });

  it('distinguishes not-bought, unconfirmed, can-review and already-reviewed', async () => {
    const noPurchase = await signUpShopper(`elegible-a-${RUN}@example.com`);
    expect((await eligibility(noPurchase, camisaId)).body).toEqual({
      eligibility: 'not_purchased',
      review: null,
    });

    const unverifiedEmail = `elegible-b-${RUN}@example.com`;
    const unverifiedCustomer = await createCustomer(unverifiedEmail);
    await createOrder({ customerId: unverifiedCustomer, productId: camisaId, status: 'DELIVERED' });
    const unverified = await signUpShopper(unverifiedEmail, { verify: false });
    expect((await eligibility(unverified, camisaId)).body.eligibility).toBe('email_not_verified');

    const buyerEmail = `elegible-c-${RUN}@example.com`;
    const buyerCustomer = await createCustomer(buyerEmail);
    await createOrder({ customerId: buyerCustomer, productId: camisaId, status: 'SHIPPED' });
    const buyer = await signUpShopper(buyerEmail);
    expect((await eligibility(buyer, camisaId)).body).toEqual({ eligibility: 'can_review', review: null });

    await postReview(buyer, { productId: camisaId, rating: 4, bodyMd: 'Buena tela' });
    const after = await eligibility(buyer, camisaId);
    expect(after.body.eligibility).toBe('already_reviewed');
    expect(after.body.review).toMatchObject({ rating: 4, bodyMd: 'Buena tela', status: 'published' });
  });

  it('404s a malformed productId instead of 500ing on a bad uuid', async () => {
    const cookie = await signUpShopper(`elegible-d-${RUN}@example.com`);
    expect((await eligibility(cookie, 'no-es-uuid')).status).toBe(404);
  });
});

// ---- moderation, and what it does to the average -------------------------

describe('the merchant hides a review', () => {
  const angryEmail = `enojada-${RUN}@example.com`;
  let angryCookie: string;
  let angryReviewId: string;

  beforeAll(async () => {
    const customerId = await createCustomer(angryEmail);
    await createOrder({ customerId, productId: camisaId, status: 'DELIVERED' });
    angryCookie = await signUpShopper(angryEmail);
    const res = await postReview(angryCookie, { productId: camisaId, rating: 1, bodyMd: 'Llegó rota' });
    expect(res.status).toBe(201);
    angryReviewId = res.body.review.id;
  });

  it('counts every published review in the average before anything is hidden', async () => {
    const res = await publicReviews('camisa');
    // 5 (Ana) + 4 (elegible-c) + 1 (enojada) = 10/3 = 3.333… -> 3.3
    expect(res.body.summary.count).toBe(3);
    expect(res.body.summary.average).toBe(3.3);
    expect(res.body.summary.distribution).toEqual({ 1: 1, 2: 0, 3: 0, 4: 1, 5: 1 });
  });

  it('drops it from the list AND from the average, so the two agree', async () => {
    const patch = await request(app.getHttpServer())
      .patch(`/v1/admin/reviews/${angryReviewId}`)
      .set('cookie', adminCookie)
      .send({ status: 'hidden' });
    expect(patch.status).toBe(200);
    expect(patch.body.status).toBe('hidden');

    const res = await publicReviews('camisa');
    expect(res.body.reviews.some((r: { id: string }) => r.id === angryReviewId)).toBe(false);
    // An average that still included the hidden 1 would be 3.3 over a list a
    // shopper can count to 4.5 — unauditable, and the first support message
    // the merchant cannot answer.
    expect(res.body.summary.count).toBe(2);
    expect(res.body.summary.average).toBe(4.5);
    expect(res.body.summary.distribution).toEqual({ 1: 0, 2: 0, 3: 0, 4: 1, 5: 1 });
  });

  it('still tells the AUTHOR their review exists and is not visible', async () => {
    // The row is what keeps "you already reviewed this" true, and a shopper
    // shown their hidden review as if it were live has simply been deceived.
    const res = await eligibility(angryCookie, camisaId);
    expect(res.body.eligibility).toBe('already_reviewed');
    expect(res.body.review).toMatchObject({ id: angryReviewId, status: 'hidden' });
  });

  it('lets the merchant put it back', async () => {
    await request(app.getHttpServer())
      .patch(`/v1/admin/reviews/${angryReviewId}`)
      .set('cookie', adminCookie)
      .send({ status: 'published' });

    const res = await publicReviews('camisa');
    expect(res.body.summary.count).toBe(3);
    expect(res.body.reviews.some((r: { id: string }) => r.id === angryReviewId)).toBe(true);
  });

  it('writes an audit row naming the action, not the shopper words', async () => {
    const audit = await prisma.auditLog.findFirst({
      where: { tenantId, entity: 'Review', entityId: angryReviewId },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit?.action).toBe('review.moderate');
    expect(JSON.stringify(audit?.data)).not.toContain('Llegó rota');
  });
});

describe('the merchant replies', () => {
  let reviewId: string;

  beforeAll(async () => {
    reviewId = (await prisma.review.findFirstOrThrow({ where: { tenantId, rating: 1 } })).id;
  });

  it('publishes the reply with a timestamp derived from the reply itself', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/v1/admin/reviews/${reviewId}`)
      .set('cookie', adminCookie)
      .send({ replyMd: '  Lo sentimos, ya te enviamos otra.  ' });

    expect(res.status).toBe(200);
    expect(res.body.replyMd).toBe('Lo sentimos, ya te enviamos otra.');
    expect(res.body.repliedAt).not.toBeNull();

    const shown = await publicReviews('camisa');
    const row = shown.body.reviews.find((r: { id: string }) => r.id === reviewId);
    expect(row.replyMd).toBe('Lo sentimos, ya te enviamos otra.');
  });

  it('lets the merchant rewrite it', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/v1/admin/reviews/${reviewId}`)
      .set('cookie', adminCookie)
      .send({ replyMd: 'Ya te enviamos una nueva, sin costo.' });
    expect(res.body.replyMd).toBe('Ya te enviamos una nueva, sin costo.');
  });

  it('lets the merchant withdraw it, clearing the timestamp with it', async () => {
    // A reply is the merchant's own public speech, often written at the moment
    // they were most annoyed. `repliedAt` must go with it or the storefront
    // renders "respondió el 4 de mayo" under nothing.
    const res = await request(app.getHttpServer())
      .patch(`/v1/admin/reviews/${reviewId}`)
      .set('cookie', adminCookie)
      .send({ replyMd: null });

    expect(res.status).toBe(200);
    expect(res.body.replyMd).toBeNull();
    expect(res.body.repliedAt).toBeNull();
  });

  it('never lets the merchant edit what the shopper wrote', async () => {
    const before = await prisma.review.findUniqueOrThrow({ where: { id: reviewId } });
    const res = await request(app.getHttpServer())
      .patch(`/v1/admin/reviews/${reviewId}`)
      .set('cookie', adminCookie)
      .send({ rating: 5, bodyMd: 'Todo excelente', title: 'Genial' });

    // No moderatable field in the body at all -> the schema refuses it
    // outright rather than silently applying nothing.
    expect(res.status).toBe(400);
    const after = await prisma.review.findUniqueOrThrow({ where: { id: reviewId } });
    expect(after.rating).toBe(before.rating);
    expect(after.bodyMd).toBe(before.bodyMd);
  });

  it('rejects an empty patch', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/v1/admin/reviews/${reviewId}`)
      .set('cookie', adminCookie)
      .send({});
    expect(res.status).toBe(400);
  });

  it('has no approve action to call', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/v1/admin/reviews/${reviewId}`)
      .set('cookie', adminCookie)
      .send({ status: 'pending' });
    expect(res.status).toBe(400);
  });
});

describe('GET /v1/admin/reviews', () => {
  it('requires an admin session', async () => {
    expect((await request(app.getHttpServer()).get('/v1/admin/reviews')).status).toBe(401);
  });

  it('lists this tenant reviews with the product and the buyer, newest first', async () => {
    const res = await request(app.getHttpServer()).get('/v1/admin/reviews').set('cookie', adminCookie);

    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThan(0);
    const [newest, next] = res.body.items;
    expect(new Date(newest.createdAt).getTime()).toBeGreaterThanOrEqual(new Date(next.createdAt).getTime());
    expect(newest.product).toMatchObject({ id: expect.any(String), name: expect.any(String) });
    // The merchant shipped this person a parcel; the abbreviation exists to
    // protect the shopper from the PUBLIC, not from the merchant.
    expect(newest.author.email).toEqual(expect.any(String));
    expect(newest.orderId).toEqual(expect.any(String));
  });

  it('filters by status and by product', async () => {
    await request(app.getHttpServer())
      .patch(`/v1/admin/reviews/${(await prisma.review.findFirstOrThrow({ where: { tenantId, productId: gorraId } })).id}`)
      .set('cookie', adminCookie)
      .send({ status: 'hidden' });

    const hidden = await request(app.getHttpServer())
      .get('/v1/admin/reviews?status=hidden')
      .set('cookie', adminCookie);
    expect(hidden.body.items.length).toBeGreaterThan(0);
    expect(hidden.body.items.every((r: { status: string }) => r.status === 'hidden')).toBe(true);

    const byProduct = await request(app.getHttpServer())
      .get(`/v1/admin/reviews?productId=${camisaId}`)
      .set('cookie', adminCookie);
    expect(byProduct.body.items.every((r: { product: { id: string } }) => r.product.id === camisaId)).toBe(true);

    expect(
      (await request(app.getHttpServer()).get('/v1/admin/reviews?status=pendiente').set('cookie', adminCookie))
        .status,
    ).toBe(400);
  });

  it('does not show — or let another merchant moderate — this tenant reviews', async () => {
    const other = await request(app.getHttpServer()).get('/v1/admin/reviews').set('cookie', otherAdminCookie);
    expect(other.body.items).toEqual([]);
    expect(otherTenantId).not.toBe(tenantId);

    const mine = await prisma.review.findFirstOrThrow({ where: { tenantId } });
    const attempt = await request(app.getHttpServer())
      .patch(`/v1/admin/reviews/${mine.id}`)
      .set('cookie', otherAdminCookie)
      .send({ status: 'hidden' });
    expect(attempt.status).toBe(404);
  });

  it('404s an unknown id rather than 500ing', async () => {
    const res = await request(app.getHttpServer())
      .patch('/v1/admin/reviews/11111111-2222-4333-8444-555555555555')
      .set('cookie', adminCookie)
      .send({ status: 'hidden' });
    expect(res.status).toBe(404);
  });
});
