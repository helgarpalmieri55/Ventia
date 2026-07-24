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
      data: { tenantId, productsMax: 1, aiMessagesMonth: 1000, staffSeats: 3 },
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

  it('returns 402 PLAN_LIMIT_EXCEEDED when creates would exceed productsMax, nothing persisted', async () => {
    const { cookie, tenantId } = await signUpWithTenant('csv-commit-limit@demo.co', 'owner');
    await platformDb.tenantLimits.create({
      data: { tenantId, productsMax: 1, aiMessagesMonth: 1000, staffSeats: 3 },
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
