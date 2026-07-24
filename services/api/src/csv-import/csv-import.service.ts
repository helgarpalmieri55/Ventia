import { HttpException, Injectable } from '@nestjs/common';
import { platformDb, tenantDb, type TaxRate as PrismaTaxRate } from '@ventia/db';
import { csvImportRequestSchema, slugify, type TaxRateValue } from '@ventia/core';
import type { SessionContext } from '../auth/session-context';
import { parseOr400 } from '../catalog/parse';
import { writeAudit } from '../catalog/audit';
import { assertProductLimit } from '../catalog/plan-limits';
import { parseProductsCsv, type RowError } from './csv-parser';

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

      // Category cache, keyed by lowercased name — resolves/creates
      // categories case-insensitively and, just as importantly, makes sure
      // two rows in the same file naming the same category (any casing)
      // reuse one Category row instead of racing each other into duplicates.
      const existingCategories = await tx.category.findMany({ where: { tenantId } });
      const categoryCache = new Map<string, string>(existingCategories.map((c) => [c.name.toLowerCase(), c.id]));

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

        const categoryIds: string[] = [];
        for (const name of row.categoryNames) {
          const key = name.toLowerCase();
          let categoryId = categoryCache.get(key);
          if (!categoryId) {
            const category = await tx.category.create({
              data: { tenantId, name, slug: slugify(name) || key, position: 0 },
            });
            categoryId = category.id;
            categoryCache.set(key, categoryId);
          }
          categoryIds.push(categoryId);
        }

        const base = row.slug ?? slugify(row.name);
        const ownCurrentSlug = existingId ? ownSlugByProductId.get(existingId) : undefined;
        let slug = base;
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

        const data = {
          name: row.name,
          slug,
          descriptionMd: row.descriptionMd,
          priceCents: row.priceCents,
          compareAtCents: row.compareAtCents ?? null,
          barcode: row.barcode ?? null,
          stock: row.stock,
          trackInventory: row.trackInventory,
          taxRate: TAX_RATE_TO_DB[row.taxRate],
          status: row.status,
        };

        if (existingId) {
          await tx.product.update({ where: { id: existingId }, data });

          await tx.productImage.deleteMany({ where: { productId: existingId, tenantId } });
          if (row.imageUrls.length) {
            await tx.productImage.createMany({
              data: row.imageUrls.map((url, position) => ({ tenantId, productId: existingId, url, position })),
            });
          }

          await tx.productCategory.deleteMany({ where: { productId: existingId, tenantId } });
          if (categoryIds.length) {
            await tx.productCategory.createMany({
              data: categoryIds.map((categoryId) => ({ productId: existingId, categoryId, tenantId })),
            });
          }

          updated += 1;
        } else {
          await tx.product.create({
            data: {
              tenantId,
              ...data,
              sku: row.sku,
              images: row.imageUrls.length
                ? { create: row.imageUrls.map((url, position) => ({ tenantId, url, position })) }
                : undefined,
              categories: categoryIds.length
                ? { create: categoryIds.map((categoryId) => ({ categoryId, tenantId })) }
                : undefined,
            },
          });
          created += 1;
        }
      }

      return { created, updated };
    });

    // AuditLog.entityId is nullable in the schema, but writeAudit's signature
    // requires a string — there's no single Product this bulk operation is
    // "about", so the tenant id stands in as the audited entity.
    await writeAudit(session, 'csv_import', 'Product', tenantId, result);
    return result;
  }
}
