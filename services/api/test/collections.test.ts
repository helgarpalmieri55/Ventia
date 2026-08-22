import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

/** Per-run domain suffix. `DomainResolver` caches domain → tenant in Redis;
 * this suite gets a fresh Redis container so the cache starts empty, but the
 * suffix also keeps two files that happen to pick the same store name from
 * colliding on the unique `TenantDomain.domain` index. */
const RUN = Date.now().toString(36);
const SHOP_DOMAIN = `sf-col-${RUN}.ventia.localhost`;
const DRAFT_DOMAIN = `sf-col-draft-${RUN}.ventia.localhost`;

/** The tenant every admin test drives, and the one the storefront reads. */
let cookie: string;
let tenantId: string;

/** A second tenant, used only to prove that its ids are invisible here. */
let otherCookie: string;
let otherTenantId: string;

const server = () => app.getHttpServer();

async function makeProduct(
  ownerTenantId: string,
  name: string,
  status: 'draft' | 'active' | 'archived' = 'active',
): Promise<string> {
  const product = await platformDb.product.create({
    data: {
      tenantId: ownerTenantId,
      name,
      slug: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Math.random().toString(36).slice(2, 8)}`,
      priceCents: 45900,
      status,
    },
  });
  return product.id;
}

beforeAll(async () => {
  db = await startTestDb();
  redisContainer = await new GenericContainer('redis:7-alpine')
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
    .start();

  // Env before the first import of @ventia/db / ../src/main: both build their
  // clients at module-evaluation time (same pattern as categories.test.ts).
  process.env.DATABASE_URL = db.url;
  process.env.REDIS_URL = `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`;

  const { createApp } = await import('../src/main');
  app = await createApp();
  await app.init();

  ({ signUpWithTenant } = await import('./admin-helpers'));
  ({ platformDb } = await import('@ventia/db'));

  ({ cookie, tenantId } = await signUpWithTenant(`col-owner-${RUN}@demo.co`, 'owner'));
  ({ cookie: otherCookie, tenantId: otherTenantId } = await signUpWithTenant(`col-rival-${RUN}@demo.co`, 'owner'));
  await platformDb.tenantDomain.create({ data: { tenantId, domain: SHOP_DOMAIN, isPrimary: true } });
});

afterAll(async () => {
  await app.close();
  await redisContainer.stop();
  await db.stop();
});

describe('/v1/admin/collections', () => {
  it('derives a slug, appends new collections after the existing ones, and dedupes a taken slug', async () => {
    const nuevos = await request(server())
      .post('/v1/admin/collections')
      .set('cookie', cookie)
      .send({ name: '¡Nuevos!' });
    expect(nuevos.status).toBe(201);
    expect(nuevos.body).toMatchObject({ slug: 'nuevos', position: 0, isActive: true, descriptionMd: '' });
    expect(nuevos.body.products).toEqual([]);

    // Appended, not prepended: a new collection must never push itself above
    // the strips the merchant already arranged.
    const ofertas = await request(server())
      .post('/v1/admin/collections')
      .set('cookie', cookie)
      .send({ name: 'Ofertas', descriptionMd: 'Hasta agotar existencias' });
    expect(ofertas.status).toBe(201);
    expect(ofertas.body).toMatchObject({ slug: 'ofertas', position: 1 });

    // An explicit slug that is taken is deduped on CREATE (never refused) —
    // the merchant has published nothing yet, so `-2` costs them nothing.
    const clash = await request(server())
      .post('/v1/admin/collections')
      .set('cookie', cookie)
      .send({ name: 'Ofertas de invierno', slug: 'ofertas' });
    expect(clash.status).toBe(201);
    expect(clash.body.slug).toBe('ofertas-2');

    // A name `slugify` reduces to nothing would publish a collection whose
    // URL has no last segment.
    const unnameable = await request(server())
      .post('/v1/admin/collections')
      .set('cookie', cookie)
      .send({ name: '✨✨' });
    expect(unnameable.status).toBe(400);
    expect(unnameable.body.error).toBe('VALIDATION_FAILED');

    // A hand-typed slug that would break the URL is refused by the schema.
    const badSlug = await request(server())
      .post('/v1/admin/collections')
      .set('cookie', cookie)
      .send({ name: 'Ropa de verano', slug: 'Ropa de Verano' });
    expect(badSlug.status).toBe(400);
    expect(badSlug.body.error).toBe('VALIDATION_FAILED');

    await request(server()).delete(`/v1/admin/collections/${clash.body.id}`).set('cookie', cookie).expect(204);
  });

  it('lists by position then name, with both product counts', async () => {
    const list = await request(server()).get('/v1/admin/collections').set('cookie', cookie);
    expect(list.status).toBe(200);
    expect(list.body.map((c: { name: string }) => c.name)).toEqual(['¡Nuevos!', 'Ofertas']);
    expect(list.body[0]).toMatchObject({ productCount: 0, activeProductCount: 0 });
  });

  it('never moves the collection when only its name changes, and refuses a taken slug on update', async () => {
    const created = await request(server())
      .post('/v1/admin/collections')
      .set('cookie', cookie)
      .send({ name: 'Rebajas' });
    const id = created.body.id as string;
    expect(created.body.slug).toBe('rebajas');

    // THE rule: a live storefront links to /rebajas. Renaming must not move it.
    const renamed = await request(server())
      .patch(`/v1/admin/collections/${id}`)
      .set('cookie', cookie)
      .send({ name: 'Rebajas de fin de temporada' });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ name: 'Rebajas de fin de temporada', slug: 'rebajas' });

    // Moving it is possible, but only by asking for it explicitly...
    const moved = await request(server())
      .patch(`/v1/admin/collections/${id}`)
      .set('cookie', cookie)
      .send({ slug: 'fin-de-temporada' });
    expect(moved.status).toBe(200);
    expect(moved.body.slug).toBe('fin-de-temporada');

    // ...and an explicit slug is a precise request, so a collision is a 409
    // rather than the silent `-2` that create would have applied.
    const taken = await request(server())
      .patch(`/v1/admin/collections/${id}`)
      .set('cookie', cookie)
      .send({ slug: 'ofertas' });
    expect(taken.status).toBe(409);
    expect(taken.body).toEqual({ error: 'SLUG_TAKEN' });

    const hidden = await request(server())
      .patch(`/v1/admin/collections/${id}`)
      .set('cookie', cookie)
      .send({ isActive: false });
    expect(hidden.body.isActive).toBe(false);

    await request(server()).delete(`/v1/admin/collections/${id}`).set('cookie', cookie).expect(204);
    await request(server()).get(`/v1/admin/collections/${id}`).set('cookie', cookie).expect(404);
  });

  it('answers 404 for a malformed id, an unknown id, and another tenant’s collection', async () => {
    await request(server()).get('/v1/admin/collections/not-a-uuid').set('cookie', cookie).expect(404);
    await request(server())
      .get('/v1/admin/collections/11111111-1111-4111-8111-111111111111')
      .set('cookie', cookie)
      .expect(404);

    const theirs = await request(server())
      .post('/v1/admin/collections')
      .set('cookie', otherCookie)
      .send({ name: 'Ajena' });
    expect(theirs.status).toBe(201);
    await request(server()).get(`/v1/admin/collections/${theirs.body.id}`).set('cookie', cookie).expect(404);
    await request(server())
      .put(`/v1/admin/collections/${theirs.body.id}/products`)
      .set('cookie', cookie)
      .send({ productIds: [] })
      .expect(404);
  });

  it('requires a session', async () => {
    await request(server()).get('/v1/admin/collections').expect(401);
  });
});

describe('/v1/admin/collections/:id/products', () => {
  let collectionId: string;
  let camisa: string;
  let vestido: string;
  let saco: string;

  beforeAll(async () => {
    const created = await request(server())
      .post('/v1/admin/collections')
      .set('cookie', cookie)
      .send({ name: 'Curada' });
    collectionId = created.body.id;
    camisa = await makeProduct(tenantId, 'Camisa');
    vestido = await makeProduct(tenantId, 'Vestido');
    saco = await makeProduct(tenantId, 'Saco');
  });

  it('appends on POST, skips ids already in the collection, and keeps their position', async () => {
    const first = await request(server())
      .post(`/v1/admin/collections/${collectionId}/products`)
      .set('cookie', cookie)
      .send({ productIds: [camisa, vestido] });
    expect(first.status).toBe(200);
    expect(first.body.products.map((p: { productId: string }) => p.productId)).toEqual([camisa, vestido]);
    expect(first.body.products.map((p: { position: number }) => p.position)).toEqual([0, 1]);

    // `camisa` is already first; re-sending it must not drag it to the bottom.
    const second = await request(server())
      .post(`/v1/admin/collections/${collectionId}/products`)
      .set('cookie', cookie)
      .send({ productIds: [camisa, saco] });
    expect(second.status).toBe(200);
    expect(second.body.products.map((p: { productId: string }) => p.productId)).toEqual([camisa, vestido, saco]);
    expect(second.body.products.map((p: { position: number }) => p.position)).toEqual([0, 1, 2]);
  });

  it('reorders the whole strip in one PUT, and drops what the array omits', async () => {
    const reordered = await request(server())
      .put(`/v1/admin/collections/${collectionId}/products`)
      .set('cookie', cookie)
      .send({ productIds: [saco, camisa] });
    expect(reordered.status).toBe(200);
    expect(reordered.body.products.map((p: { productId: string }) => p.productId)).toEqual([saco, camisa]);
    expect(reordered.body.products.map((p: { position: number }) => p.position)).toEqual([0, 1]);
    expect(reordered.body.productCount).toBe(2);

    // Emptying a collection is not the same request as deleting it: the name,
    // the slug every link points at, and the description all survive.
    const emptied = await request(server())
      .put(`/v1/admin/collections/${collectionId}/products`)
      .set('cookie', cookie)
      .send({ productIds: [] });
    expect(emptied.status).toBe(200);
    expect(emptied.body.products).toEqual([]);
    expect(emptied.body.name).toBe('Curada');

    await request(server())
      .put(`/v1/admin/collections/${collectionId}/products`)
      .set('cookie', cookie)
      .send({ productIds: [camisa, vestido, saco] })
      .expect(200);
  });

  it('removes one product idempotently, without renumbering the survivors', async () => {
    await request(server())
      .delete(`/v1/admin/collections/${collectionId}/products/${vestido}`)
      .set('cookie', cookie)
      .expect(204);

    const after = await request(server()).get(`/v1/admin/collections/${collectionId}`).set('cookie', cookie);
    expect(after.body.products.map((p: { productId: string }) => p.productId)).toEqual([camisa, saco]);
    // The gap is deliberate: 0, 2 orders exactly like 0, 1.
    expect(after.body.products.map((p: { position: number }) => p.position)).toEqual([0, 2]);

    // Already gone is the state the caller asked for.
    await request(server())
      .delete(`/v1/admin/collections/${collectionId}/products/${vestido}`)
      .set('cookie', cookie)
      .expect(204);
  });

  it('rejects a repeated id, an id from another store, and a malformed one', async () => {
    const repeated = await request(server())
      .put(`/v1/admin/collections/${collectionId}/products`)
      .set('cookie', cookie)
      .send({ productIds: [camisa, camisa] });
    expect(repeated.status).toBe(400);
    expect(repeated.body.error).toBe('VALIDATION_FAILED');

    const rival = await makeProduct(otherTenantId, 'Producto ajeno');
    const foreign = await request(server())
      .put(`/v1/admin/collections/${collectionId}/products`)
      .set('cookie', cookie)
      .send({ productIds: [camisa, rival] });
    expect(foreign.status).toBe(400);
    expect(foreign.body.details).toEqual({ productIds: 'producto inexistente' });

    // ...and the failed write left the existing membership untouched.
    const untouched = await request(server()).get(`/v1/admin/collections/${collectionId}`).set('cookie', cookie);
    expect(untouched.body.products.map((p: { productId: string }) => p.productId)).toEqual([camisa, saco]);

    await request(server())
      .post(`/v1/admin/collections/${collectionId}/products`)
      .set('cookie', cookie)
      .send({ productIds: ['not-a-uuid'] })
      .expect(400);

    // An empty append is a client bug, not a no-op worth answering 200 to.
    await request(server())
      .post(`/v1/admin/collections/${collectionId}/products`)
      .set('cookie', cookie)
      .send({ productIds: [] })
      .expect(400);
  });

  it('keeps archived members visible to the merchant, with their status', async () => {
    await platformDb.product.update({ where: { id: saco }, data: { status: 'archived' } });

    const detail = await request(server()).get(`/v1/admin/collections/${collectionId}`).set('cookie', cookie);
    expect(detail.body.products.map((p: { status: string }) => p.status)).toEqual(['active', 'archived']);
    // The two counts are what let the admin explain a strip the shopper
    // cannot see.
    expect(detail.body).toMatchObject({ productCount: 2, activeProductCount: 1 });

    await platformDb.product.update({ where: { id: saco }, data: { status: 'active' } });
  });

  it('drops the membership row when the product itself is deleted, and keeps products when the collection goes', async () => {
    const efimero = await makeProduct(tenantId, 'Efímero');
    await request(server())
      .post(`/v1/admin/collections/${collectionId}/products`)
      .set('cookie', cookie)
      .send({ productIds: [efimero] })
      .expect(200);

    await platformDb.product.delete({ where: { id: efimero } });
    const afterDelete = await request(server()).get(`/v1/admin/collections/${collectionId}`).set('cookie', cookie);
    expect(afterDelete.body.products.map((p: { productId: string }) => p.productId)).not.toContain(efimero);

    await request(server()).delete(`/v1/admin/collections/${collectionId}`).set('cookie', cookie).expect(204);
    // Deleting a collection is not deleting a catalog.
    expect(await platformDb.product.findUnique({ where: { id: camisa } })).not.toBeNull();
  });
});

describe('GET /v1/storefront/collections', () => {
  let novedades: string;
  let visible: string;
  let archivado: string;

  beforeAll(async () => {
    // Everything the admin suite above left behind is either deleted or
    // empty; these are the rows this suite asserts on.
    visible = await makeProduct(tenantId, 'Camiseta blanca');
    archivado = await makeProduct(tenantId, 'Camiseta agotada', 'archived');
    const borrador = await makeProduct(tenantId, 'Camiseta sin publicar', 'draft');

    const created = await request(server())
      .post('/v1/admin/collections')
      .set('cookie', cookie)
      .send({ name: 'Novedades', position: 0 });
    novedades = created.body.id;
    await request(server())
      .put(`/v1/admin/collections/${novedades}/products`)
      .set('cookie', cookie)
      .send({ productIds: [archivado, visible, borrador] })
      .expect(200);
  });

  it('returns only active collections, only buyable products, in the merchant’s order', async () => {
    const res = await request(server()).get('/v1/storefront/collections').set('x-tenant-domain', SHOP_DOMAIN);
    expect(res.status).toBe(200);

    const strip = res.body.find((c: { slug: string }) => c.slug === 'novedades');
    expect(strip).toBeDefined();
    // The archived and draft members are curated (the admin still lists them)
    // but a shopper must never see a strip advertising something unbuyable.
    expect(strip.products.map((p: { name: string }) => p.name)).toEqual(['Camiseta blanca']);
    expect(strip.products[0].id).toBe(visible);
    expect(strip.products[0]).toMatchObject({ priceCents: 45900, inStock: false, thumbnailUrl: null });
    // Nothing renders it, so it is deliberately not in the payload.
    expect(strip.descriptionMd).toBeUndefined();
  });

  it('omits a hidden collection, an empty one, and one whose every product is archived', async () => {
    const oculta = await request(server())
      .post('/v1/admin/collections')
      .set('cookie', cookie)
      .send({ name: 'Oculta', isActive: false });
    await request(server())
      .put(`/v1/admin/collections/${oculta.body.id}/products`)
      .set('cookie', cookie)
      .send({ productIds: [visible] })
      .expect(200);

    const vacia = await request(server())
      .post('/v1/admin/collections')
      .set('cookie', cookie)
      .send({ name: 'Vacía' });

    const soloArchivados = await request(server())
      .post('/v1/admin/collections')
      .set('cookie', cookie)
      .send({ name: 'Temporada pasada' });
    await request(server())
      .put(`/v1/admin/collections/${soloArchivados.body.id}/products`)
      .set('cookie', cookie)
      .send({ productIds: [archivado] })
      .expect(200);

    const res = await request(server()).get('/v1/storefront/collections').set('x-tenant-domain', SHOP_DOMAIN);
    const slugs = res.body.map((c: { slug: string }) => c.slug);
    expect(slugs).toContain('novedades');
    expect(slugs).not.toContain('oculta');
    expect(slugs).not.toContain('vacia');
    // A heading over blank space reads as a broken page — the strip is gone,
    // not empty.
    expect(slugs).not.toContain('temporada-pasada');

    await request(server()).delete(`/v1/admin/collections/${oculta.body.id}`).set('cookie', cookie).expect(204);
    await request(server()).delete(`/v1/admin/collections/${vacia.body.id}`).set('cookie', cookie).expect(204);
    await request(server())
      .delete(`/v1/admin/collections/${soloArchivados.body.id}`)
      .set('cookie', cookie)
      .expect(204);
  });

  it('caps one strip at twelve products', async () => {
    const many: string[] = [];
    for (let i = 0; i < 13; i++) many.push(await makeProduct(tenantId, `Serie ${String(i).padStart(2, '0')}`));
    const grande = await request(server())
      .post('/v1/admin/collections')
      .set('cookie', cookie)
      .send({ name: 'Catálogo entero' });
    await request(server())
      .put(`/v1/admin/collections/${grande.body.id}/products`)
      .set('cookie', cookie)
      .send({ productIds: many })
      .expect(200);

    const res = await request(server()).get('/v1/storefront/collections').set('x-tenant-domain', SHOP_DOMAIN);
    const strip = res.body.find((c: { slug: string }) => c.slug === 'catalogo-entero');
    expect(strip.products).toHaveLength(12);

    await request(server()).delete(`/v1/admin/collections/${grande.body.id}`).set('cookie', cookie).expect(204);
  });

  it('is behind the public tenant guard: an unlaunched store looks like no store at all', async () => {
    const draft = await platformDb.tenant.create({
      data: { slug: `col-draft-${RUN}`, name: 'Borrador', status: 'draft' },
    });
    await platformDb.tenantDomain.create({ data: { tenantId: draft.id, domain: DRAFT_DOMAIN, isPrimary: true } });
    const collection = await platformDb.collection.create({
      data: { tenantId: draft.id, name: 'Nuevos', slug: 'nuevos' },
    });
    const product = await platformDb.product.create({
      data: { tenantId: draft.id, name: 'Camisa', slug: 'camisa', priceCents: 1000, status: 'active' },
    });
    await platformDb.collectionProduct.create({
      data: { tenantId: draft.id, collectionId: collection.id, productId: product.id, position: 0 },
    });

    const res = await request(server()).get('/v1/storefront/collections').set('x-tenant-domain', DRAFT_DOMAIN);
    expect(res.status).toBe(404);
  });
});
