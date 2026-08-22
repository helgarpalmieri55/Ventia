// A local copy of `apps/admin/lib/format.ts`'s `formatCOP` (per the design
// doc's YAGNI note: 8 lines isn't worth a shared package) — deliberately not
// imported cross-app. The storefront only ever *displays* prices (no
// pesos-typed-into-a-form-input concern like the admin app's product editor
// has), so `pesosToCents`/`centsToPesos` aren't copied here — see this task's
// report if a future storefront feature needs them.
const formatter = new Intl.NumberFormat('es-CO', {
  style: 'currency',
  currency: 'COP',
  maximumFractionDigits: 0,
});

// U+00A0 NO-BREAK SPACE: what Intl actually inserts between the currency
// symbol and the digits — named explicitly via escape so the source has no
// invisible/ambiguous whitespace in it.
const NBSP = ' ';

/** Formats integer cents as an es-CO COP amount with no decimals, e.g.
 * `formatCOP(4590000) -> "$ 45.900"`. Same convention as the admin app's
 * `formatCOP`: `Math.round(cents / 100)` pesos, NBSP normalized to a plain
 * space. See `apps/admin/lib/format.ts` for the full rationale. */
export function formatCOP(cents: number): string {
  const pesos = Math.round(cents / 100);
  return formatter.format(pesos).replaceAll(NBSP, ' ');
}

/** es-CO count of products for a category tile or menu entry, e.g.
 * `formatProductCount(1) -> "1 producto"`. Here rather than inline in the page
 * because "1 productos" is the kind of copy nobody re-reads after writing it,
 * and a store's home page is the first thing a merchant shows a customer. */
export function formatProductCount(count: number): string {
  return count === 1 ? '1 producto' : `${count} productos`;
}
