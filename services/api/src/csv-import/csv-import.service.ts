import { HttpException, Injectable } from '@nestjs/common';
import { Prisma, platformDb, tenantDb, type TaxRate as PrismaTaxRate } from '@ventia/db';
import { csvImportRequestSchema, slugify, type TaxRateValue } from '@ventia/core';
import type { SessionContext } from '../auth/session-context';
import { parseOr400 } from '../catalog/parse';
import { writeAudit } from '../catalog/audit';
import { assertProductLimit } from '../catalog/plan-limits';
import { parseProductsCsv, type ParsedRow, type RowError } from './csv-parser';

// Same translation table as ProductsService (products.service.ts) — kept in
// sync there rather than shared, since the two files' domains (single-product
// CRUD vs bulk CSV import) already don't share a service class and this is
// a 4-entry const, not real logic to dedupe.
const TAX_RATE_TO_DB: Record<TaxRateValue, PrismaTaxRate> = {
  '0': 'ZERO',
  '5': 'FIVE',
  '19': 'NINETEEN',
  excluido: 'EXCLUIDO',
};

const MAX_CSV_BYTES = 2 * 1024 * 1024;
const MAX_ERRORS_RETURNED = 100;
const MAX_SLUG_SUFFIX = 20;

export const CSV_TEMPLATE_HEADER =
  'name,slug,description,price_cents,compare_at_cents,sku,barcode,stock,track_inventory,tax_rate,status,categories,image_urls';
// es-CO example values (spec M2's own example): a t-shirt priced at
// $45,900.00 COP (price_cents is COP cents, so 4590000).
const CSV_TEMPLATE_EXAMPLE_ROW =
  'Camiseta básica,camiseta-basica,Camiseta 100% algodón peinado,4590000,5990000,CAM-001,7701234567890,50,true,19,active,Camisetas|Ropa,https://example.com/img/camiseta.jpg';

export interface DryRunResult {
  valid: number;
  invalid: number;
  creates: number;
  updates: number;
  errors: RowError[];
  limitExceeded: boolean;
}

export interface CommitResult {
  created: number;
  updated: number;
}

function assertCsvSize(csv: string): void {
  // Buffer.byteLength (not csv.length) — the 2 MB cap is a byte budget, and
  // JS string .length counts UTF-16 code units, not bytes (es-CO text has
  // plenty of multi-byte accented characters that would undercount).
  if (Buffer.byteLength(csv, 'utf8') > MAX_CSV_BYTES) {
    throw new HttpException({ error: 'CSV_TOO_LARGE' }, 413);
  }
}

function isUniqueConstraintError(err: unknown): err is Prisma.PrismaClientKnownRequestError {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

@Injectable()
export class CsvImportService {
  /** `GET /v1/admin/import/template` body: header line + one example row. */
  template(): string {
    return `${CSV_TEMPLATE_HEADER}\n${CSV_TEMPLATE_EXAMPLE_ROW}\n`;
  }

  async dryRun(session: SessionContext, body: unknown): Promise<DryRunResult> {
    const { csv } = parseOr400(csvImportRequestSchema, body);
    assertCsvSize(csv);

    const { rows, errors } = parseProductsCsv(csv);
    const tenantId = session.tenantId!;
    const db = tenantDb(tenantId);

    const skus = [...new Set(rows.map((r) => r.sku))];
    const existing = skus.length
      ? await db.product.findMany({ where: { sku: { in: skus } }, select: { sku: true } })
      : [];
    const existingSkus = new Set(existing.map((p) => p.sku));

    const creates = rows.filter((r) => !existingSkus.has(r.sku)).length;
    const updates = rows.length - creates;
    const invalid = new Set(errors.map((e) => e.row)).size;

    const limits = await db.tenantLimits.findUnique({ where: { tenantId } });
    let limitExceeded = false;
    if (limits) {
      const nonArchivedCount = await db.product.count({ where: { status: { not: 'archived' } } });
      limitExceeded = nonArchivedCount + creates > limits.productsMax;
    }

    return {
      valid: rows.length,
      invalid,
      creates,
      updates,
      errors: errors.slice(0, MAX_ERRORS_RETURNED),
      limitExceeded,
    };
  }

  async commit(session: SessionContext, body: unknown): Promise<CommitResult> {
    const { csv } = parseOr400(csvImportRequestSchema, body);
    assertCsvSize(csv);

    // Re-parse + re-validate on commit (never trust a client-supplied
    // dry-run result): ANY row error rejects the whole file — no partial
    // import — per spec M2.
    const { rows, errors } = parseProductsCsv(csv);
    if (errors.length > 0) {
      throw new HttpException(
        { error: 'CSV_INVALID', details: { errors: errors.slice(0, MAX_ERRORS_RETURNED) } },
        422,
      );
    }

    const tenantId = session.tenantId!;
    const db = tenantDb(tenantId);
    const skus = rows.map((r) => r.sku);

    // Plan-limit check counts only CREATE rows (an update never grows the
    // tenant's product count) and must happen before the transaction below —
    // assertProductLimit throws 402, and we want that to happen with nothing
    // written yet, not to unwind a transaction.
    const preExisting = skus.length
      ? await db.product.findMany({ where: { sku: { in: skus } }, select: { sku: true } })
      : [];
    const preExistingSkus = new Set(preExisting.map((p) => p.sku));
    const createsCount = rows.filter((r) => !preExistingSkus.has(r.sku)).length;
    await assertProductLimit(session, createsCount);

    const result = await platformDb.$transaction(async (tx) => {
      // Manual RLS transaction escape (see ProductsService.update /
      // VariantsController.replace after e48e49f): committing the whole CSV
      // — anywhere from a handful to hundreds of product upserts plus their
      // images/categories — must be all-or-nothing (spec's "no partial
      // import"), which the tenantDb extension can't give us since it opens
      // a fresh transaction per call. We re-establish RLS scoping ourselves
      // (SET LOCAL ROLE + tenant GUC) for the lifetime of this one
      // transaction; Postgres RLS still enforces every statement below
      // exactly as tenantDb would.
      await tx.$executeRawUnsafe('SET LOCAL ROLE ventia_app');
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;

      const existingProducts = await tx.product.findMany({
        where: { tenantId, sku: { in: skus } },
        select: { id: true, sku: true },
      });
      const existingBySku = new Map(existingProducts.map((p) => [p.sku, p.id]));

      // Category cache keyed by SLUG (not by lowercased name): slugify()
      // already lowercases and strips diacritics, so keying by slug is what
      // actually makes "resolved/created case-insensitively by name" true
      // even across accents — "Café" and "Cafe" both slugify to "cafe".
      // Keying by name.toLowerCase() instead would treat those as two
      // different categories, and creating both would then collide on
      // Category's (tenantId, slug) unique index and blow up the whole
      // commit with an unhandled P2002 partway through the row loop.
      const existingCategories = await tx.category.findMany({ where: { tenantId } });
      const categoryCache = new Map<string, string>(existingCategories.map((c) => [c.slug, c.id]));
      // Secondary cache for the rare category name that slugifies to ''
      // (punctuation/emoji-only, e.g. "!!!"): keyed by the raw lowercased
      // name so repeats of that exact name within one file still resolve to
      // one category, without ever handing Prisma an empty string as the
      // slug column (a deterministic `categoria-N` fallback is used instead).
      const emptySlugCategoryCache = new Map<string, string>();
      let emptySlugCounter = 0;

      async function resolveCategoryId(name: string): Promise<string> {
        const baseSlug = slugify(name);
        const cacheKey = baseSlug ? undefined : name.toLowerCase();
        const cached = baseSlug ? categoryCache.get(baseSlug) : emptySlugCategoryCache.get(cacheKey!);
        if (cached) return cached;

        const slug = baseSlug || `categoria-${++emptySlugCounter}`;
        try {
          const category = await tx.category.create({ data: { tenantId, name, slug, position: 0 } });
          if (baseSlug) categoryCache.set(baseSlug, category.id);
          else emptySlugCategoryCache.set(cacheKey!, category.id);
          return category.id;
        } catch (err) {
          if (!isUniqueConstraintError(err)) throw err;
          // A race is impossible within one transaction's sequential
          // statements, but two distinct in-file names slugifying to the
          // same value is not — fall back to whichever category is actually
          // there rather than aborting the commit.
          const existing = await tx.category.findFirst({ where: { tenantId, slug } });
          if (!existing) throw err;
          if (baseSlug) categoryCache.set(baseSlug, existing.id);
          else emptySlugCategoryCache.set(cacheKey!, existing.id);
          return existing.id;
        }
      }

      // Slug dedup state: every tenant product's current slug, checked
      // against both this transaction's writes and each other (mirrors
      // ProductsService.uniqueSlug's -2..-20 suffix approach, extended to
      // also track slugs newly assigned earlier in this same file).
      const existingSlugRows = await tx.product.findMany({ where: { tenantId }, select: { id: true, slug: true } });
      const takenSlugs = new Set(existingSlugRows.map((p) => p.slug));
      const ownSlugByProductId = new Map(existingSlugRows.map((p) => [p.id, p.slug]));

      let created = 0;
      let updated = 0;

      for (const row of rows) {
        const existingId = existingBySku.get(row.sku);
        const isCreate = !existingId;

        // Categories: resolved for every CREATE row, but for an UPDATE row
        // only when the `categories` column was actually non-blank — a
        // blank cell on an update means "leave this product's existing
        // category links alone", not "clear them" (see the PATCH-like
        // semantics note on ParsedRow.provided in csv-parser.ts).
        let categoryIds: string[] | undefined;
        if (isCreate || row.provided.categoryNames) {
          categoryIds = [];
          for (const name of row.categoryNames) {
            categoryIds.push(await resolveCategoryId(name));
          }
        }

        // Slug: resolved/deduped for every CREATE row (explicit column or
        // slugify(name)), but for an UPDATE row only when the `slug` column
        // was itself explicitly provided — a blank slug on an update means
        // "keep the current slug", and must NOT re-derive one from `name`
        // (a CSV re-importing a renamed product without touching `slug`
        // would otherwise get a surprise slug change on every commit).
        let slug: string | undefined;
        if (isCreate || row.slug !== undefined) {
          const base = row.slug ?? slugify(row.name);
          const ownCurrentSlug = existingId ? ownSlugByProductId.get(existingId) : undefined;
          slug = base;
          if (slug !== ownCurrentSlug) {
            let suffix = 1;
            while (takenSlugs.has(slug)) {
              suffix += 1;
              if (suffix > MAX_SLUG_SUFFIX) {
                throw new HttpException({ error: 'SLUG_TAKEN', details: { row: row.row, slug: base } }, 409);
              }
              slug = `${base}-${suffix}`;
            }
          }
          takenSlugs.add(slug);
        }

        if (isCreate) {
          await tx.product.create({
            data: {
              tenantId,
              sku: row.sku,
              name: row.name,
              slug: slug!,
              descriptionMd: row.descriptionMd,
              priceCents: row.priceCents,
              compareAtCents: row.compareAtCents ?? null,
              barcode: row.barcode ?? null,
              stock: row.stock,
              trackInventory: row.trackInventory,
              taxRate: TAX_RATE_TO_DB[row.taxRate],
              status: row.status,
              images: row.imageUrls.length
                ? { create: row.imageUrls.map((url, position) => ({ tenantId, url, position })) }
                : undefined,
              categories:
                categoryIds && categoryIds.length
                  ? { create: categoryIds.map((categoryId) => ({ categoryId, tenantId })) }
                  : undefined,
            },
          });
          created += 1;
        } else {
          await this.updateExistingProduct(tx, tenantId, existingId, row, slug, categoryIds);
          updated += 1;
        }
      }

      return { created, updated };
    });

    // AuditLog.entityId is nullable in the schema, but writeAudit's signature
    // requires a string — there's no single Product this bulk operation is
    // "about", so the tenant id stands in as the audited entity. Entity
    // label is 'CsvImport' (not 'Product'): this audit row describes the
    // bulk operation itself, not any one product it touched.
    await writeAudit(session, 'csv_import', 'CsvImport', tenantId, result);
    return result;
  }

  /** PATCH-like update for one existing-sku row: `name`/`price_cents` are
   * always applied (the parser requires both on every row), every other
   * column is applied ONLY if its CSV cell was non-blank (see
   * ParsedRow.provided) — a blank cell means "leave this field as it is on
   * the existing product", not "reset it to a default". Images/categories
   * follow the same rule: replaced only when their column was non-blank. */
  private async updateExistingProduct(
    tx: Prisma.TransactionClient,
    tenantId: string,
    productId: string,
    row: ParsedRow,
    slug: string | undefined,
    categoryIds: string[] | undefined,
  ): Promise<void> {
    const data: Prisma.ProductUpdateInput = {
      name: row.name,
      priceCents: row.priceCents,
    };
    if (slug !== undefined) data.slug = slug;
    if (row.provided.descriptionMd) data.descriptionMd = row.descriptionMd;
    if (row.compareAtCents !== undefined) data.compareAtCents = row.compareAtCents;
    if (row.barcode !== undefined) data.barcode = row.barcode;
    if (row.provided.stock) data.stock = row.stock;
    if (row.provided.trackInventory) data.trackInventory = row.trackInventory;
    if (row.provided.taxRate) data.taxRate = TAX_RATE_TO_DB[row.taxRate];
    if (row.provided.status) data.status = row.status;

    await tx.product.update({ where: { id: productId }, data });

    if (row.provided.imageUrls) {
      await tx.productImage.deleteMany({ where: { productId, tenantId } });
      if (row.imageUrls.length) {
        await tx.productImage.createMany({
          data: row.imageUrls.map((url, position) => ({ tenantId, productId, url, position })),
        });
      }
    }

    if (row.provided.categoryNames) {
      await tx.productCategory.deleteMany({ where: { productId, tenantId } });
      if (categoryIds && categoryIds.length) {
        await tx.productCategory.createMany({
          data: categoryIds.map((categoryId) => ({ productId, categoryId, tenantId })),
        });
      }
    }
  }
}
