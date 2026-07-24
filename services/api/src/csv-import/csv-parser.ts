import Papa from 'papaparse';
import { CSV_ROW_MESSAGES, csvProductRowSchema, type CsvProductRow, type TaxRateValue } from '@ventia/core';

// Deliberately no direct `zod` import here (or anywhere else in
// services/api's own source): the row-level validation schema itself lives
// in @ventia/core (csvProductRowSchema) — see catalog/parse.ts's comment on
// the better-auth/zod-v3-vs-v4 peer-resolution hazard that adding `zod` as a
// dependency of this package would reintroduce. This module only calls
// `.safeParse()` on the schema core already built.

/** One row-level validation problem, in Spanish (es-CO) per the product spec. */
export interface RowError {
  row: number;
  column: string;
  message: string;
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
}

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
