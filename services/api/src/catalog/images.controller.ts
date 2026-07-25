import { Body, Controller, Delete, HttpCode, HttpException, Inject, Param, Post, UseGuards } from '@nestjs/common';
import { platformDb, tenantDb } from '@ventia/db';
import { imageConfirmSchema, presignRequestSchema } from '@ventia/core';
import { AdminSessionGuard } from '../admin/admin-session.guard';
import { AdminSession, type AdminSessionContext } from '../admin/roles.decorator';
import { StorageService } from '../storage/storage.service';
import { parseOr400 } from './parse';
import { writeAudit } from './audit';
import { assertUuidOr404 } from './uuid';

const MAX_IMAGE_COUNT = 8;
// Mirrors presignRequestSchema's `size` cap (packages/core/src/catalog-schemas.ts):
// that cap is enforced at request-schema time on the *declared* size before a
// presigned URL is minted, but it can't stop a caller from PUTting a bigger
// object directly (ContentLength is intentionally not part of the signed
// command — see storage.service.ts). This is the actual bytes-on-the-wire gate.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
// Reuses presignRequestSchema's contentType enum rather than duplicating the
// allowlist.
const ALLOWED_CONTENT_TYPES = new Set<string>(presignRequestSchema.shape.contentType.options);

// The exact shape StorageService.presignProductImage mints for the part of
// the key after the tenant/product prefix: a bare `{uuid}.{ext}`, nothing
// else. Enforced here (not just the prefix check below) so a caller can't
// smuggle a path-traversal segment (`../`) or extra path segments into an
// otherwise-valid-prefixed key.
const KEY_SUFFIX_RE = /^[0-9a-f-]{36}\.(jpg|png|webp)$/;

// AdminSessionGuard rejects any session without a tenantId before a request
// reaches here (see admin-session.guard.ts), so tenantId is guaranteed
// non-null in every handler below.
@Controller('v1/admin/products')
@UseGuards(AdminSessionGuard)
export class ImagesController {
  // Explicit @Inject: esbuild (vitest's default TS transform) does not emit
  // TypeScript's `design:paramtypes` decorator metadata, so Nest's implicit
  // constructor-injection cannot resolve StorageService by type alone (same
  // caution as admin-session.guard.ts's Reflector/AuthInstance injection).
  constructor(@Inject(StorageService) private readonly storage: StorageService) {}

  @Post(':id/images/presign')
  async presign(
    @AdminSession() session: AdminSessionContext,
    @Param('id') productId: string,
    @Body() body: unknown,
  ) {
    assertUuidOr404(productId);
    const input = parseOr400(presignRequestSchema, body);
    const tenantId = session.tenantId;
    const db = tenantDb(tenantId);

    // SECURITY GATE: tenantId comes only from the session; productId is
    // validated as belonging to the tenant BEFORE presigning — never pass a
    // caller-controlled id straight into the S3 key without checking it
    // first.
    const product = await db.product.findFirst({ where: { id: productId }, select: { id: true } });
    if (!product) throw new HttpException({ error: 'NOT_FOUND' }, 404);

    const count = await db.productImage.count({ where: { productId } });
    if (count >= MAX_IMAGE_COUNT) throw new HttpException({ error: 'IMAGE_LIMIT' }, 409);

    return this.storage.presignProductImage(tenantId, productId, input);
  }

  @Post(':id/images')
  @HttpCode(201)
  async confirm(
    @AdminSession() session: AdminSessionContext,
    @Param('id') productId: string,
    @Body() body: unknown,
  ) {
    assertUuidOr404(productId);
    const input = parseOr400(imageConfirmSchema, body);
    const tenantId = session.tenantId;
    const db = tenantDb(tenantId);

    const product = await db.product.findFirst({ where: { id: productId }, select: { id: true } });
    if (!product) throw new HttpException({ error: 'NOT_FOUND' }, 404);

    // SECURITY GATE (a): the key must be scoped to this exact tenant+product
    // — a caller who presigned (or was issued) a key for a different product
    // (their own or another tenant's) must not be able to attach it here.
    const expectedPrefix = `tenants/${tenantId}/products/${productId}/`;
    if (!input.key.startsWith(expectedPrefix)) {
      throw new HttpException({ error: 'INVALID_UPLOAD' }, 400);
    }

    // SECURITY GATE (a2): the remainder after the prefix must be exactly
    // `{uuid}.{ext}` — no extra path segments, and critically no `../`
    // traversal. Passing the prefix check alone doesn't rule out a key like
    // `tenants/T/products/P/../../../other/secret.jpg`, whose *string*
    // prefix still matches even though it resolves elsewhere once the S3
    // client or any downstream consumer normalizes the path.
    if (!KEY_SUFFIX_RE.test(input.key.slice(expectedPrefix.length))) {
      throw new HttpException({ error: 'INVALID_UPLOAD' }, 400);
    }

    // SECURITY GATE (b): verify the object actually exists in S3, and that
    // its real (server-observed) size and content type are within bounds —
    // the presigned PUT doesn't sign ContentLength (see storage.service.ts),
    // so a caller could otherwise upload something oversized or of a
    // disallowed type through a validly-issued URL.
    const head = await this.storage.headObject(input.key);
    const isValid = head !== null && head.contentLength <= MAX_IMAGE_BYTES && ALLOWED_CONTENT_TYPES.has(head.contentType);
    if (!isValid) {
      try {
        await this.storage.deleteObject(input.key);
      } catch (err) {
        console.error('[images] failed to delete invalid upload', {
          key: input.key,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      throw new HttpException({ error: 'INVALID_UPLOAD' }, 400);
    }

    // Manual RLS transaction escape (see ProductsService.update after
    // e48e49f / StockController): `presign`'s count check alone isn't
    // enough to enforce the 8-image cap under concurrency — two confirms
    // racing at count=7 can each observe "7 < 8" and both insert, landing at
    // 9. Locking the product row for the duration of the count-then-insert
    // serializes concurrent confirms for the same product so the recheck
    // below is actually atomic with the insert.
    const image = await platformDb.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE ventia_app');
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      await tx.$executeRaw`SELECT id FROM "Product" WHERE id = ${productId}::uuid AND "tenantId" = ${tenantId}::uuid FOR UPDATE`;

      const count = await tx.productImage.count({ where: { productId, tenantId } });
      if (count >= MAX_IMAGE_COUNT) throw new HttpException({ error: 'IMAGE_LIMIT' }, 409);

      return tx.productImage.create({
        data: {
          tenantId,
          productId,
          url: this.storage.publicUrlFor(input.key),
          alt: input.alt,
          position: input.position,
        },
      });
    });
    await writeAudit(session, 'product.image_add', 'ProductImage', image.id, input);
    return image;
  }

  @Delete(':id/images/:imageId')
  @HttpCode(204)
  async remove(
    @AdminSession() session: AdminSessionContext,
    @Param('id') productId: string,
    @Param('imageId') imageId: string,
  ): Promise<void> {
    assertUuidOr404(productId);
    assertUuidOr404(imageId);
    const tenantId = session.tenantId;
    const db = tenantDb(tenantId);

    const image = await db.productImage.findFirst({ where: { id: imageId, productId } });
    if (!image) throw new HttpException({ error: 'NOT_FOUND' }, 404);

    await db.productImage.delete({ where: { id: imageId } });

    // Best-effort S3 cleanup: the row is already gone regardless of whether
    // this succeeds — an orphaned object in the bucket is a cheap cost
    // compared to failing an already-committed delete.
    const key = this.storage.keyFromPublicUrl(image.url);
    if (key) {
      try {
        await this.storage.deleteObject(key);
      } catch (err) {
        console.error('[images] best-effort S3 delete failed', {
          key,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    await writeAudit(session, 'product.image_remove', 'ProductImage', imageId);
  }
}
