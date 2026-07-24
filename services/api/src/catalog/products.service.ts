import { Injectable, HttpException } from '@nestjs/common';
import { Prisma, platformDb, tenantDb, type TaxRate as PrismaTaxRate } from '@ventia/db';
import {
  productInputSchema,
  productUpdateSchema,
  slugify,
  type ProductInput,
  type ProductUpdate,
  type TaxRateValue,
} from '@ventia/core';
import type { SessionContext } from '../auth/session-context';
import { parseOr400 } from './parse';
import { writeAudit } from './audit';
import { assertProductLimit } from './plan-limits';

// productInputSchema/productUpdateSchema use the human-facing tax rate strings
// ('0' | '5' | '19' | 'excluido'); the Prisma-generated TaxRate enum's runtime
// values are its member names (ZERO/FIVE/NINETEEN/EXCLUIDO) — @map only
// changes the *database* representation, not the generated client's TS/JS
// values. These two maps translate at the service boundary so nothing above
// this file needs to know about the Prisma-side spelling.
const TAX_RATE_TO_DB: Record<TaxRateValue, PrismaTaxRate> = {
  '0': 'ZERO',
  '5': 'FIVE',
  '19': 'NINETEEN',
  excluido: 'EXCLUIDO',
};
const TAX_RATE_FROM_DB: Record<PrismaTaxRate, TaxRateValue> = {
  ZERO: '0',
  FIVE: '5',
  NINETEEN: '19',
  EXCLUIDO: 'excluido',
};

const MAX_SLUG_SUFFIX = 20;

const PRODUCT_INCLUDE = {
  images: { orderBy: { position: 'asc' as const } },
  variants: true,
} satisfies Prisma.ProductInclude;

const PRODUCT_INCLUDE_WITH_CATEGORIES = {
  ...PRODUCT_INCLUDE,
  categories: true,
} satisfies Prisma.ProductInclude;

type ProductWithRelations = Prisma.ProductGetPayload<{ include: typeof PRODUCT_INCLUDE }>;
type ProductWithCategories = Prisma.ProductGetPayload<{ include: typeof PRODUCT_INCLUDE_WITH_CATEGORIES }>;

// Explicit, hand-written response shape (rather than relying on the inferred
// Prisma payload type) so tsc doesn't need to reference the generated Prisma
// client's private runtime types to name these methods' return types — see
// TS2742 ("inferred type ... cannot be named without a reference to
// .../@prisma/client/runtime/library"). `taxRate` is the human-facing string,
// not the Prisma enum's ZERO/FIVE/NINETEEN/EXCLUIDO spelling (see the maps above).
export interface ProductImageDTO {
  id: string;
  tenantId: string;
  productId: string;
  url: string;
  alt: string | null;
  position: number;
}

export interface ProductVariantDTO {
  id: string;
  tenantId: string;
  productId: string;
  option1: string | null;
  option2: string | null;
  option3: string | null;
  priceCents: number | null;
  sku: string | null;
  stock: number;
}

export interface ProductDTO {
  id: string;
  tenantId: string;
  name: string;
  slug: string;
  descriptionMd: string;
  priceCents: number;
  compareAtCents: number | null;
  costCents: number | null;
  sku: string | null;
  barcode: string | null;
  stock: number;
  trackInventory: boolean;
  taxRate: TaxRateValue;
  status: 'draft' | 'active' | 'archived';
  seo: Prisma.JsonValue;
  options: string[];
  createdAt: Date;
  updatedAt: Date;
  images: ProductImageDTO[];
  variants: ProductVariantDTO[];
  categoryIds?: string[];
}

export interface ProductListResult {
  items: ProductDTO[];
  total: number;
  page: number;
  pageSize: number;
}

function isUniqueConstraintError(err: unknown): err is Prisma.PrismaClientKnownRequestError {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

function isNotFoundError(err: unknown): err is Prisma.PrismaClientKnownRequestError {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025';
}

function isForeignKeyError(err: unknown): err is Prisma.PrismaClientKnownRequestError {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003';
}

function serialize(product: ProductWithRelations | ProductWithCategories): ProductDTO {
  // Cast-then-destructure rather than a runtime `'categories' in product`
  // narrow: `categories` is simply `undefined` on the plain-list shape
  // (ProductWithRelations never carries it), and destructuring a missing key
  // off a real object is safe in JS regardless of what TS believes its type is.
  const { taxRate, categories, ...rest } = product as ProductWithCategories;
  return {
    ...rest,
    taxRate: TAX_RATE_FROM_DB[taxRate],
    ...(categories !== undefined ? { categoryIds: categories.map((c) => c.categoryId) } : {}),
  };
}

export interface ProductListQuery {
  search?: string;
  status?: string;
  page?: string;
  pageSize?: string;
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

@Injectable()
export class ProductsService {
  async list(session: SessionContext, query: ProductListQuery): Promise<ProductListResult> {
    const tenantId = session.tenantId!;
    const db = tenantDb(tenantId);

    const page = Math.max(1, Math.trunc(Number(query.page)) || 1);
    const rawPageSize = Math.trunc(Number(query.pageSize));
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, rawPageSize || DEFAULT_PAGE_SIZE));

    const where: Prisma.ProductWhereInput = {};
    if (query.search) {
      where.OR = [
        { name: { contains: query.search, mode: 'insensitive' } },
        { sku: { contains: query.search, mode: 'insensitive' } },
      ];
    }
    if (query.status === 'draft' || query.status === 'active' || query.status === 'archived') {
      where.status = query.status;
    }

    const [items, total] = await Promise.all([
      db.product.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: PRODUCT_INCLUDE,
      }),
      db.product.count({ where }),
    ]);

    return { items: items.map((p) => serialize(p)), total, page, pageSize };
  }

  async create(session: SessionContext, body: unknown): Promise<ProductDTO> {
    const input = parseOr400(productInputSchema, body);
    await assertProductLimit(session);

    const tenantId = session.tenantId!;
    const db = tenantDb(tenantId);
    const slug = await this.uniqueSlug(tenantId, input.slug ?? slugify(input.name));
    const { categoryIds, taxRate, ...rest } = input;

    try {
      const product = await db.product.create({
        data: {
          tenantId,
          ...rest,
          slug, // overrides rest.slug (the pre-dedup value, if the caller supplied one)
          taxRate: TAX_RATE_TO_DB[taxRate],
          categories: categoryIds.length
            ? { create: categoryIds.map((categoryId) => ({ categoryId, tenantId })) }
            : undefined,
        },
        include: PRODUCT_INCLUDE_WITH_CATEGORIES,
      });
      await writeAudit(session, 'product.create', 'Product', product.id, input);
      return serialize(product);
    } catch (err) {
      if (isUniqueConstraintError(err)) throw new HttpException({ error: 'SLUG_TAKEN' }, 409);
      throw err;
    }
  }

  async findOne(session: SessionContext, id: string): Promise<ProductDTO> {
    const tenantId = session.tenantId!;
    const product = await tenantDb(tenantId).product.findFirst({
      where: { id },
      include: PRODUCT_INCLUDE_WITH_CATEGORIES,
    });
    if (!product) throw new HttpException({ error: 'NOT_FOUND' }, 404);
    return serialize(product);
  }

  async update(session: SessionContext, id: string, body: unknown): Promise<ProductDTO> {
    const input = parseOr400(productUpdateSchema, body);
    const tenantId = session.tenantId!;
    const db = tenantDb(tenantId);

    const existing = await db.product.findFirst({ where: { id }, select: { id: true } });
    if (!existing) throw new HttpException({ error: 'NOT_FOUND' }, 404);

    const { categoryIds, taxRate, slug: inputSlug, ...rest } = input;
    const data: Prisma.ProductUpdateInput = { ...rest };
    if (taxRate !== undefined) data.taxRate = TAX_RATE_TO_DB[taxRate];

    try {
      // The category replace (deleteMany+createMany) and the product update
      // itself must commit-or-rollback together: a PATCH carrying both
      // `categoryIds` and other fields (e.g. slug) must never leave
      // categories changed while the product update itself fails (slug
      // collision, bad categoryId, or anything else). The tenantDb extension
      // can't span a multi-op transaction (each call opens its own), so we
      // escape to platformDb.$transaction and set the RLS role + tenant GUC
      // ourselves for its lifetime — Postgres RLS remains the enforcement
      // layer for every statement below, we're just manually re-establishing
      // the scoping tenantDb would normally do per call.
      const product = await platformDb.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL ROLE ventia_app');
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;

        // Deliberately no pre-check/dedup here (unlike create()'s
        // auto-slugify convenience): an explicit `slug` in a PATCH is a
        // precise request, not a name-derived suggestion, so a collision
        // should reject with 409 rather than silently rename to `-2`. Set
        // it as-is and let the DB's (tenantId, slug) unique index enforce
        // it atomically at the actual write below — a pre-check-then-write
        // would just reopen the same TOCTOU race this transaction exists
        // to close.
        if (inputSlug !== undefined) data.slug = inputSlug;

        if (categoryIds !== undefined) {
          await tx.productCategory.deleteMany({ where: { productId: id, tenantId } });
          if (categoryIds.length) {
            await tx.productCategory.createMany({
              data: categoryIds.map((categoryId) => ({ productId: id, categoryId, tenantId })),
            });
          }
        }

        return tx.product.update({
          where: { id },
          data,
          include: PRODUCT_INCLUDE_WITH_CATEGORIES,
        });
      });
      await writeAudit(session, 'product.update', 'Product', id, input);
      return serialize(product);
    } catch (err) {
      if (isNotFoundError(err)) throw new HttpException({ error: 'NOT_FOUND' }, 404);
      if (isUniqueConstraintError(err)) throw new HttpException({ error: 'SLUG_TAKEN' }, 409);
      if (isForeignKeyError(err)) {
        throw new HttpException(
          { error: 'VALIDATION_FAILED', details: { categoryIds: 'categoría inexistente' } },
          400,
        );
      }
      throw err;
    }
  }

  async archive(session: SessionContext, id: string): Promise<void> {
    const tenantId = session.tenantId!;
    const db = tenantDb(tenantId);
    try {
      await db.product.update({ where: { id }, data: { status: 'archived' } });
    } catch (err) {
      if (isNotFoundError(err)) throw new HttpException({ error: 'NOT_FOUND' }, 404);
      throw err;
    }
    await writeAudit(session, 'product.archive', 'Product', id);
  }

  /** Finds a tenant-unique slug: `base`, then `base-2`, `base-3`, ... `base-20`.
   * Used only by create()'s auto-slugify convenience (deriving a slug from
   * the name, or gently deduping a caller-supplied one) — update() treats an
   * explicit `slug` as a precise request instead (see the comment in
   * `update()`), so it doesn't call this. Throws 409 SLUG_TAKEN if all 20
   * candidates are taken. */
  private async uniqueSlug(tenantId: string, base: string): Promise<string> {
    const db = tenantDb(tenantId);
    for (let suffix = 1; suffix <= MAX_SLUG_SUFFIX; suffix++) {
      const candidate = suffix === 1 ? base : `${base}-${suffix}`;
      const clash = await db.product.findFirst({
        where: { slug: candidate },
        select: { id: true },
      });
      if (!clash) return candidate;
    }
    throw new HttpException({ error: 'SLUG_TAKEN' }, 409);
  }
}

export type { ProductInput, ProductUpdate };
