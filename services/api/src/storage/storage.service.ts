import { randomUUID } from 'node:crypto';
import { DeleteObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { presignRequestSchema } from '@ventia/core';

export interface StorageConfig {
  endpoint: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
  publicUrl: string;
}

export interface PresignProductImageRequest {
  filename: string;
  contentType: string;
  size: number;
}

export interface PresignProductImageResult {
  uploadUrl: string;
  key: string;
  publicUrl: string;
}

const PRESIGN_EXPIRY_SECONDS = 300;

// Content type -> file extension. Deliberately NOT derived from the client-supplied
// filename, which is untrusted input.
const EXT_BY_CONTENT_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export class StorageService {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly publicUrl: string;

  constructor(config: StorageConfig) {
    this.bucket = config.bucket;
    this.publicUrl = config.publicUrl;
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: 'auto',
      forcePathStyle: true,
      credentials: { accessKeyId: config.accessKey, secretAccessKey: config.secretKey },
    });
  }

  async presignProductImage(
    tenantId: string,
    productId: string,
    req: PresignProductImageRequest,
  ): Promise<PresignProductImageResult> {
    const parsed = presignRequestSchema.parse(req);
    const ext = EXT_BY_CONTENT_TYPE[parsed.contentType];
    const key = `tenants/${tenantId}/products/${productId}/${randomUUID()}.${ext}`;

    // NOTE: ContentLength is intentionally NOT part of the signed command. Signing
    // it against MinIO/Testcontainers passed when the test client sent the exact
    // declared byte count (Node's fetch sets Content-Length from the Buffer), but
    // that exactness is not guaranteed for real browser uploads (chunked bodies,
    // proxies rewriting the header, etc.) and any mismatch would turn into a hard
    // SignatureDoesNotMatch failure at upload time. Size is enforced up front at
    // the schema layer instead (presignRequestSchema caps `size` at 5MB) before a
    // URL is ever minted, so we get the same guarantee without coupling the
    // signature to a header we don't fully control. See task-4-report.md.
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: parsed.contentType,
    });

    const uploadUrl = await getSignedUrl(this.client, command, { expiresIn: PRESIGN_EXPIRY_SECONDS });

    return { uploadUrl, key, publicUrl: this.publicUrlFor(key) };
  }

  publicUrlFor(key: string): string {
    return `${this.publicUrl}/${key}`;
  }

  /** Inverse of publicUrlFor: recovers the S3 key from a stored public url,
   * or null if the url doesn't match this instance's publicUrl prefix
   * (e.g. it was never one of ours). Used by the image-delete flow, which
   * only persists `url` on ProductImage, not the raw key. */
  keyFromPublicUrl(url: string): string | null {
    const prefix = `${this.publicUrl}/`;
    return url.startsWith(prefix) ? url.slice(prefix.length) : null;
  }

  /** HEADs an object in the bucket. Returns null if it doesn't exist (rather
   * than throwing) so callers can treat "never uploaded" and "uploaded but
   * gone" uniformly as a confirm-time validation failure. */
  async headObject(key: string): Promise<{ contentLength: number; contentType: string } | null> {
    try {
      const res = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { contentLength: res.ContentLength ?? 0, contentType: res.ContentType ?? '' };
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      if (name === 'NotFound' || name === 'NoSuchKey') return null;
      throw err;
    }
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}
