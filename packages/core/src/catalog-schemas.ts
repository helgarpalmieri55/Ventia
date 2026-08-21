import { z } from 'zod';

export const TAX_RATES = ['0', '5', '19', 'excluido'] as const;
export type TaxRateValue = (typeof TAX_RATES)[number];

const money = z.number().int().min(0);

export const categoryInputSchema = z.object({
  name: z.string().min(1).max(80),
  slug: z.string().min(1).max(60).optional(),
  position: z.number().int().min(0).optional(),
  // Nullable AND optional, and they mean different things: omitted leaves the
  // parent as it is (the update schema is this one `.partial()`), while an
  // explicit `null` promotes the category back to a root. Without the
  // nullable case there would be no way to un-nest one.
  //
  // Every other rule about the parent — it must exist in this tenant, it must
  // not close a cycle, the tree must stay inside MAX_CATEGORY_DEPTH — needs
  // the rest of the tenant's categories to answer, so it lives in
  // services/api/src/catalog/category-tree.ts rather than here.
  parentId: z.string().uuid().nullable().optional(),
});

export const productInputSchema = z.object({
  name: z.string().min(1).max(160),
  slug: z.string().min(1).max(60).optional(),
  descriptionMd: z.string().max(20_000).default(''),
  priceCents: money,
  compareAtCents: money.optional(),
  costCents: money.optional(),
  sku: z.string().max(64).optional(),
  barcode: z.string().max(64).optional(),
  stock: z.number().int().min(0).default(0),
  trackInventory: z.boolean().default(true),
  taxRate: z.enum(TAX_RATES).default('19'),
  status: z.enum(['draft', 'active', 'archived']).default('draft'),
  categoryIds: z.array(z.string().uuid()).max(20).default([]),
  seo: z.object({ title: z.string().max(70), description: z.string().max(160) }).partial().optional(),
});
// `stock` is deliberately excluded here (unlike productInputSchema, where it
// sets the create-time baseline): all post-create stock changes must go
// through POST /:id/stock (or the CSV import's dedicated movement-writing
// path), which guarantees an InventoryMovement audit row for every change.
// Allowing PATCH to silently overwrite `stock` would create a second,
// un-audited path to the same field.
export const productUpdateSchema = productInputSchema.omit({ stock: true }).partial();

export const variantsReplaceSchema = z.object({
  options: z.array(z.string().min(1).max(30)).min(1).max(3),
  variants: z
    .array(
      z.object({
        option1: z.string().max(60).optional(),
        option2: z.string().max(60).optional(),
        option3: z.string().max(60).optional(),
        priceCents: money.optional(),
        sku: z.string().max(64).optional(),
        stock: z.number().int().min(0).default(0),
      }),
    )
    .max(100),
});

export const presignRequestSchema = z.object({
  filename: z.string().min(1).max(200),
  contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  size: z.number().int().min(1).max(5 * 1024 * 1024),
});

export const imageConfirmSchema = z.object({
  key: z.string().min(1).max(300),
  alt: z.string().max(160).optional(),
  position: z.number().int().min(0).default(0),
});

export const stockAdjustSchema = z.object({
  variantId: z.string().uuid().optional(),
  delta: z.number().int().refine((n) => n !== 0, 'delta must be non-zero'),
  reason: z.enum(['restock', 'manual_adjust', 'correction']),
});

// Task 8 (CSV product import): request body for both the dry-run and commit
// endpoints. Kept here rather than defined ad hoc in services/api's
// csv-import.service.ts so it can go through parseOr400's ParsableSchema
// duck-typing without services/api taking a direct `zod` dependency of its
// own — see the comment in services/api/src/catalog/parse.ts about the
// better-auth/zod-v3-vs-v4 peer-resolution hazard that a direct `zod`
// dependency in that package would reintroduce.
export const csvImportRequestSchema = z.object({
  csv: z.string().min(1),
});

// Spanish (es-CO) row-error messages for the CSV product import row schema
// below. Exported so services/api/src/csv-import/csv-parser.ts can reuse the
// exact same strings for the two checks that aren't expressible as a zod
// field constraint (image URL scheme, in-file duplicate sku) without
// hardcoding a second copy of the wording.
export const CSV_ROW_MESSAGES = {
  name: 'name es obligatorio',
  priceCents: 'price_cents debe ser un entero en centavos',
  compareAtCents: 'compare_at_cents debe ser un entero en centavos',
  stock: 'stock debe ser un entero mayor o igual a 0',
  sku: 'sku es obligatorio',
  trackInventory: 'track_inventory debe ser "true", "false" o estar vacío',
  taxRate: 'tax_rate debe ser 0, 5, 19 o excluido',
  status: 'status debe ser draft o active (archived no se puede importar)',
  imageUrl: 'image_urls debe contener solo URLs http(s) válidas',
  duplicateSku: 'sku duplicado en el archivo',
} as const;

/** papaparse (with `header: true`) represents a blank cell as `''`, and a
 * wholly-missing trailing column as `undefined`. Both mean "not provided" —
 * critically, this must run BEFORE `z.coerce.number()`, because `Number('')`
 * is `0`, not `NaN`: an empty `compare_at_cents` cell would otherwise
 * silently coerce to a real price of zero instead of "not set". */
function csvBlankToUndefined(value: unknown): unknown {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string' && value.trim() === '') return undefined;
  return value;
}

function csvOptionalString(max: number, message?: string) {
  const inner = message ? z.string({ invalid_type_error: message }) : z.string();
  return z.preprocess(csvBlankToUndefined, inner.max(max, message).optional());
}

function csvRequiredString(max: number, message: string) {
  return z.preprocess(
    csvBlankToUndefined,
    z.string({ required_error: message, invalid_type_error: message }).min(1, message).max(max, message),
  );
}

function csvOptionalMoney(message: string) {
  return z.preprocess(
    csvBlankToUndefined,
    z.coerce.number({ invalid_type_error: message }).int(message).min(0, message).optional(),
  );
}

function csvRequiredMoney(message: string) {
  return z.preprocess(
    csvBlankToUndefined,
    z.coerce.number({ invalid_type_error: message }).int(message).min(0, message),
  );
}

// Row schema keys deliberately match the CSV template's column headers
// exactly (snake_case), not the camelCase used by productInputSchema:
// csv-parser.ts reads RowError.column directly off each failing zod issue's
// `path`, so keeping the two in lockstep avoids a second column-name
// translation table. `sku` is REQUIRED here (unlike productInputSchema,
// where it's optional) — it's this row schema's upsert key.
export const csvProductRowSchema = z.object({
  name: csvRequiredString(160, CSV_ROW_MESSAGES.name),
  slug: csvOptionalString(60),
  description: csvOptionalString(20_000),
  price_cents: csvRequiredMoney(CSV_ROW_MESSAGES.priceCents),
  compare_at_cents: csvOptionalMoney(CSV_ROW_MESSAGES.compareAtCents),
  sku: csvRequiredString(64, CSV_ROW_MESSAGES.sku),
  barcode: csvOptionalString(64),
  stock: csvOptionalMoney(CSV_ROW_MESSAGES.stock),
  track_inventory: z
    .preprocess(csvBlankToUndefined, z.string().optional())
    .refine((v) => v === undefined || v === 'true' || v === 'false', { message: CSV_ROW_MESSAGES.trackInventory }),
  tax_rate: z.preprocess(
    csvBlankToUndefined,
    z.enum(TAX_RATES, { errorMap: () => ({ message: CSV_ROW_MESSAGES.taxRate }) }).optional(),
  ),
  status: z.preprocess(
    csvBlankToUndefined,
    z.enum(['draft', 'active'], { errorMap: () => ({ message: CSV_ROW_MESSAGES.status }) }).optional(),
  ),
  categories: csvOptionalString(2_000),
  image_urls: csvOptionalString(4_000),
});

export type ProductInput = z.infer<typeof productInputSchema>;
export type ProductUpdate = z.infer<typeof productUpdateSchema>;
export type CategoryInput = z.infer<typeof categoryInputSchema>;
export type VariantsReplace = z.infer<typeof variantsReplaceSchema>;
export type StockAdjust = z.infer<typeof stockAdjustSchema>;
export type CsvImportRequest = z.infer<typeof csvImportRequestSchema>;
export type CsvProductRow = z.infer<typeof csvProductRowSchema>;
