import Papa from 'papaparse';
import { CSV_ROW_MESSAGES, csvProductRowSchema, type CsvProductRow, type TaxRateValue } from '@ventia/core';

// Deliberately no direct `zod` import here (or anywhere else in
// services/api's own source): the row-level validation schema itself lives
// in @ventia/core (csvProductRowSchema) — see catalog/parse.ts's comment on
// the better-auth/zod-v3-vs-v4 peer-resolution hazard that adding `zod` as a
// dependency of this package would reintroduce. This module only calls
// `.safeParse()` on the schema core already built.

/** One row-level validation problem, in Spanish (es-CO) per the product spec.
 * `row: 0` is reserved for file-level problems (papaparse's own tokenizer
 * errors — a malformed CSV, not a bad value in an otherwise well-formed
 * row), since data rows are numbered from 1. */
export interface RowError {
  row: number;
  column: string;
  message: string;
}

/** Which optional columns this row's CSV cell actually carried a value for,
 * as opposed to being blank/omitted. The commit path (csv-import.service.ts)
 * needs this distinction for its PATCH-like update semantics: on an existing
 * SKU, a blank cell means "leave the current product value alone", not
 * "reset it to this column's create-time default". `stock`/`trackInventory`/
 * `taxRate`/`status`/`descriptionMd` all have a baked-in default on
 * `ParsedRow` itself (so `rows[]` stays directly usable for the CREATE path
 * unchanged), which is exactly why those five need an explicit flag here —
 * once defaulted, the row's own field can no longer tell "not provided"
 * apart from "explicitly set to the default value". `slug`/`compareAtCents`/
 * `barcode` don't need a flag: they carry no baked-in default and stay
 * `undefined` when blank, so `!== undefined` already means "provided". */
export interface ProvidedColumns {
  descriptionMd: boolean;
  stock: boolean;
  trackInventory: boolean;
  taxRate: boolean;
  status: boolean;
  categoryNames: boolean;
  imageUrls: boolean;
}

/** A single successfully-validated CSV row, normalized into the shape the
 * commit/dry-run service works with (arrays split out of the pipe-separated
 * `categories`/`image_urls` columns, tax rate as the human-facing string). */
export interface ParsedRow {
  row: number;
  name: string;
  slug?: string;
  descriptionMd: string;
  priceCents: number;
  compareAtCents?: number;
  sku: string;
  barcode?: string;
  stock: number;
  trackInventory: boolean;
  taxRate: TaxRateValue;
  status: 'draft' | 'active';
  categoryNames: string[];
  imageUrls: string[];
  provided: ProvidedColumns;
}

const MALFORMED_CSV_MESSAGE = 'archivo CSV malformado';

function splitPipeList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split('|')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function toParsedRow(raw: CsvProductRow, rowNumber: number): ParsedRow {
  return {
    row: rowNumber,
    name: raw.name,
    slug: raw.slug,
    descriptionMd: raw.description ?? '',
    priceCents: raw.price_cents,
    compareAtCents: raw.compare_at_cents,
    sku: raw.sku,
    barcode: raw.barcode,
    stock: raw.stock ?? 0,
    trackInventory: raw.track_inventory !== 'false',
    taxRate: raw.tax_rate ?? '19',
    status: raw.status ?? 'draft',
    categoryNames: splitPipeList(raw.categories),
    imageUrls: splitPipeList(raw.image_urls),
    provided: {
      descriptionMd: raw.description !== undefined,
      stock: raw.stock !== undefined,
      trackInventory: raw.track_inventory !== undefined,
      taxRate: raw.tax_rate !== undefined,
      status: raw.status !== undefined,
      categoryNames: raw.categories !== undefined,
      imageUrls: raw.image_urls !== undefined,
    },
  };
}

/**
 * Pure CSV -> validated-row parser for the product import feature (spec M2).
 * No I/O: takes the raw CSV text, returns the rows that passed validation
 * plus every row-level error found (Spanish, es-CO messages). Row numbering
 * is 1-based over data rows only (the header line is not row 1).
 */
export function parseProductsCsv(text: string): { rows: ParsedRow[]; errors: RowError[] } {
  const parsed = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true });

  const errors: RowError[] = [];
  const rows: ParsedRow[] = [];
  const seenSkus = new Set<string>();

  // papaparse's own tokenizer errors (e.g. an unterminated quote, or a row
  // with a wildly different field count than the header) are file-level
  // problems, not a bad value in an otherwise well-formed row — surfaced as
  // one row:0 error rather than silently dropped or spread across whatever
  // row numbers papaparse happened to attribute them to.
  if (parsed.errors.length > 0) {
    errors.push({ row: 0, column: 'csv', message: MALFORMED_CSV_MESSAGE });
  }

  parsed.data.forEach((raw, index) => {
    const rowNumber = index + 1;
    const result = csvProductRowSchema.safeParse(raw);
    if (!result.success) {
      for (const issue of result.error.issues) {
        errors.push({ row: rowNumber, column: String(issue.path[0] ?? ''), message: issue.message });
      }
      return;
    }

    const row = toParsedRow(result.data, rowNumber);
    let rowHasError = false;

    if (row.imageUrls.length > 0 && !row.imageUrls.every(isHttpUrl)) {
      errors.push({ row: rowNumber, column: 'image_urls', message: CSV_ROW_MESSAGES.imageUrl });
      rowHasError = true;
    }

    // Known gap (noted in task-8-report.md): a row that fails validation for
    // an unrelated reason (bad image URL, etc.) still claims its sku in
    // `seenSkus` below, so a LATER row repeating that sku is flagged as a
    // duplicate even though the earlier row was never going to be imported
    // anyway. Left as-is — fixing it means deferring dup-detection to a
    // second pass over only the rows that survive every other check, which
    // is more churn than this edge case (duplicate sku sharing a row with a
    // second, unrelated error) warrants right now.
    if (seenSkus.has(row.sku)) {
      errors.push({ row: rowNumber, column: 'sku', message: CSV_ROW_MESSAGES.duplicateSku });
      rowHasError = true;
    } else {
      seenSkus.add(row.sku);
    }

    if (!rowHasError) rows.push(row);
  });

  return { rows, errors };
}
