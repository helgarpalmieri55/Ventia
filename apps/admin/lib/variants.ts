import type { VariantsReplace } from '@ventia/core';
import { pesosToCents } from './format';

/** One row of the variants editor's table, in the shape the form actually
 * holds as controlled-input state: everything is a raw string (or a
 * fixed-length string array for the option-value columns, aligned 1:1 with
 * the option *labels* array passed to {@link buildVariantsPayload} — index 0
 * of `values` is this row's value for label[0], etc., regardless of which
 * labels end up blank/kept). */
export interface VariantRowInput {
  values: string[];
  priceCentsPesos: string;
  sku: string;
  stock: string;
}

type Variant = VariantsReplace['variants'][number];

/** Builds the `PUT /:id/variants` request body (`variantsReplaceSchema`'s
 * input shape) from the variants editor's raw form state:
 *
 * - `labels` (up to 3 option-name text inputs) are trimmed and blank ones are
 *   dropped, preserving relative order — so `['Talla', '', 'Color']` becomes
 *   `options: ['Talla', 'Color']`, and only the first 3 labels are
 *   considered (`variantsReplaceSchema.options` caps at 3).
 * - Each row's `values` are read at the *original* label indices that
 *   survived the blank-label filter above (so a blank middle label doesn't
 *   leave a gap — `option2` in the output always corresponds to whichever
 *   label ended up second, not the row's original index 1), then assigned
 *   positionally to `option1`/`option2`/`option3`.
 * - A row is dropped entirely when every field is blank (no option values,
 *   no sku, no price, no stock) — this lets the editor keep a permanently
 *   empty trailing row for "add a variant" without the caller needing to
 *   manage add/remove bookkeeping.
 * - `priceCentsPesos` (pesos, as typed) converts via {@link pesosToCents};
 *   blank or unparseable input omits `priceCents` entirely (the schema
 *   already treats it as optional) rather than sending a bogus value.
 * - `stock` blank defaults to `0` (matching `variantsReplaceSchema`'s own
 *   default), otherwise parses as a plain integer.
 * - All string fields are trimmed; an empty-after-trim value is omitted
 *   (`option1`/`option2`/`option3`/`sku` are all optional in the schema).
 */
export function buildVariantsPayload(labels: string[], rows: VariantRowInput[]): VariantsReplace {
  const keptIndices: number[] = [];
  const options: string[] = [];
  for (const [index, label] of labels.slice(0, 3).entries()) {
    const trimmed = label.trim();
    if (trimmed) {
      options.push(trimmed);
      keptIndices.push(index);
    }
  }

  const variants: Variant[] = [];
  for (const row of rows) {
    const values = keptIndices.map((index) => (row.values[index] ?? '').trim());
    const sku = row.sku.trim();
    const priceCentsPesos = row.priceCentsPesos.trim();
    const stockRaw = row.stock.trim();

    const isBlankRow = values.every((v) => v === '') && sku === '' && priceCentsPesos === '' && stockRaw === '';
    if (isBlankRow) continue;

    const priceCents = priceCentsPesos === '' ? null : pesosToCents(priceCentsPesos);
    const stockParsed = stockRaw === '' ? 0 : Number(stockRaw);
    const stock = Number.isFinite(stockParsed) && stockParsed >= 0 ? Math.trunc(stockParsed) : 0;

    const variant: Variant = { stock };
    if (values[0]) variant.option1 = values[0];
    if (values[1]) variant.option2 = values[1];
    if (values[2]) variant.option3 = values[2];
    if (sku) variant.sku = sku;
    if (priceCents !== null) variant.priceCents = priceCents;
    variants.push(variant);
  }

  return { options, variants };
}
