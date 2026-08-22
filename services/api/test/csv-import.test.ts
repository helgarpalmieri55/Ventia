import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient as PrismaClientType } from '@ventia/db';
import { startTestDb } from './helpers';
import type { signUpWithTenant as SignUpWithTenant } from './admin-helpers';
import { parseProductsCsv } from '../src/csv-import/csv-parser';

const TEMPLATE_HEADER =
  'name,slug,description,price_cents,compare_at_cents,sku,barcode,stock,track_inventory,tax_rate,status,categories,image_urls';

function row(fields: Record<string, string>): string {
  const cols = TEMPLATE_HEADER.split(',');
  return cols.map((c) => fields[c] ?? '').join(',');
}

function csvOf(...rows: Array<Record<string, string>>): string {
  return [TEMPLATE_HEADER, ...rows.map(row)].join('\n');
}

// ---------------------------------------------------------------------------
// Pure parser unit tests (no DB / no app needed)
// ---------------------------------------------------------------------------
describe('parseProductsCsv', () => {
  it('parses a valid happy-path row: coercions, defaults, pipe-separated categories/images', () => {
    const csv = csvOf({
      name: 'Camiseta Básica',
      price_cents: '4590000',
      sku: 'CAM-001',
      stock: '10',
      track_inventory: 'true',
      tax_rate: '19',
      status: 'active',
      categories: 'Camisetas|Ropa',
      image_urls: 'https://example.com/a.jpg|https://example.com/b.jpg',
    });

    const { rows, errors } = parseProductsCsv(csv);

    expect(errors).toEqual([]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      row: 1,
      name: 'Camiseta Básica',
      priceCents: 4_590_000,
      sku: 'CAM-001',
      stock: 10,
      trackInventory: true,
      taxRate: '19',
      status: 'active',
      categoryNames: ['Camisetas', 'Ropa'],
      imageUrls: ['https://example.com/a.jpg', 'https://example.com/b.jpg'],
      descriptionMd: '',
    });
    // Every optional column that has a create-time default was explicitly
    // provided here, so `provided` should be all true — see the PATCH-like
    // update-semantics test below for the all-blank counterpart.
    expect(rows[0].provided).toEqual({
      descriptionMd: false, // description column itself was left blank
      stock: true,
      trackInventory: true,
      taxRate: true,
      status: true,
      categoryNames: true,
      imageUrls: true,
    });
  });

  it('applies defaults when optional columns are blank: stock 0, trackInventory true, taxRate 19, status draft', () => {
    const csv = csvOf({ name: 'Producto Minimo', price_cents: '1000', sku: 'MIN-1' });
    const { rows, errors } = parseProductsCsv(csv);

    expect(errors).toEqual([]);
    expect(rows[0]).toMatchObject({
      stock: 0,
      trackInventory: true,
      taxRate: '19',
      status: 'draft',
      categoryNames: [],
      imageUrls: [],
    });
    // `provided` distinguishes "defaulted because blank" from "explicitly
    // set to the default value" — the commit path's PATCH-like update
    // semantics depend on this (csv-import.service.ts).
    expect(rows[0].provided).toEqual({
      descriptionMd: false,
      stock: false,
      trackInventory: false,
      taxRate: false,
      status: false,
      categoryNames: false,
      imageUrls: false,
    });
  });

  it('reports a Spanish error with the correct row number for a bad tax_rate', () => {
    const csv = csvOf(
      { name: 'Producto Uno', price_cents: '1000', sku: 'SKU-1' },
      { name: 'Producto Dos', price_cents: '1000', sku: 'SKU-2', tax_rate: '99' },
    );
    const { rows, errors } = parseProductsCsv(csv);

    expect(rows).toHaveLength(1);
    expect(errors).toEqual([
      { row: 2, column: 'tax_rate', message: 'tax_rate debe ser 0, 5, 19 o excluido' },
    ]);
  });

  it('reports a Spanish error for a negative price_cents', () => {
    const csv = csvOf({ name: 'Producto Negativo', price_cents: '-500', sku: 'SKU-NEG' });
    const { errors } = parseProductsCsv(csv);

    expect(errors).toEqual([
      { row: 1, column: 'price_cents', message: 'price_cents debe ser un entero en centavos' },
    ]);
  });

  it('reports a Spanish error for a non-integer price_cents', () => {
    const csv = csvOf({ name: 'Producto Decimal', price_cents: '10.5', sku: 'SKU-DEC' });
    const { errors } = parseProductsCsv(csv);

    expect(errors).toEqual([
      { row: 1, column: 'price_cents', message: 'price_cents debe ser un entero en centavos' },
    ]);
  });

  it('reports a Spanish error for a missing sku', () => {
    const csv = csvOf({ name: 'Producto Sin Sku', price_cents: '1000' });
    const { rows, errors } = parseProductsCsv(csv);

    expect(rows).toHaveLength(0);
    expect(errors).toEqual([{ row: 1, column: 'sku', message: 'sku es obligatorio' }]);
  });

  it('reports a Spanish error for a bad (non http(s)) image url', () => {
    const csv = csvOf({
      name: 'Producto Imagen Mala',
      price_cents: '1000',
      sku: 'SKU-IMG',
      image_urls: 'not-a-url',
    });
    const { rows, errors } = parseProductsCsv(csv);

    expect(rows).toHaveLength(0);
    expect(errors).toEqual([
      { row: 1, column: 'image_urls', message: 'image_urls debe contener solo URLs http(s) válidas' },
    ]);
  });

  it('reports a Spanish error for an in-file duplicate sku, on the second (and later) occurrence', () => {
    const csv = csvOf(
      { name: 'Producto Uno', price_cents: '1000', sku: 'DUP-1' },
      { name: 'Producto Dos', price_cents: '2000', sku: 'DUP-1' },
    );
    const { rows, errors } = parseProductsCsv(csv);

    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Producto Uno');
    expect(errors).toEqual([{ row: 2, column: 'sku', message: 'sku duplicado en el archivo' }]);
  });

  it('rejects status=archived on import (not a valid CSV import status)', () => {
    const csv = csvOf({ name: 'Producto Archivado', price_cents: '1000', sku: 'SKU-ARC', status: 'archived' });
    const { rows, errors } = parseProductsCsv(csv);

    expect(rows).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].column).toBe('status');
  });

  it('row numbering starts at 1 for the first data row (header excluded)', () => {
    const csv = csvOf(
      { name: 'A', price_cents: '1000', sku: 'A-1' },
      { name: 'B', price_cents: '1000', sku: '' },
      { name: 'C', price_cents: '1000', sku: 'C-1' },
    );
    const { rows, errors } = parseProductsCsv(csv);

    expect(rows.map((r) => r.row)).toEqual([1, 3]);
    expect(errors).toEqual([{ row: 2, column: 'sku', message: 'sku es obligatorio' }]);
  });

  it('surfaces a file-level error (row 0) for a structurally malformed CSV, e.g. a row with the wrong field count', () => {
    // papaparse itself flags this (FieldMismatch/TooFewFields) rather than
    // csvProductRowSchema — a mismatched field count is a tokenizing
    // problem, not a bad value in an otherwise well-formed row.
    const malformed = `${TEMPLATE_HEADER}\nProducto Incompleto,solo-dos-campos`;
    const { errors } = parseProductsCsv(malformed);

    expect(errors).toContainEqual({ row: 0, column: 'csv', message: 'archivo CSV malformado' });
  });
});

// ---------------------------------------------------------------------------
// Endpoint integration tests
// ---------------------------------------------------------------------------
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

function dryRun(cookie: string, csv: string) {
  return request(app.getHttpServer()).post('/v1/admin/import/dry-run').set('cookie', cookie).send({ csv });
}

function commit(cookie: string, csv: string) {
  return request(app.getHttpServer()).post('/v1/admin/import/commit').set('cookie', cookie).send({ csv });
}

describe('GET /v1/admin/import/template', () => {
  it('returns the header + one example row as text/csv', async () => {
    const { cookie } = await signUpWithTenant('csv-template@demo.co', 'owner');

    const res = await request(app.getHttpServer()).get('/v1/admin/import/template').set('cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    const lines = (res.text as string).trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(TEMPLATE_HEADER);
    expect(lines[1].split(',')[0]).toContain('Camiseta');
  });
});

describe('POST /v1/admin/import/dry-run', () => {
  it('counts valid/invalid/creates/updates against seeded products', async () => {
    const { cookie } = await signUpWithTenant('csv-dryrun@demo.co', 'owner');

    await request(app.getHttpServer())
      .post('/v1/admin/products')
      .set('cookie', cookie)
      .send({ name: 'Existente', priceCents: 1000, sku: 'EXIST-1' });

    const csv = csvOf(
      { name: 'Nuevo Uno', price_cents: '1000', sku: 'NEW-1' },
      { name: 'Actualiza Existente', price_cents: '2000', sku: 'EXIST-1' },
      { name: 'Fila Mala', price_cents: 'abc', sku: 'BAD-1' },
    );

    const res = await dryRun(cookie, csv);

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(2);
    expect(res.body.invalid).toBe(1);
    expect(res.body.creates).toBe(1);
    expect(res.body.updates).toBe(1);
    expect(res.body.errors).toHaveLength(1);
    expect(res.body.errors[0]).toMatchObject({ row: 3, column: 'price_cents' });
    expect(res.body.limitExceeded).toBe(false);
  });

  it('flags limitExceeded when creates would push past productsMax', async () => {
    const { cookie, tenantId } = await signUpWithTenant('csv-dryrun-limit@demo.co', 'owner');
    await platformDb.tenantLimits.create({
      data: { tenantId, productsMax: 1, aiCreditsMonth: 1000, staffSeats: 3 },
    });

    const csv = csvOf(
      { name: 'Uno', price_cents: '1000', sku: 'LIM-1' },
      { name: 'Dos', price_cents: '1000', sku: 'LIM-2' },
    );
    const res = await dryRun(cookie, csv);

    expect(res.status).toBe(200);
    expect(res.body.creates).toBe(2);
    expect(res.body.limitExceeded).toBe(true);
  });

  it('rejects a CSV payload over 2 MB with 413 CSV_TOO_LARGE', async () => {
    const { cookie } = await signUpWithTenant('csv-toolarge@demo.co', 'owner');
    const huge = `${TEMPLATE_HEADER}\n${'x'.repeat(2 * 1024 * 1024 + 10)}`;

    const res = await dryRun(cookie, huge);

    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: 'CSV_TOO_LARGE' });
  });
});

describe('POST /v1/admin/import/commit', () => {
  it('commits a mix of creates and updates: replaces images, creates categories case-insensitively', async () => {
    const { cookie } = await signUpWithTenant('csv-commit@demo.co', 'owner');

    const existingCat = await request(app.getHttpServer())
      .post('/v1/admin/categories')
      .set('cookie', cookie)
      .send({ name: 'ropa' });
    expect(existingCat.status).toBe(201);

    const existingProduct = await request(app.getHttpServer())
      .post('/v1/admin/products')
      .set('cookie', cookie)
      .send({ name: 'Viejo Nombre', priceCents: 500, sku: 'UPD-1' });
    expect(existingProduct.status).toBe(201);
    await request(app.getHttpServer())
      .post(`/v1/admin/products/${existingProduct.body.id}/images/presign`)
      .set('cookie', cookie)
      .send({ filename: 'old.jpg', contentType: 'image/jpeg', size: 100 })
      .catch(() => undefined);

    const csv = csvOf(
      {
        name: 'Producto Nuevo',
        price_cents: '3000',
        sku: 'NEW-COMMIT-1',
        categories: 'Ropa|Zapatos',
        image_urls: 'https://example.com/new.jpg',
      },
      {
        name: 'Nombre Actualizado',
        price_cents: '9000',
        sku: 'UPD-1',
        categories: 'ROPA',
        image_urls: 'https://example.com/updated.jpg|https://example.com/updated2.jpg',
      },
    );

    const res = await commit(cookie, csv);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ created: 1, updated: 1 });

    const list = await request(app.getHttpServer()).get('/v1/admin/products').set('cookie', cookie);
    expect(list.body.total).toBe(2);

    // list() (PRODUCT_INCLUDE) doesn't carry categoryIds — only findOne
    // (PRODUCT_INCLUDE_WITH_CATEGORIES) does (see products.service.ts) — so
    // categoryIds assertions go through GET /:id.
    const updatedSummary = list.body.items.find((p: { sku: string }) => p.sku === 'UPD-1');
    const updated = (
      await request(app.getHttpServer()).get(`/v1/admin/products/${updatedSummary.id}`).set('cookie', cookie)
    ).body;
    expect(updated.name).toBe('Nombre Actualizado');
    expect(updated.priceCents).toBe(9000);
    expect(updated.images.map((i: { url: string }) => i.url).sort()).toEqual(
      ['https://example.com/updated.jpg', 'https://example.com/updated2.jpg'].sort(),
    );
    expect(updated.categoryIds).toEqual([existingCat.body.id]);

    const createdSummary = list.body.items.find((p: { sku: string }) => p.sku === 'NEW-COMMIT-1');
    const created = (
      await request(app.getHttpServer()).get(`/v1/admin/products/${createdSummary.id}`).set('cookie', cookie)
    ).body;
    expect(created.categoryIds).toHaveLength(2);
    expect(created.images.map((i: { url: string }) => i.url)).toEqual(['https://example.com/new.jpg']);
  });

  it('resolves accent/case-variant category names in the same file to ONE category instead of a slug-collision crash', async () => {
    const { cookie } = await signUpWithTenant('csv-commit-category-accents@demo.co', 'owner');

    // "Café" and "Cafe" both slugify to "cafe" (slugify strips diacritics
    // and lowercases) — resolving categories by lowercased NAME instead of
    // by slug would treat these as two different categories, and creating
    // both would then collide on Category's (tenantId, slug) unique index.
    const csv = csvOf(
      { name: 'Producto Cafe Uno', price_cents: '1000', sku: 'CAT-ACCENT-1', categories: 'Café' },
      { name: 'Producto Cafe Dos', price_cents: '2000', sku: 'CAT-ACCENT-2', categories: 'Cafe' },
    );

    const res = await commit(cookie, csv);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ created: 2, updated: 0 });

    const categories = await request(app.getHttpServer()).get('/v1/admin/categories').set('cookie', cookie);
    expect(categories.body).toHaveLength(1);

    const list = await request(app.getHttpServer()).get('/v1/admin/products').set('cookie', cookie);
    const p1 = list.body.items.find((p: { sku: string }) => p.sku === 'CAT-ACCENT-1');
    const p2 = list.body.items.find((p: { sku: string }) => p.sku === 'CAT-ACCENT-2');
    const p1Full = (await request(app.getHttpServer()).get(`/v1/admin/products/${p1.id}`).set('cookie', cookie)).body;
    const p2Full = (await request(app.getHttpServer()).get(`/v1/admin/products/${p2.id}`).set('cookie', cookie)).body;

    expect(p1Full.categoryIds).toEqual([categories.body[0].id]);
    expect(p2Full.categoryIds).toEqual([categories.body[0].id]);
  });

  it('handles a category name that slugifies empty AND a literal name colliding with its categoria-N fallback slug', async () => {
    const { cookie } = await signUpWithTenant('csv-commit-category-emoji-collision@demo.co', 'owner');

    // "🔥🔥" slugifies to '' (punctuation/emoji only), so resolveCategoryId's
    // empty-slug fallback assigns it the deterministic slug "categoria-1".
    // "Categoria 1" is a normal, non-empty-slugifying name that ALSO
    // slugifies to "categoria-1" — a base-path create with that exact slug
    // must not collide with (nor 500 against) the fallback-path category
    // already holding it; both must land as two distinct categories.
    const csv = csvOf(
      { name: 'Producto Emoji', price_cents: '1000', sku: 'CAT-COLLISION-1', categories: '🔥🔥' },
      { name: 'Producto Literal', price_cents: '2000', sku: 'CAT-COLLISION-2', categories: 'Categoria 1' },
    );

    const res = await commit(cookie, csv);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ created: 2, updated: 0 });

    const categories = await request(app.getHttpServer()).get('/v1/admin/categories').set('cookie', cookie);
    expect(categories.body).toHaveLength(2);
    const slugs = categories.body.map((c: { slug: string }) => c.slug);
    expect(new Set(slugs).size).toBe(2);

    const list = await request(app.getHttpServer()).get('/v1/admin/products').set('cookie', cookie);
    const p1 = list.body.items.find((p: { sku: string }) => p.sku === 'CAT-COLLISION-1');
    const p2 = list.body.items.find((p: { sku: string }) => p.sku === 'CAT-COLLISION-2');
    const p1Full = (await request(app.getHttpServer()).get(`/v1/admin/products/${p1.id}`).set('cookie', cookie)).body;
    const p2Full = (await request(app.getHttpServer()).get(`/v1/admin/products/${p2.id}`).set('cookie', cookie)).body;

    expect(p1Full.categoryIds).toHaveLength(1);
    expect(p2Full.categoryIds).toHaveLength(1);
    expect(p1Full.categoryIds[0]).not.toBe(p2Full.categoryIds[0]);
  });

  it('update semantics are PATCH-like: a blank cell means "keep the current value", not "reset to default"', async () => {
    const { cookie, tenantId } = await signUpWithTenant('csv-commit-patch@demo.co', 'owner');

    const category = await request(app.getHttpServer())
      .post('/v1/admin/categories')
      .set('cookie', cookie)
      .send({ name: 'Preexistente' });
    expect(category.status).toBe(201);

    // Every non-default value here is deliberately NOT the CSV row-default
    // (stock 0, trackInventory true, taxRate '19', status 'draft') so the
    // assertions below can actually tell "kept" apart from "reset".
    const existing = await request(app.getHttpServer())
      .post('/v1/admin/products')
      .set('cookie', cookie)
      .send({
        name: 'Nombre Viejo',
        priceCents: 1000,
        sku: 'PATCH-1',
        stock: 25,
        trackInventory: false,
        taxRate: '5',
        status: 'active',
        barcode: 'BC-ORIGINAL',
        compareAtCents: 2000,
        descriptionMd: 'Descripcion original',
        categoryIds: [category.body.id],
      });
    expect(existing.status).toBe(201);

    // ProductImage row created directly (not through the presign/confirm
    // flow, which needs S3/minio — not set up in this test file) purely to
    // have a pre-existing image to assert is left untouched.
    await platformDb.productImage.create({
      data: { tenantId, productId: existing.body.id, url: 'https://example.com/original.jpg', position: 0 },
    });

    // Only name/price_cents/sku are set (both required on every row per the
    // parser) — every other column is blank.
    const csv = csvOf({ name: 'Nombre Nuevo', price_cents: '5000', sku: 'PATCH-1' });

    const res = await commit(cookie, csv);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ created: 0, updated: 1 });

    const after = await request(app.getHttpServer())
      .get(`/v1/admin/products/${existing.body.id}`)
      .set('cookie', cookie);
    expect(after.status).toBe(200);
    expect(after.body.name).toBe('Nombre Nuevo');
    expect(after.body.priceCents).toBe(5000);
    // Everything else: unchanged from the pre-existing product, not reset
    // to the CSV row's create-time defaults.
    expect(after.body.stock).toBe(25);
    expect(after.body.trackInventory).toBe(false);
    expect(after.body.taxRate).toBe('5');
    expect(after.body.status).toBe('active');
    expect(after.body.barcode).toBe('BC-ORIGINAL');
    expect(after.body.compareAtCents).toBe(2000);
    expect(after.body.descriptionMd).toBe('Descripcion original');
    expect(after.body.slug).toBe(existing.body.slug);
    expect(after.body.images.map((i: { url: string }) => i.url)).toEqual(['https://example.com/original.jpg']);
    expect(after.body.categoryIds).toEqual([category.body.id]);
  });

  it('rejects a file with any row error: 422 CSV_INVALID, nothing persisted', async () => {
    const { cookie } = await signUpWithTenant('csv-commit-invalid@demo.co', 'owner');

    const csv = csvOf(
      { name: 'Producto Bueno', price_cents: '1000', sku: 'GOOD-1' },
      { name: 'Producto Malo', price_cents: '-1', sku: 'BAD-1' },
    );

    const res = await commit(cookie, csv);
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('CSV_INVALID');
    expect(res.body.details.errors).toEqual([
      { row: 2, column: 'price_cents', message: 'price_cents debe ser un entero en centavos' },
    ]);

    const list = await request(app.getHttpServer()).get('/v1/admin/products').set('cookie', cookie);
    expect(list.body.total).toBe(0);
  });

  it('rejects a row whose category name has exhausted all 20 slug suffixes: 422 CSV_INVALID row error', async () => {
    const { cookie, tenantId } = await signUpWithTenant('csv-cat-suffix-cap@demo.co', 'owner');

    // Mirrors the emoji/literal collision test above (line ~402): "🔥🔥"
    // slugifies empty, so its categoria-N fallback claims the literal slug
    // "categoria-1" (nothing else in this fresh tenant has used the
    // fallback yet). "Categoria 1" then slugifies to that exact same
    // "categoria-1" string, landing it in the suffix-collision branch,
    // which tries "categoria-1-2", "categoria-1-3", ... Pre-seeding real
    // categories at every one of "categoria-1-2".."categoria-1-20" (19
    // slugs — the full -2..-20 range the product path also caps at) means
    // there is no free candidate left within MAX_SLUG_SUFFIX.
    await platformDb.category.createMany({
      data: Array.from({ length: 19 }, (_, i) => ({
        tenantId,
        name: `Bloqueo ${i + 2}`,
        slug: `categoria-1-${i + 2}`,
        position: 0,
      })),
    });

    const csv = csvOf(
      { name: 'Producto Emoji', price_cents: '1000', sku: 'CAT-OVERFLOW-1', categories: '🔥🔥' },
      { name: 'Producto Literal', price_cents: '2000', sku: 'CAT-OVERFLOW-2', categories: 'Categoria 1' },
    );
    const res = await commit(cookie, csv);

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('CSV_INVALID');
    expect(res.body.details.errors).toEqual([
      { row: 2, column: 'categories', message: 'no hay slug disponible para la categoría' },
    ]);

    const list = await request(app.getHttpServer()).get('/v1/admin/products').set('cookie', cookie);
    expect(list.body.total).toBe(0);
  });

  it('is idempotent: committing the same file twice makes the second run all updates, product count unchanged', async () => {
    const { cookie } = await signUpWithTenant('csv-commit-idempotent@demo.co', 'owner');

    const csv = csvOf(
      { name: 'Producto A', price_cents: '1000', sku: 'IDEMP-A' },
      { name: 'Producto B', price_cents: '2000', sku: 'IDEMP-B' },
    );

    const first = await commit(cookie, csv);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ created: 2, updated: 0 });

    const second = await commit(cookie, csv);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ created: 0, updated: 2 });

    const list = await request(app.getHttpServer()).get('/v1/admin/products').set('cookie', cookie);
    expect(list.body.total).toBe(2);
  });

  it('writes an InventoryMovement for a stock change on an update row, with the right delta', async () => {
    const { cookie, tenantId } = await signUpWithTenant('csv-commit-stock-movement@demo.co', 'owner');

    const existing = await request(app.getHttpServer())
      .post('/v1/admin/products')
      .set('cookie', cookie)
      .send({ name: 'Producto Stock CSV', priceCents: 1000, sku: 'STOCK-CSV-1', stock: 10 });
    expect(existing.status).toBe(201);

    const csv = csvOf({ name: 'Producto Stock CSV', price_cents: '1000', sku: 'STOCK-CSV-1', stock: '17' });

    const res = await commit(cookie, csv);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ created: 0, updated: 1 });

    const after = await request(app.getHttpServer())
      .get(`/v1/admin/products/${existing.body.id}`)
      .set('cookie', cookie);
    expect(after.body.stock).toBe(17);

    const movements = await platformDb.inventoryMovement.findMany({
      where: { tenantId, productId: existing.body.id },
    });
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({ delta: 7, reason: 'csv_import' });
    expect(movements[0]!.actor).toBeTruthy();
  });

  it('does not write an InventoryMovement when a create row sets the initial stock baseline', async () => {
    const { cookie, tenantId } = await signUpWithTenant('csv-commit-stock-create@demo.co', 'owner');

    const csv = csvOf({ name: 'Producto Stock Nuevo', price_cents: '1000', sku: 'STOCK-CSV-NEW', stock: '30' });
    const res = await commit(cookie, csv);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ created: 1, updated: 0 });

    const movements = await platformDb.inventoryMovement.findMany({ where: { tenantId } });
    expect(movements).toHaveLength(0);
  });

  it('returns 402 PLAN_LIMIT_EXCEEDED when a CSV update would un-archive a product past productsMax, nothing persisted', async () => {
    const { cookie, tenantId } = await signUpWithTenant('csv-commit-unarchive-limit@demo.co', 'owner');

    // Both products are created BEFORE the plan limit is set, so creation
    // itself is never blocked -- the limit only needs to apply once the
    // tenant is in its target state (1 active, 1 archived) so the CSV
    // un-archive below is what trips it, not either create.
    const active = await request(app.getHttpServer())
      .post('/v1/admin/products')
      .set('cookie', cookie)
      .send({ name: 'Producto Activo', priceCents: 1000, sku: 'UNARC-ACTIVE', status: 'active' });
    expect(active.status).toBe(201);

    const archived = await request(app.getHttpServer())
      .post('/v1/admin/products')
      .set('cookie', cookie)
      .send({ name: 'Producto Archivado', priceCents: 1000, sku: 'UNARC-ARCHIVED' });
    expect(archived.status).toBe(201);
    const archiveRes = await request(app.getHttpServer())
      .delete(`/v1/admin/products/${archived.body.id}`)
      .set('cookie', cookie);
    expect(archiveRes.status).toBe(204);

    // Now cap the tenant at exactly its current non-archived count (1: just
    // "Producto Activo") -- un-archiving the second product would push it to 2.
    await platformDb.tenantLimits.create({
      data: { tenantId, productsMax: 1, aiCreditsMonth: 1000, staffSeats: 3 },
    });

    // Un-archiving via CSV (status column explicitly set) would push the
    // tenant from 1 non-archived product back to 2, over the productsMax=1 cap.
    const csv = csvOf({
      name: 'Producto Archivado',
      price_cents: '1000',
      sku: 'UNARC-ARCHIVED',
      status: 'active',
    });
    const res = await commit(cookie, csv);
    expect(res.status).toBe(402);
    expect(res.body.error).toBe('PLAN_LIMIT_EXCEEDED');

    const after = await request(app.getHttpServer())
      .get(`/v1/admin/products/${archived.body.id}`)
      .set('cookie', cookie);
    expect(after.body.status).toBe('archived');
  });

  it('returns 402 PLAN_LIMIT_EXCEEDED when creates would exceed productsMax, nothing persisted', async () => {
    const { cookie, tenantId } = await signUpWithTenant('csv-commit-limit@demo.co', 'owner');
    await platformDb.tenantLimits.create({
      data: { tenantId, productsMax: 1, aiCreditsMonth: 1000, staffSeats: 3 },
    });

    const csv = csvOf(
      { name: 'Uno', price_cents: '1000', sku: 'PLIM-1' },
      { name: 'Dos', price_cents: '1000', sku: 'PLIM-2' },
    );

    const res = await commit(cookie, csv);
    expect(res.status).toBe(402);
    expect(res.body.error).toBe('PLAN_LIMIT_EXCEEDED');

    const list = await request(app.getHttpServer()).get('/v1/admin/products').set('cookie', cookie);
    expect(list.body.total).toBe(0);
  });

  it('writes a single csv_import audit row with { created, updated }', async () => {
    const { cookie, tenantId } = await signUpWithTenant('csv-commit-audit@demo.co', 'owner');

    const csv = csvOf(
      { name: 'Auditado Uno', price_cents: '1000', sku: 'AUD-1' },
      { name: 'Auditado Dos', price_cents: '2000', sku: 'AUD-2' },
    );
    const res = await commit(cookie, csv);
    expect(res.status).toBe(200);

    const rows = await platformDb.auditLog.findMany({ where: { tenantId, action: 'csv_import' } });
    expect(rows).toHaveLength(1);
    expect(rows[0].data).toEqual({ created: 2, updated: 0 });
  });

  it('commits 500 rows in under 60 seconds', async () => {
    const { cookie } = await signUpWithTenant('csv-perf@demo.co', 'owner');

    const rows: Array<Record<string, string>> = [];
    for (let i = 0; i < 500; i++) {
      rows.push({ name: `Producto Perf ${i}`, price_cents: '1000', sku: `PERF-${i}` });
    }
    const csv = csvOf(...rows);

    const start = Date.now();
    const res = await commit(cookie, csv);
    const elapsed = Date.now() - start;

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ created: 500, updated: 0 });
    // AC (spec M2): 500-row commit completes in under 60s. Actual measured
    // elapsed on this container: ~900ms — see task-8-report.md.
    expect(elapsed).toBeLessThan(60_000);
  }, 90_000);
});
