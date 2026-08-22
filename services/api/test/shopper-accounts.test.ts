import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient as PrismaClientType } from '@ventia/db';
import { startTestDb } from './helpers';
import { MAILER, type MailMessage } from '../src/mailer/mailer';

/**
 * Shopper accounts, end to end.
 *
 * Two properties carry most of the weight here and neither is about the happy
 * path: an answer must never reveal whether an address has an account at this
 * store, and signing in must never cost the shopper their basket. The first is
 * a disclosure that matters more than the account itself for a store selling
 * something personal; the second is an abandoned sale at the payment screen.
 */

const RUN = Date.now().toString(36);
const DOMAIN = `shop-acct-${RUN}.ventia.localhost`;
const OTHER_DOMAIN = `shop-other-${RUN}.ventia.localhost`;
const PASSWORD = 'una-contraseña-larga';

let db: Awaited<ReturnType<typeof startTestDb>>;
let prisma: PrismaClientType;
let app: INestApplication;
let tenantId: string;
let otherTenantId: string;
let productId: string;
let sent: MailMessage[];

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

  const tenant = await prisma.tenant.create({
    data: { slug: `shop-acct-${RUN}`, name: 'Tienda Cuentas', status: 'live' },
  });
  tenantId = tenant.id;
  await prisma.tenantDomain.create({ data: { tenantId, domain: DOMAIN, isPrimary: true } });

  const other = await prisma.tenant.create({
    data: { slug: `shop-other-${RUN}`, name: 'Otra Tienda', status: 'live' },
  });
  otherTenantId = other.id;
  await prisma.tenantDomain.create({ data: { tenantId: otherTenantId, domain: OTHER_DOMAIN, isPrimary: true } });

  const product = await prisma.product.create({
    data: { tenantId, name: 'Camisa', slug: 'camisa', priceCents: 80_000, status: 'active', stock: 10 },
  });
  productId = product.id;
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
  await db.stop();
});

function post(path: string, body: unknown, domain = DOMAIN) {
  return request(app.getHttpServer()).post(`/v1/storefront/account${path}`).set('x-tenant-domain', domain).send(body);
}

/** The link out of the most recent email of this kind. */
function lastLinkFor(subjectFragment: string): string {
  const message = [...sent].reverse().find((m) => m.subject.includes(subjectFragment));
  const match = message?.text.match(/token=([^\s&]+)/);
  if (!match) throw new Error(`no link in a "${subjectFragment}" email`);
  return decodeURIComponent(match[1]);
}

describe('registration does not disclose whether an address is taken', () => {
  const email = `ana-${RUN}@example.com`;

  it('accepts a new registration and emails a verification link', async () => {
    const res = await post('/register', { email, password: PASSWORD, name: 'Ana' });

    expect(res.status).toBe(202);
    expect(sent.at(-1)?.subject).toContain('Confirma tu correo');
    expect(sent.at(-1)?.to).toBe(email);
  });

  it('answers identically when the address is ALREADY registered', async () => {
    const before = sent.length;
    const res = await post('/register', { email, password: 'otra-contraseña-distinta' });

    // Same status, same body. The caller learns nothing.
    expect(res.status).toBe(202);
    // The difference is moved into the email, which only the owner can read.
    expect(sent.length).toBe(before + 1);
    expect(sent.at(-1)?.subject).toContain('Ya tienes una cuenta');
  });

  it('does NOT overwrite the existing password when someone re-registers', async () => {
    // Otherwise "register again" is an unauthenticated password reset for any
    // address — the single worst thing this endpoint could do.
    const res = await post('/sign-in', { email, password: PASSWORD });
    expect(res.status).toBe(200);

    const hijack = await post('/sign-in', { email, password: 'otra-contraseña-distinta' });
    expect(hijack.status).toBe(401);
  });
});

describe('sign-in', () => {
  const email = `beto-${RUN}@example.com`;

  beforeAll(async () => {
    await post('/register', { email, password: PASSWORD });
  });

  it('gives the same error for a wrong password and an unknown address', async () => {
    const wrongPassword = await post('/sign-in', { email, password: 'no-es-esta-clave' });
    const unknownEmail = await post('/sign-in', { email: `nadie-${RUN}@example.com`, password: PASSWORD });

    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    expect(wrongPassword.body).toEqual(unknownEmail.body);
  });

  it('sets a session the shopper can then use', async () => {
    const res = await post('/sign-in', { email, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.shopper).toEqual({ email, name: null, emailVerified: false });

    const cookie = res.headers['set-cookie'] as unknown as string[];
    expect(cookie.some((c) => c.startsWith('ventia_shopper='))).toBe(true);
    // HttpOnly, or any script on the storefront can read the session.
    expect(cookie.find((c) => c.startsWith('ventia_shopper='))).toContain('HttpOnly');

    const me = await request(app.getHttpServer())
      .get('/v1/storefront/account/me')
      .set('x-tenant-domain', DOMAIN)
      .set('Cookie', cookie);
    expect(me.status).toBe(200);
    expect(me.body.email).toBe(email);
  });

  it('never returns the account id or the password hash', async () => {
    const res = await post('/sign-in', { email, password: PASSWORD });
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('accountId');
    expect(body).not.toContain('passwordHash');
    expect(body).not.toContain('scrypt$');
  });
});

describe('a session belongs to ONE store', () => {
  it('a session minted at one storefront does not authenticate at another', async () => {
    // Accounts are per store. A shopper whose browser still holds a cookie
    // from store A must be anonymous at store B, even though both are served
    // by the same API.
    const email = `carla-${RUN}@example.com`;
    await post('/register', { email, password: PASSWORD });
    const signedIn = await post('/sign-in', { email, password: PASSWORD });
    const cookie = signedIn.headers['set-cookie'] as unknown as string[];

    const atOther = await request(app.getHttpServer())
      .get('/v1/storefront/account/me')
      .set('x-tenant-domain', OTHER_DOMAIN)
      .set('Cookie', cookie);

    expect(atOther.status).toBe(401);
  });

  it('the same address at two stores is two unrelated accounts', async () => {
    const email = `dora-${RUN}@example.com`;
    await post('/register', { email, password: PASSWORD });
    await post('/register', { email, password: 'clave-en-la-otra-tienda' }, OTHER_DOMAIN);

    // Each password works only at its own store.
    expect((await post('/sign-in', { email, password: PASSWORD })).status).toBe(200);
    expect((await post('/sign-in', { email, password: PASSWORD }, OTHER_DOMAIN)).status).toBe(401);
    expect((await post('/sign-in', { email, password: 'clave-en-la-otra-tienda' }, OTHER_DOMAIN)).status).toBe(200);
  });
});

describe('magic links and password resets', () => {
  it('signs in from a link, and the link works exactly once', async () => {
    const email = `elena-${RUN}@example.com`;
    await post('/register', { email, password: PASSWORD });

    await post('/magic-link', { email });
    const token = lastLinkFor('Tu enlace para entrar');

    const first = await post('/magic-link/consume', { token });
    expect(first.status).toBe(200);
    // Clicking the link proves inbox access, which is what verification
    // proves — so it verifies too, rather than demanding a second click.
    expect(first.body.shopper.emailVerified).toBe(true);

    const replay = await post('/magic-link/consume', { token });
    expect(replay.status).toBe(400);
  });

  it('says nothing about an address with no account', async () => {
    const before = sent.length;
    const res = await post('/magic-link', { email: `fantasma-${RUN}@example.com` });

    expect(res.status).toBe(202);
    expect(sent.length).toBe(before);
  });

  it('a reset closes every other session, which is the point of resetting', async () => {
    const email = `gina-${RUN}@example.com`;
    await post('/register', { email, password: PASSWORD });
    const old = await post('/sign-in', { email, password: PASSWORD });
    const oldCookie = old.headers['set-cookie'] as unknown as string[];

    await post('/password-reset', { email });
    const token = lastLinkFor('Cambia tu contraseña');
    const reset = await post('/password-reset/consume', { token, password: 'una-clave-completamente-nueva' });
    expect(reset.status).toBe(200);

    // The usual reason to reset is that someone else may be in the account.
    // Leaving their session alive would mean the reset changed nothing.
    const stale = await request(app.getHttpServer())
      .get('/v1/storefront/account/me')
      .set('x-tenant-domain', DOMAIN)
      .set('Cookie', oldCookie);
    expect(stale.status).toBe(401);

    expect((await post('/sign-in', { email, password: PASSWORD })).status).toBe(401);
    expect((await post('/sign-in', { email, password: 'una-clave-completamente-nueva' })).status).toBe(200);
  });

  it('refuses a token for the wrong purpose', async () => {
    // A verification link must not be redeemable as a sign-in. It is emailed
    // on registration, before anyone has proven anything.
    const email = `hugo-${RUN}@example.com`;
    await post('/register', { email, password: PASSWORD });
    const verifyToken = lastLinkFor('Confirma tu correo');

    expect((await post('/magic-link/consume', { token: verifyToken })).status).toBe(400);
    expect((await post('/verify-email', { token: verifyToken })).status).toBe(200);
  });

  it('refuses a token minted at another store, and does not burn it', async () => {
    const email = `ines-${RUN}@example.com`;
    await post('/register', { email, password: PASSWORD }, OTHER_DOMAIN);
    await post('/magic-link', { email }, OTHER_DOMAIN);
    const token = lastLinkFor('Tu enlace para entrar');

    expect((await post('/magic-link/consume', { token })).status).toBe(400);

    // The refusal must happen BEFORE the token is spent. Otherwise anyone who
    // learns a link — and links leak, into history and forwarded mail — can
    // burn it by presenting it at a different store, and the owner's own click
    // then fails for no visible reason. The tenant filter belongs on the
    // conditional UPDATE, not only on the read that follows it.
    expect((await post('/magic-link/consume', { token }, OTHER_DOMAIN)).status).toBe(200);
  });
});

describe('signing in keeps the basket', () => {
  it('merges the guest cart into the account and returns it', async () => {
    // The requirement: a shopper who reaches the payment step, remembers they
    // have an account, signs in, and finds an empty cart has been handed a
    // reason to abandon at the last screen.
    const email = `julia-${RUN}@example.com`;
    await post('/register', { email, password: PASSWORD });

    const added = await request(app.getHttpServer())
      .post('/v1/storefront/cart/items')
      .set('x-tenant-domain', DOMAIN)
      .send({ productId, qty: 2 });
    expect(added.status).toBe(201);
    const cartCookie = (added.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('ventia_cart='))!;

    const signedIn = await request(app.getHttpServer())
      .post('/v1/storefront/account/sign-in')
      .set('x-tenant-domain', DOMAIN)
      .set('Cookie', [cartCookie])
      .send({ email, password: PASSWORD });

    expect(signedIn.status).toBe(200);
    expect(signedIn.body.cart.lines).toHaveLength(1);
    expect(signedIn.body.cart.lines[0].qty).toBe(2);
  });

  it('adds the quantities when the shopper had a saved cart too', async () => {
    const email = `karen-${RUN}@example.com`;
    await post('/register', { email, password: PASSWORD });

    // Device one: sign in, then fill a basket that is now attached to the account.
    const first = await post('/sign-in', { email, password: PASSWORD });
    const firstCart = (first.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('ventia_shopper='))!;
    const savedAdd = await request(app.getHttpServer())
      .post('/v1/storefront/cart/items')
      .set('x-tenant-domain', DOMAIN)
      .send({ productId, qty: 3 });
    const savedCartKey = savedAdd.body.cookieKey as string;
    await prisma.cart.updateMany({
      where: { tenantId, cookieKey: savedCartKey },
      data: { shopperAccountId: (await prisma.shopperAccount.findFirstOrThrow({ where: { tenantId, email } })).id },
    });
    expect(firstCart).toBeDefined();

    // Device two: a fresh guest basket, then sign in.
    const guestAdd = await request(app.getHttpServer())
      .post('/v1/storefront/cart/items')
      .set('x-tenant-domain', DOMAIN)
      .send({ productId, qty: 2 });
    const guestCookie = (guestAdd.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('ventia_cart='))!;

    const signedIn = await request(app.getHttpServer())
      .post('/v1/storefront/account/sign-in')
      .set('x-tenant-domain', DOMAIN)
      .set('Cookie', [guestCookie])
      .send({ email, password: PASSWORD });

    expect(signedIn.status).toBe(200);
    // Same product, same (absent) variant: one line, quantities summed.
    expect(signedIn.body.cart.lines).toHaveLength(1);
    expect(signedIn.body.cart.lines[0].qty).toBe(5);
  });

  it('signing in with no cart at all is ordinary, not an error', async () => {
    const email = `luis-${RUN}@example.com`;
    await post('/register', { email, password: PASSWORD });

    const res = await post('/sign-in', { email, password: PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.cart.lines).toEqual([]);
  });
});

describe('order history', () => {
  it('is refused until the address is verified', async () => {
    // The account is linked to a `Customer` by matching email, and that match
    // proves nothing on its own — anyone can register with someone else's
    // address. Verification is what makes the link mean something.
    const email = `marta-${RUN}@example.com`;
    await post('/register', { email, password: PASSWORD });
    const signedIn = await post('/sign-in', { email, password: PASSWORD });
    const cookie = signedIn.headers['set-cookie'] as unknown as string[];

    const res = await request(app.getHttpServer())
      .get('/v1/storefront/account/orders')
      .set('x-tenant-domain', DOMAIN)
      .set('Cookie', cookie);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('EMAIL_NOT_VERIFIED');
  });

  it('shows past guest orders once the address is verified', async () => {
    const email = `nora-${RUN}@example.com`;
    // A guest order first — the person bought before they ever made an account.
    const customer = await prisma.customer.create({ data: { tenantId, email } });
    await prisma.order.create({
      data: {
        tenantId,
        number: 9001,
        reference: `VNT-${RUN}-9001`,
        customerId: customer.id,
        email,
        phone: '3001112233',
        status: 'CONFIRMED',
        paymentStatus: 'PAID',
        shippingAddress: { departamento: 'Bogotá D.C.', municipio: 'Bogotá', linea1: 'Calle 1 #2-3' },
        subtotalCents: 80_000,
        taxCents: 0,
        totalCents: 80_000,
      },
    });

    await post('/register', { email, password: PASSWORD });
    await post('/magic-link', { email });
    const token = lastLinkFor('Tu enlace para entrar');
    const signedIn = await post('/magic-link/consume', { token });
    const cookie = signedIn.headers['set-cookie'] as unknown as string[];

    const res = await request(app.getHttpServer())
      .get('/v1/storefront/account/orders')
      .set('x-tenant-domain', DOMAIN)
      .set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body.orders).toHaveLength(1);
    expect(res.body.orders[0].number).toBe(9001);
  });
});

describe('sign-out', () => {
  it('ends the session, and is a success even without one', async () => {
    const email = `olga-${RUN}@example.com`;
    await post('/register', { email, password: PASSWORD });
    const signedIn = await post('/sign-in', { email, password: PASSWORD });
    const cookie = signedIn.headers['set-cookie'] as unknown as string[];

    const out = await request(app.getHttpServer())
      .post('/v1/storefront/account/sign-out')
      .set('x-tenant-domain', DOMAIN)
      .set('Cookie', cookie);
    expect(out.status).toBe(204);

    const after = await request(app.getHttpServer())
      .get('/v1/storefront/account/me')
      .set('x-tenant-domain', DOMAIN)
      .set('Cookie', cookie);
    expect(after.status).toBe(401);

    // Signing out twice reaches the same desired state.
    expect((await post('/sign-out', {})).status).toBe(204);
  });
});

describe('PATCH /me', () => {
  /** A signed-in shopper at DOMAIN, and the cookie jar for their session. */
  async function signedInShopper(local: string) {
    const email = `${local}-${RUN}@example.com`;
    await post('/register', { email, password: PASSWORD, name: 'Nombre viejo' });
    const res = await post('/sign-in', { email, password: PASSWORD });
    return { email, cookie: res.headers['set-cookie'] as unknown as string[] };
  }

  function patchMe(cookie: string[], body: unknown, domain = DOMAIN) {
    return request(app.getHttpServer())
      .patch('/v1/storefront/account/me')
      .set('x-tenant-domain', domain)
      .set('Cookie', cookie)
      .send(body);
  }

  it('renames the account and answers with the updated profile', async () => {
    const { cookie } = await signedInShopper('perfil-ok');

    const res = await patchMe(cookie, { name: 'Nombre nuevo' });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Nombre nuevo');
    // And it persisted, rather than only being echoed back.
    const me = await request(app.getHttpServer())
      .get('/v1/storefront/account/me')
      .set('x-tenant-domain', DOMAIN)
      .set('Cookie', cookie);
    expect(me.body.name).toBe('Nombre nuevo');
  });

  it('clears the name when it is sent as null, and leaves it alone when absent', async () => {
    const { cookie } = await signedInShopper('perfil-null');

    expect((await patchMe(cookie, { name: null })).body.name).toBeNull();
    // An empty body is a no-op, NOT a clear: `name === undefined` writes
    // nothing. The distinction matters because a form that only submits
    // changed fields sends `{}` for "I changed nothing".
    await patchMe(cookie, { name: 'Carmen' });
    expect((await patchMe(cookie, {})).body.name).toBe('Carmen');
  });

  it('rejects a name past the schema bound rather than truncating it', async () => {
    const { cookie } = await signedInShopper('perfil-largo');
    expect((await patchMe(cookie, { name: 'x'.repeat(121) })).status).toBe(400);
    // Whitespace-only trims to empty, which the schema's `min(1)` refuses —
    // otherwise a review would be signed by a blank author.
    expect((await patchMe(cookie, { name: '   ' })).status).toBe(400);
  });

  it('needs a session', async () => {
    expect((await patchMe([], { name: 'Nadie' })).status).toBe(401);
  });

  /**
   * The reason `tenantId` is in the WHERE of the update and not a check on the
   * row that comes back.
   *
   * A session issued by one store, presented at another, must not reach the
   * account at all. `ShopperSessionGuard` is the first line and refuses it here
   * — but this asserts the OUTCOME (the name at the first store is untouched),
   * so the test still fails if a future refactor loosens the guard and leaves
   * the service as the only thing scoping the write.
   */
  it('cannot be used to rename an account through another store', async () => {
    const { cookie } = await signedInShopper('perfil-cruzado');
    await patchMe(cookie, { name: 'Original' });

    const cross = await patchMe(cookie, { name: 'Secuestrado' }, OTHER_DOMAIN);
    expect(cross.status).toBe(401);

    const me = await request(app.getHttpServer())
      .get('/v1/storefront/account/me')
      .set('x-tenant-domain', DOMAIN)
      .set('Cookie', cookie);
    expect(me.body.name).toBe('Original');
  });

  /**
   * The same property, asserted one layer down.
   *
   * The HTTP test above passes whether or not the service filters by tenant,
   * because the guard answers 401 first — which makes it a test of the guard,
   * not of the write. This calls the service directly with a mismatched tenant,
   * so the `tenantId` in the update's WHERE is the only thing that can refuse
   * it. Delete that filter and this test fails; delete the guard and the test
   * above passes anyway. Both layers need their own.
   */
  it('refuses a mismatched tenant at the service, not only at the guard', async () => {
    const { email } = await signedInShopper('perfil-servicio');
    const account = await prisma.shopperAccount.findFirstOrThrow({ where: { tenantId, email } });
    const { ShopperAuthService } = await import('../src/shopper/shopper-auth.service');
    const auth = app.get(ShopperAuthService);

    await expect(auth.updateProfile(otherTenantId, account.id, 'Secuestrado')).rejects.toThrow();

    const after = await prisma.shopperAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(after.name).toBe('Nombre viejo');
  });
});
