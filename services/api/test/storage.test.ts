import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { S3Client, CreateBucketCommand } from '@aws-sdk/client-s3';
import { presignRequestSchema } from '@ventia/core';
import { startMinio } from './helpers-minio';
import { StorageService } from '../src/storage/storage.service';

const T1 = 'a1b2c3d4-e5f6-4789-a0b1-c2d3e4f5a6b7';
const PRODUCT_ID = 'b2c3d4e5-f6a7-4890-b1c2-d3e4f5a6b7c8';

let minio: Awaited<ReturnType<typeof startMinio>>;
let storage: StorageService;

beforeAll(async () => {
  minio = await startMinio();

  const client = new S3Client({
    endpoint: minio.endpoint,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: 'ventia', secretAccessKey: 'ventia-secret' },
  });
  await client.send(new CreateBucketCommand({ Bucket: 'ventia' }));

  storage = new StorageService({
    endpoint: minio.endpoint,
    accessKey: 'ventia',
    secretKey: 'ventia-secret',
    bucket: 'ventia',
    publicUrl: `${minio.endpoint}/ventia`,
  });
}, 120_000);

afterAll(async () => {
  await minio.stop();
});

describe('StorageService', () => {
  it('presigns a PUT that actually uploads to minio', async () => {
    const { uploadUrl, key, publicUrl } = await storage.presignProductImage(T1, PRODUCT_ID, {
      filename: 'foto.JPG',
      contentType: 'image/jpeg',
      size: 1234,
    });

    expect(key).toMatch(new RegExp(`^tenants/${T1}/products/${PRODUCT_ID}/[0-9a-f-]{36}\\.jpg$`));

    const body = Buffer.alloc(1234, 1);
    const put = await fetch(uploadUrl, { method: 'PUT', headers: { 'content-type': 'image/jpeg' }, body });
    expect(put.status).toBe(200);

    expect(publicUrl).toBe(`${minio.endpoint}/ventia/${key}`);
  });

  it('rejects a disallowed content type at the schema layer', () => {
    expect(() => presignRequestSchema.parse({ filename: 'x.gif', contentType: 'image/gif', size: 10 })).toThrow();
  });
});
