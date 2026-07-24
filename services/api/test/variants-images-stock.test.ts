import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { S3Client, CreateBucketCommand, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient as PrismaClientType } from '@ventia/db';
import { startTestDb } from './helpers';
import { startMinio } from './helpers-minio';
import type { signUpWithTenant as SignUpWithTenant } from './admin-helpers';

let db: Awaited<ReturnType<typeof startTestDb>>;
let redisContainer: StartedTestContainer;
let minio: Awaited<ReturnType<typeof startMinio>>;
let app: INestApplication;
let signUpWithTenant: typeof SignUpWithTenant;
let platformDb: PrismaClientType;
let s3: S3Client;

const BUCKET = 'ventia';

beforeAll(async () => {
  db = await startTestDb();
  minio = await startMinio();
  redisContainer = await new GenericContainer('redis:7-alpine')
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
    .start();

  s3 = new S3Client({
    endpoint: minio.endpoint,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: 'ventia', secretAccessKey: 'ventia-secret' },
  });
  await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));

  // Env vars must be set BEFORE the first import of @ventia/db / ../src/main
  // (same pattern as products.test.ts / storage.test.ts): StorageModule's
  // useFactory and admin-helpers' module-level PrismaClient both read
  // process.env at import/instantiation time.
  process.env.DATABASE_URL = db.url;
  process.env.REDIS_URL = `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`;
  process.env.S3_ENDPOINT = minio.endpoint;
  process.env.S3_ACCESS_KEY = 'ventia';
  process.env.S3_SECRET_KEY = 'ventia-secret';
  process.env.S3_BUCKET = BUCKET;
  process.env.S3_PUBLIC_URL = `${minio.endpoint}/${BUCKET}`;

  const { createApp } = await import('../src/main');
  app = await createApp();
  await app.init();

  ({ signUpWithTenant } = await import('./admin-helpers'));
  ({ platformDb } = await import('@ventia/db'));
}, 120_000);

afterAll(async () => {
  await app.close();
  await redisContainer.stop();
  await minio.stop();
  await db.stop();
});

async function createProduct(cookie: string, overrides: Record<string, unknown> = {}) {
  return request(app.getHttpServer())
    .post('/v1/admin/products')
    .set('cookie', cookie)
    .send({ name: 'Camiseta', priceCents: 50_000, ...overrides });
}

describe('PUT /v1/admin/products/:id/variants', () => {
  it('replaces the variant set: 2 options, price override, labels persisted on product.options', async () => {
    const { cookie } = await signUpWithTenant('variants-happy@demo.co', 'owner');
    const created = await createProduct(cookie, { name: 'Camiseta Variantes' });
    expect(created.status).toBe(201);

    const res = await request(app.getHttpServer())
      .put(`/v1/admin/products/${created.body.id}/variants`)
      .set('cookie', cookie)
      .send({
        options: ['Talla', 'Color'],
        variants: [
          { option1: 'M', option2: 'Azul', priceCents: 55_000, sku: 'CAM-M-AZ', stock: 10 },
          { option1: 'L', option2: 'Rojo', stock: 5 },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.options).toEqual(['Talla', 'Color']);
    expect(res.body.variants).toHaveLength(2);
    const m = res.body.variants.find((v: { option1: string }) => v.option1 === 'M');
    expect(m).toMatchObject({ option1: 'M', option2: 'Azul', priceCents: 55_000, sku: 'CAM-M-AZ', stock: 10 });
    const l = res.body.variants.find((v: { option1: string }) => v.option1 === 'L');
    expect(l).toMatchObject({ option1: 'L', option2: 'Rojo', stock: 5, priceCents: null });

    // replacing again drops the old set entirely
    const res2 = await request(app.getHttpServer())
      .put(`/v1/admin/products/${created.body.id}/variants`)
      .set('cookie', cookie)
      .send({ options: ['Talla'], variants: [{ option1: 'XL', stock: 1 }] });
    expect(res2.status).toBe(200);
    expect(res2.body.options).toEqual(['Talla']);
    expect(res2.body.variants).toHaveLength(1);
    expect(res2.body.variants[0]).toMatchObject({ option1: 'XL', stock: 1 });
  });

  it('is invisible across tenants: variant replace on another tenant product -> 404', async () => {
    const tenantA = await signUpWithTenant('variants-tenant-a@demo.co', 'owner');
    const tenantB = await signUpWithTenant('variants-tenant-b@demo.co', 'owner');
    const created = await createProduct(tenantA.cookie, { name: 'Producto Tenant A' });
    expect(created.status).toBe(201);

    const res = await request(app.getHttpServer())
      .put(`/v1/admin/products/${created.body.id}/variants`)
      .set('cookie', tenantB.cookie)
      .send({ options: ['Talla'], variants: [{ option1: 'M', stock: 1 }] });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'NOT_FOUND' });
  });

  it('writes an audit row for product.variants_replace', async () => {
    const { cookie, tenantId } = await signUpWithTenant('variants-audit@demo.co', 'owner');
    const created = await createProduct(cookie, { name: 'Producto Audit Variants' });

    const res = await request(app.getHttpServer())
      .put(`/v1/admin/products/${created.body.id}/variants`)
      .set('cookie', cookie)
      .send({ options: ['Talla'], variants: [{ option1: 'M', stock: 1 }] });
    expect(res.status).toBe(200);

    const rows = await platformDb.auditLog.findMany({
      where: { tenantId, entityId: created.body.id, action: 'product.variants_replace' },
    });
    expect(rows).toHaveLength(1);
  });
});

describe('Product images', () => {
  async function presignAndUpload(cookie: string, productId: string, size = 1234) {
    const presign = await request(app.getHttpServer())
      .post(`/v1/admin/products/${productId}/images/presign`)
      .set('cookie', cookie)
      .send({ filename: 'foto.jpg', contentType: 'image/jpeg', size });
    expect(presign.status).toBe(201);
    expect(presign.body).toMatchObject({
      uploadUrl: expect.any(String),
      key: expect.stringMatching(new RegExp(`^tenants/.+/products/${productId}/.+\\.jpg$`)),
      publicUrl: expect.any(String),
    });

    const body = Buffer.alloc(size, 1);
    const put = await fetch(presign.body.uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': 'image/jpeg' },
      body,
    });
    expect(put.status).toBe(200);
    return presign.body as { uploadUrl: string; key: string; publicUrl: string };
  }

  it('presigns, uploads to minio, confirms, and creates an image row with a public url', async () => {
    const { cookie } = await signUpWithTenant('images-happy@demo.co', 'owner');
    const created = await createProduct(cookie, { name: 'Producto Imagenes' });

    const { key, publicUrl } = await presignAndUpload(cookie, created.body.id);

    const confirm = await request(app.getHttpServer())
      .post(`/v1/admin/products/${created.body.id}/images`)
      .set('cookie', cookie)
      .send({ key, alt: 'Foto principal', position: 0 });

    expect(confirm.status).toBe(201);
    expect(confirm.body).toMatchObject({
      productId: created.body.id,
      url: publicUrl,
      alt: 'Foto principal',
      position: 0,
    });

    const product = await request(app.getHttpServer())
      .get(`/v1/admin/products/${created.body.id}`)
      .set('cookie', cookie);
    expect(product.body.images).toHaveLength(1);
    expect(product.body.images[0].url).toBe(publicUrl);
  });

  it('rejects confirm on presign for another product (mismatched key prefix) -> 400', async () => {
    const { cookie } = await signUpWithTenant('images-mismatch@demo.co', 'owner');
    const productA = await createProduct(cookie, { name: 'Producto A' });
    const productB = await createProduct(cookie, { name: 'Producto B' });

    const { key } = await presignAndUpload(cookie, productA.body.id);

    const confirm = await request(app.getHttpServer())
      .post(`/v1/admin/products/${productB.body.id}/images`)
      .set('cookie', cookie)
      .send({ key, position: 0 });

    expect(confirm.status).toBe(400);
    expect(confirm.body).toEqual({ error: 'INVALID_UPLOAD' });
  });

  it('rejects confirm of an oversized object -> 400 INVALID_UPLOAD, and deletes the object', async () => {
    const { cookie } = await signUpWithTenant('images-oversized@demo.co', 'owner');
    const created = await createProduct(cookie, { name: 'Producto Oversized' });

    // Fabricate an oversized object directly via the S3 client: the presigned
    // URL doesn't sign ContentLength (see storage.service.ts), so an
    // over-the-limit PUT would otherwise succeed at upload time — the size
    // gate has to be enforced by HeadObject-ing the object at confirm time.
    const key = `tenants/${created.body.tenantId}/products/${created.body.id}/oversized.jpg`;
    const bigBody = Buffer.alloc(6 * 1024 * 1024, 1);
    await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: bigBody, ContentType: 'image/jpeg' }));

    const confirm = await request(app.getHttpServer())
      .post(`/v1/admin/products/${created.body.id}/images`)
      .set('cookie', cookie)
      .send({ key, position: 0 });

    expect(confirm.status).toBe(400);
    expect(confirm.body).toEqual({ error: 'INVALID_UPLOAD' });

    // object must have been deleted
    await expect(s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }))).rejects.toThrow();
  });

  it('rejects the 9th image with 409 IMAGE_LIMIT', async () => {
    const { cookie } = await signUpWithTenant('images-limit@demo.co', 'owner');
    const created = await createProduct(cookie, { name: 'Producto Limite' });

    for (let i = 0; i < 8; i++) {
      const { key } = await presignAndUpload(cookie, created.body.id);
      const confirm = await request(app.getHttpServer())
        .post(`/v1/admin/products/${created.body.id}/images`)
        .set('cookie', cookie)
        .send({ key, position: i });
      expect(confirm.status).toBe(201);
    }

    const presign9 = await request(app.getHttpServer())
      .post(`/v1/admin/products/${created.body.id}/images/presign`)
      .set('cookie', cookie)
      .send({ filename: 'foto9.jpg', contentType: 'image/jpeg', size: 100 });

    expect(presign9.status).toBe(409);
    expect(presign9.body).toEqual({ error: 'IMAGE_LIMIT' });
  });

  it('deletes an image: 204, row removed, audit row written', async () => {
    const { cookie, tenantId } = await signUpWithTenant('images-delete@demo.co', 'owner');
    const created = await createProduct(cookie, { name: 'Producto Delete Image' });
    const { key } = await presignAndUpload(cookie, created.body.id);
    const confirm = await request(app.getHttpServer())
      .post(`/v1/admin/products/${created.body.id}/images`)
      .set('cookie', cookie)
      .send({ key, position: 0 });
    expect(confirm.status).toBe(201);

    const del = await request(app.getHttpServer())
      .delete(`/v1/admin/products/${created.body.id}/images/${confirm.body.id}`)
      .set('cookie', cookie);
    expect(del.status).toBe(204);

    const product = await request(app.getHttpServer())
      .get(`/v1/admin/products/${created.body.id}`)
      .set('cookie', cookie);
    expect(product.body.images).toEqual([]);

    const rows = await platformDb.auditLog.findMany({
      where: { tenantId, entityId: confirm.body.id, action: 'product.image_remove' },
    });
    expect(rows).toHaveLength(1);
  });

  it('writes an audit row for product.image_add', async () => {
    const { cookie, tenantId } = await signUpWithTenant('images-audit@demo.co', 'owner');
    const created = await createProduct(cookie, { name: 'Producto Audit Image' });
    const { key } = await presignAndUpload(cookie, created.body.id);
    const confirm = await request(app.getHttpServer())
      .post(`/v1/admin/products/${created.body.id}/images`)
      .set('cookie', cookie)
      .send({ key, position: 0 });
    expect(confirm.status).toBe(201);

    const rows = await platformDb.auditLog.findMany({
      where: { tenantId, entityId: confirm.body.id, action: 'product.image_add' },
    });
    expect(rows).toHaveLength(1);
  });
});

describe('POST /v1/admin/products/:id/stock', () => {
  it('adjusts product stock up then down, writing InventoryMovement rows', async () => {
    const { cookie, tenantId } = await signUpWithTenant('stock-product@demo.co', 'owner');
    const created = await createProduct(cookie, { name: 'Producto Stock', stock: 10 });
    expect(created.body.stock).toBe(10);

    const up = await request(app.getHttpServer())
      .post(`/v1/admin/products/${created.body.id}/stock`)
      .set('cookie', cookie)
      .send({ delta: 5, reason: 'restock' });
    expect(up.status).toBe(201);
    expect(up.body.stock).toBe(15);

    const down = await request(app.getHttpServer())
      .post(`/v1/admin/products/${created.body.id}/stock`)
      .set('cookie', cookie)
      .send({ delta: -3, reason: 'manual_adjust' });
    expect(down.status).toBe(201);
    expect(down.body.stock).toBe(12);

    const product = await request(app.getHttpServer())
      .get(`/v1/admin/products/${created.body.id}`)
      .set('cookie', cookie);
    expect(product.body.stock).toBe(12);

    const movements = await platformDb.inventoryMovement.findMany({
      where: { tenantId, productId: created.body.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(movements).toHaveLength(2);
    expect(movements[0]).toMatchObject({ delta: 5, reason: 'restock', variantId: null });
    expect(movements[1]).toMatchObject({ delta: -3, reason: 'manual_adjust', variantId: null });
    expect(movements[0]!.actor).toBeTruthy();
  });

  it('adjusts a variant stock independently of the product stock', async () => {
    const { cookie, tenantId } = await signUpWithTenant('stock-variant@demo.co', 'owner');
    const created = await createProduct(cookie, { name: 'Producto Stock Variant', stock: 10 });

    const variants = await request(app.getHttpServer())
      .put(`/v1/admin/products/${created.body.id}/variants`)
      .set('cookie', cookie)
      .send({ options: ['Talla'], variants: [{ option1: 'M', stock: 3 }] });
    expect(variants.status).toBe(200);
    const variantId = variants.body.variants[0].id;

    const adjust = await request(app.getHttpServer())
      .post(`/v1/admin/products/${created.body.id}/stock`)
      .set('cookie', cookie)
      .send({ variantId, delta: 4, reason: 'restock' });
    expect(adjust.status).toBe(201);
    expect(adjust.body.stock).toBe(7);

    // product stock is untouched by the variant-scoped adjustment
    const product = await request(app.getHttpServer())
      .get(`/v1/admin/products/${created.body.id}`)
      .set('cookie', cookie);
    expect(product.body.stock).toBe(10);
    expect(product.body.variants[0].stock).toBe(7);

    const movements = await platformDb.inventoryMovement.findMany({
      where: { tenantId, variantId },
    });
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({ productId: created.body.id, delta: 4, reason: 'restock' });
  });

  it('rejects a below-zero adjustment with 422 STOCK_BELOW_ZERO, leaving stock unchanged', async () => {
    const { cookie } = await signUpWithTenant('stock-belowzero@demo.co', 'owner');
    const created = await createProduct(cookie, { name: 'Producto Stock Bajo', stock: 2 });

    const res = await request(app.getHttpServer())
      .post(`/v1/admin/products/${created.body.id}/stock`)
      .set('cookie', cookie)
      .send({ delta: -5, reason: 'correction' });

    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: 'STOCK_BELOW_ZERO' });

    const product = await request(app.getHttpServer())
      .get(`/v1/admin/products/${created.body.id}`)
      .set('cookie', cookie);
    expect(product.body.stock).toBe(2);
  });

  it('404s for a variantId that does not belong to the product', async () => {
    const { cookie } = await signUpWithTenant('stock-wrong-variant@demo.co', 'owner');
    const productA = await createProduct(cookie, { name: 'Producto A Stock' });
    const productB = await createProduct(cookie, { name: 'Producto B Stock' });

    const variants = await request(app.getHttpServer())
      .put(`/v1/admin/products/${productA.body.id}/variants`)
      .set('cookie', cookie)
      .send({ options: ['Talla'], variants: [{ option1: 'M', stock: 3 }] });
    const variantId = variants.body.variants[0].id;

    const res = await request(app.getHttpServer())
      .post(`/v1/admin/products/${productB.body.id}/stock`)
      .set('cookie', cookie)
      .send({ variantId, delta: 1, reason: 'restock' });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'NOT_FOUND' });
  });

  it('writes an audit row for product.stock_adjust', async () => {
    const { cookie, tenantId } = await signUpWithTenant('stock-audit@demo.co', 'owner');
    const created = await createProduct(cookie, { name: 'Producto Stock Audit', stock: 5 });

    const res = await request(app.getHttpServer())
      .post(`/v1/admin/products/${created.body.id}/stock`)
      .set('cookie', cookie)
      .send({ delta: 1, reason: 'restock' });
    expect(res.status).toBe(201);

    const rows = await platformDb.auditLog.findMany({
      where: { tenantId, entityId: created.body.id, action: 'product.stock_adjust' },
    });
    expect(rows).toHaveLength(1);
  });
});
