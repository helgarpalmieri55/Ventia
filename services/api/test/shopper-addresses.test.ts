import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient as PrismaClientType } from '@ventia/db';
import { startTestDb } from './helpers';
import { MAILER, type MailMessage } from '../src/mailer/mailer';

/**
 * Saved addresses and the wishlist.
 *
 * The property that carries this file: RLS isolates by TENANT, and two
 * shoppers of the same store are the same tenant. So nothing the database does
 * keeps one shopper out of the other's home address — only the `accountId`
 * filter in every query does, and a test suite that checked cross-STORE
 * isolation and stopped would miss exactly the case that matters.
 */

const RUN = Date.now().toString(36);
const DOMAIN = `addr-${RUN}.ventia.localhost`;
const PASSWORD = 'una-contraseña-larga';

const ADDRESS = {
  nombreCompleto: 'Ana María Gómez',
  telefono: '3001112233',
  departamentoCode: '11',
  // Exactly as `colombia-locations.ts` spells it, comma included — the
  // cross-field refinement matches on the name, so a near-miss is a 400.
  municipioName: 'Bogotá, D.C.',
  direccion: 'Carrera 7 # 71-52',
};

let db: Awaited<ReturnType<typeof startTestDb>>;
let prisma: PrismaClientType;
let app: INestApplication;
let tenantId: string;
let productId: string;
let archivedProductId: string;

beforeAll(async () => {
  db = await startTestDb();
  process.env.DATABASE_URL = db.url;
  process.env.REDIS_URL = 'redis://localhost:6379';

  const { createApp } = await import('../src/main');
  app = await createApp();
  vi.spyOn(app.get(MAILER), 'send').mockImplementation(async (_msg: MailMessage) => undefined);
  await app.init();
  ({ platformDb: prisma } = await import('@ventia/db'));

  const tenant = await prisma.tenant.create({
    data: { slug: `addr-${RUN}`, name: 'Tienda Direcciones', status: 'live' },
  });
  tenantId = tenant.id;
  await prisma.tenantDomain.create({ data: { tenantId, domain: DOMAIN, isPrimary: true } });

  const product = await prisma.product.create({
    data: { tenantId, name: 'Camisa', slug: 'camisa', priceCents: 80_000, status: 'active' },
  });
  productId = product.id;
  const archived = await prisma.product.create({
    data: { tenantId, name: 'Descontinuada', slug: 'descontinuada', priceCents: 50_000, status: 'archived' },
  });
  archivedProductId = archived.id;
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
  await db.stop();
});

/** Registers a shopper and returns their session cookie. */
async function signUp(email: string): Promise<string[]> {
  const server = app.getHttpServer();
  await request(server).post('/v1/storefront/account/register').set('x-tenant-domain', DOMAIN)
    .send({ email, password: PASSWORD });
  const res = await request(server).post('/v1/storefront/account/sign-in').set('x-tenant-domain', DOMAIN)
    .send({ email, password: PASSWORD });
  return res.headers['set-cookie'] as unknown as string[];
}

function as(cookie: string[]) {
  const server = app.getHttpServer();
  const base = (method: 'get' | 'post' | 'patch' | 'delete', path: string) =>
    request(server)[method](`/v1/storefront/account${path}`).set('x-tenant-domain', DOMAIN).set('Cookie', cookie);
  return {
    get: (p: string) => base('get', p),
    post: (p: string) => base('post', p),
    patch: (p: string) => base('patch', p),
    del: (p: string) => base('delete', p),
  };
}

describe('saved addresses', () => {
  it('makes the FIRST address the default, whatever was asked for', async () => {
    // A shopper with one saved address and no default sees a checkout that
    // pre-fills nothing while showing them an address they already gave us,
    // which reads as the feature being broken.
    const shopper = as(await signUp(`ana-${RUN}@example.com`));

    const created = await shopper.post('/addresses').send({ address: ADDRESS });

    expect(created.status).toBe(201);
    expect(created.body.isDefault).toBe(true);
  });

  it('keeps at most one default, and clears the old one when promoting', async () => {
    const shopper = as(await signUp(`beto-${RUN}@example.com`));
    const first = await shopper.post('/addresses').send({ address: ADDRESS, label: 'Casa' });
    const second = await shopper.post('/addresses').send({ address: ADDRESS, label: 'Oficina' });

    // Asking for a second default must not fail on the partial unique index —
    // clear-then-set, in that order.
    expect(second.status).toBe(201);

    const promoted = await shopper.post(`/addresses/${first.body.id}/default`).send({});
    expect(promoted.status).toBe(200);

    const list = await shopper.get('/addresses');
    const defaults = list.body.addresses.filter((a: { isDefault: boolean }) => a.isDefault);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].id).toBe(first.body.id);
    // Default first, so the list agrees with what checkout will do.
    expect(list.body.addresses[0].id).toBe(first.body.id);
  });

  it('accepts a SECOND address that asks to be the default', async () => {
    // The case that hits the partial unique index head-on: creating with
    // `isDefault` while another default already exists. The old one has to be
    // cleared first, in that order — setting first violates the index and the
    // shopper gets a 500 for a perfectly ordinary request.
    const shopper = as(await signUp(`nora-${RUN}@example.com`));
    const first = await shopper.post('/addresses').send({ address: ADDRESS, label: 'Casa' });
    expect(first.body.isDefault).toBe(true);

    const second = await shopper.post('/addresses').send({ address: ADDRESS, label: 'Oficina', isDefault: true });

    expect(second.status).toBe(201);
    expect(second.body.isDefault).toBe(true);

    const list = await shopper.get('/addresses');
    expect(list.body.addresses.filter((a: { isDefault: boolean }) => a.isDefault)).toHaveLength(1);
    expect(list.body.addresses[0].label).toBe('Oficina');
  });

  it('does NOT promote another address when the default is deleted', async () => {
    // Silently anointing whichever address is next would pre-fill checkout
    // with one the shopper did not choose, and the failure is a parcel sent to
    // the wrong place — worse than an empty form.
    const shopper = as(await signUp(`carla-${RUN}@example.com`));
    const first = await shopper.post('/addresses').send({ address: ADDRESS });
    await shopper.post('/addresses').send({ address: ADDRESS });

    expect((await shopper.del(`/addresses/${first.body.id}`)).status).toBe(204);

    const list = await shopper.get('/addresses');
    expect(list.body.addresses).toHaveLength(1);
    expect(list.body.addresses[0].isDefault).toBe(false);
  });

  it('one shopper cannot see, edit or delete another shopper\'s address IN THE SAME STORE', async () => {
    // RLS cannot help here — both rows belong to the same tenant. This is the
    // case a cross-store isolation test would miss entirely.
    const mine = as(await signUp(`dora-${RUN}@example.com`));
    const theirs = as(await signUp(`elena-${RUN}@example.com`));

    const hers = await theirs.post('/addresses').send({ address: ADDRESS, label: 'Suya' });
    expect(hers.status).toBe(201);

    expect((await mine.get('/addresses')).body.addresses).toHaveLength(0);
    // 404 and not 403: a probe must not be able to tell "not yours" from
    // "does not exist".
    expect((await mine.patch(`/addresses/${hers.body.id}`).send({ label: 'Robada' })).status).toBe(404);
    expect((await mine.post(`/addresses/${hers.body.id}/default`).send({})).status).toBe(404);
    expect((await mine.del(`/addresses/${hers.body.id}`)).status).toBe(404);

    // ...and hers is untouched.
    const stillHers = await theirs.get('/addresses');
    expect(stillHers.body.addresses[0].label).toBe('Suya');
  });

  it('refuses an address whose municipio is not in its departamento', async () => {
    // The same cross-field rule checkout enforces, because a saved address
    // that cannot be checked out with is worse than no saved address.
    const shopper = as(await signUp(`fabio-${RUN}@example.com`));

    const res = await shopper.post('/addresses').send({
      address: { ...ADDRESS, departamentoCode: '05', municipioName: 'Bogotá, D.C.' },
    });

    expect(res.status).toBe(400);
  });

  it('requires a session', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/storefront/account/addresses')
      .set('x-tenant-domain', DOMAIN);
    expect(res.status).toBe(401);
  });
});

describe('wishlist', () => {
  it('saves a product, and saving it twice is not an error', async () => {
    // A double-tapped heart is not a problem the UI should have to explain.
    const shopper = as(await signUp(`gina-${RUN}@example.com`));

    expect((await shopper.post('/wishlist').send({ productId })).status).toBe(204);
    expect((await shopper.post('/wishlist').send({ productId })).status).toBe(204);

    const list = await shopper.get('/wishlist');
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].productId).toBe(productId);
    expect(list.body.items[0].available).toBe(true);
  });

  it('keeps an archived product in the list, marked unavailable', async () => {
    // The shopper put it there deliberately. A list that silently loses
    // entries reads as data loss, not as a sold-out sign.
    const shopper = as(await signUp(`hugo-${RUN}@example.com`));
    await shopper.post('/wishlist').send({ productId: archivedProductId });

    const list = await shopper.get('/wishlist');
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].available).toBe(false);
  });

  it('404s a product from another store rather than failing on the foreign key', async () => {
    // Foreign keys are not subject to RLS, so without the explicit tenant
    // check this would surface as a 500 instead of the honest answer.
    const other = await prisma.tenant.create({
      data: { slug: `addr-other-${RUN}`, name: 'Otra', status: 'live' },
    });
    const foreign = await prisma.product.create({
      data: { tenantId: other.id, name: 'Ajeno', slug: 'ajeno', priceCents: 1000, status: 'active' },
    });
    const shopper = as(await signUp(`ines-${RUN}@example.com`));

    const res = await shopper.post('/wishlist').send({ productId: foreign.id });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('PRODUCT_NOT_FOUND');
  });

  it('one shopper cannot see another\'s wishlist in the same store', async () => {
    const mine = as(await signUp(`julia-${RUN}@example.com`));
    const theirs = as(await signUp(`karen-${RUN}@example.com`));
    await theirs.post('/wishlist').send({ productId });

    expect((await mine.get('/wishlist')).body.items).toHaveLength(0);
  });

  it('removing is idempotent', async () => {
    const shopper = as(await signUp(`luis-${RUN}@example.com`));
    await shopper.post('/wishlist').send({ productId });

    expect((await shopper.del(`/wishlist/${productId}`)).status).toBe(204);
    expect((await shopper.del(`/wishlist/${productId}`)).status).toBe(204);
    expect((await shopper.get('/wishlist')).body.items).toHaveLength(0);
  });
});
