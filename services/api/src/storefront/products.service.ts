import { Injectable } from '@nestjs/common';
import { Prisma, platformDb } from '@ventia/db';

export interface StorefrontProductSummary {
  id: string;
  name: string;
  slug: string;
  priceCents: number;
  compareAtCents: number | null;
  thumbnailUrl: string | null;
  inStock: boolean;
}

export interface StorefrontProductListResult {
  items: StorefrontProductSummary[];
  total: number;
  page: number;
  pageSize: number;
}

export interface StorefrontProductListParams {
  search?: string;
  categorySlug?: string;
  priceMax?: number;
  sort?: 'relevance' | 'price' | 'newest';
  page?: number;
  pageSize?: number;
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 60;

interface RawRow {
  id: string;
  name: string;
  slug: string;
  priceCents: number;
  compareAtCents: number | null;
  stock: number;
  trackInventory: boolean;
  thumbnailUrl: string | null;
  total: bigint;
}

@Injectable()
export class StorefrontProductsService {
  async list(tenantId: string, params: StorefrontProductListParams): Promise<StorefrontProductListResult> {
    const page = Math.max(1, params.page ?? 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, params.pageSize ?? DEFAULT_PAGE_SIZE));
    const offset = (page - 1) * pageSize;
    const search = params.search?.trim() || undefined;

    const categoryFilter = params.categorySlug
      ? Prisma.sql`AND EXISTS (
          SELECT 1 FROM "ProductCategory" pc
          JOIN "Category" c ON c.id = pc."categoryId"
          WHERE pc."productId" = p.id AND c.slug = ${params.categorySlug}
        )`
      : Prisma.empty;
    const priceFilter =
      params.priceMax != null ? Prisma.sql`AND p."priceCents" <= ${params.priceMax}` : Prisma.empty;
    const searchFilter = search
      ? Prisma.sql`AND (
          to_tsvector('spanish', p.name || ' ' || p."descriptionMd") @@ plainto_tsquery('spanish', ${search})
          OR similarity(p.name, ${search}) > 0.25
        )`
      : Prisma.empty;
    const orderBy =
      search && (!params.sort || params.sort === 'relevance')
        ? Prisma.sql`ORDER BY ts_rank(to_tsvector('spanish', p.name || ' ' || p."descriptionMd"), plainto_tsquery('spanish', ${search})) DESC, similarity(p.name, ${search}) DESC`
        : params.sort === 'price'
          ? Prisma.sql`ORDER BY p."priceCents" ASC`
          : Prisma.sql`ORDER BY p."createdAt" DESC`;

    return platformDb.$transaction(async (tx) => {
      // Manual tenant-scoped transaction: full-text/trigram search needs raw
      // SQL, which the tenantDb extension deliberately blocks (see
      // packages/db/src/tenant-client.ts). RLS remains the enforcement layer
      // for this statement, same escape pattern as ProductsService.update.
      await tx.$executeRawUnsafe('SET LOCAL ROLE ventia_app');
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;

      const rows = await tx.$queryRaw<RawRow[]>(Prisma.sql`
        SELECT p.id, p.name, p.slug, p."priceCents", p."compareAtCents", p.stock, p."trackInventory",
          (SELECT url FROM "ProductImage" WHERE "productId" = p.id ORDER BY position ASC LIMIT 1) AS "thumbnailUrl",
          count(*) OVER() AS total
        FROM "Product" p
        WHERE p."tenantId" = ${tenantId}::uuid AND p.status = 'active'
        ${categoryFilter} ${priceFilter} ${searchFilter}
        ${orderBy}
        LIMIT ${pageSize} OFFSET ${offset}
      `);

      const total = rows[0] ? Number(rows[0].total) : 0;
      const items: StorefrontProductSummary[] = rows.map((r) => ({
        id: r.id,
        name: r.name,
        slug: r.slug,
        priceCents: r.priceCents,
        compareAtCents: r.compareAtCents,
        thumbnailUrl: r.thumbnailUrl,
        inStock: !r.trackInventory || r.stock > 0,
      }));
      return { items, total, page, pageSize };
    });
  }
}
