import { Injectable } from '@nestjs/common';
import { Prisma, platformDb, tenantDb, type TaxRate as PrismaTaxRate } from '@ventia/db';
import type { TaxRateValue } from '@ventia/core';

// Same DB-enum-to-human-string translation as catalog/products.service.ts's
// TAX_RATE_FROM_DB (duplicated locally rather than shared, matching the
// existing pattern of csv-import.service.ts having its own copy too): the
// Prisma-generated TaxRate enum's runtime values are its member names
// (ZERO/FIVE/NINETEEN/EXCLUIDO), not the human-facing '0'/'5'/'19'/'excluido'
// strings the storefront API contract exposes.
const TAX_RATE_FROM_DB: Record<PrismaTaxRate, TaxRateValue> = {
  ZERO: '0',
  FIVE: '5',
  NINETEEN: '19',
  EXCLUIDO: 'excluido',
};

export interface StorefrontProductSummary {
  id: string;
  name: string;
  slug: string;
  priceCents: number;
  compareAtCents: number | null;
  thumbnailUrl: string | null;
  inStock: boolean;
}

// Extends the summary shape rather than duplicating its fields, per the
// brief. `thumbnailUrl` is omitted because detail responses carry the full
// `images` array instead of a single thumbnail. `taxRate` is added on top of
// what the brief's own Step 3 code sample returns: the task's "Produces"
// contract explicitly lists `taxRate` in `StorefrontProductDetail`, and the
// field already exists on `Product` (and is exposed the same way by the
// admin-facing ProductDTO in catalog/products.service.ts), so its omission
// from the sample implementation looks like an oversight rather than an
// intentional field drop. Included here; noted in the task report.
export interface StorefrontProductDetail extends Omit<StorefrontProductSummary, 'thumbnailUrl'> {
  descriptionMd: string;
  taxRate: TaxRateValue;
  options: string[];
  images: Array<{ url: string; alt: string | null }>;
  variants: Array<{
    id: string;
    option1: string | null;
    option2: string | null;
    option3: string | null;
    priceCents: number | null;
    stock: number;
  }>;
  related: StorefrontProductSummary[];
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
}

interface CountRow {
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

      // Two round-trips (count + page), not one `count(*) OVER()` window
      // column, so that `total` reflects the real match count even when the
      // requested page/offset lands past the end of the result set (in which
      // case the paginated SELECT below legitimately returns zero rows, but
      // there's no row for a window function to have ridden along on). Both
      // queries reuse the exact same WHERE fragments so they can never drift
      // out of sync with each other.
      const countRows = await tx.$queryRaw<CountRow[]>(Prisma.sql`
        SELECT count(*) AS total
        FROM "Product" p
        WHERE p."tenantId" = ${tenantId}::uuid AND p.status = 'active'
        ${categoryFilter} ${priceFilter} ${searchFilter}
      `);
      const total = Number(countRows[0]?.total ?? 0n);

      const rows = await tx.$queryRaw<RawRow[]>(Prisma.sql`
        SELECT p.id, p.name, p.slug, p."priceCents", p."compareAtCents", p.stock, p."trackInventory",
          (SELECT url FROM "ProductImage" WHERE "productId" = p.id ORDER BY position ASC LIMIT 1) AS "thumbnailUrl"
        FROM "Product" p
        WHERE p."tenantId" = ${tenantId}::uuid AND p.status = 'active'
        ${categoryFilter} ${priceFilter} ${searchFilter}
        ${orderBy}
        LIMIT ${pageSize} OFFSET ${offset}
      `);

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

  async detail(tenantId: string, slug: string): Promise<StorefrontProductDetail | null> {
    // Plain relational reads (no FTS/trigram ranking needed here), so the
    // ordinary tenant-scoped client is enough — unlike `list()` above, which
    // has to drop to raw SQL for `to_tsvector`/`similarity`.
    const db = tenantDb(tenantId);
    const product = await db.product.findFirst({
      where: { slug, status: 'active' },
      include: {
        images: { orderBy: { position: 'asc' } },
        variants: true,
        categories: { select: { categoryId: true } },
      },
    });
    if (!product) return null;

    const categoryIds = product.categories.map((c) => c.categoryId);
    const related = categoryIds.length
      ? await db.product.findMany({
          where: {
            status: 'active',
            id: { not: product.id },
            categories: { some: { categoryId: { in: categoryIds } } },
          },
          take: 4,
          orderBy: { createdAt: 'desc' },
          include: { images: { orderBy: { position: 'asc' }, take: 1 } },
        })
      : [];

    return {
      id: product.id,
      name: product.name,
      slug: product.slug,
      descriptionMd: product.descriptionMd,
      priceCents: product.priceCents,
      compareAtCents: product.compareAtCents,
      taxRate: TAX_RATE_FROM_DB[product.taxRate],
      inStock: !product.trackInventory || product.stock > 0,
      options: product.options,
      images: product.images.map((i) => ({ url: i.url, alt: i.alt })),
      variants: product.variants.map((v) => ({
        id: v.id,
        option1: v.option1,
        option2: v.option2,
        option3: v.option3,
        priceCents: v.priceCents,
        stock: v.stock,
      })),
      related: related.map((r) => ({
        id: r.id,
        name: r.name,
        slug: r.slug,
        priceCents: r.priceCents,
        compareAtCents: r.compareAtCents,
        thumbnailUrl: r.images[0]?.url ?? null,
        inStock: !r.trackInventory || r.stock > 0,
      })),
    };
  }
}
