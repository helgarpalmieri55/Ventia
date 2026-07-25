const formatter = new Intl.NumberFormat('es-CO', {
  style: 'currency',
  currency: 'COP',
  maximumFractionDigits: 0,
});

// U+00A0 NO-BREAK SPACE: what Intl actually inserts between the currency
// symbol and the digits (see the doc comment below) — named explicitly via
// escape so the source has no invisible/ambiguous whitespace in it.
const NBSP = ' ';

/** Formats integer cents as an es-CO COP amount with no decimals, e.g.
 * `formatCOP(4590000) -> "$ 45.900"`.
 *
 * Convention check (per the seed data and `packages/db/prisma/schema.prisma`'s
 * `priceCents Int` / `services/api/src/catalog/products.service.ts`): a
 * product's price is stored as cents where 100 cents = 1 peso — NOT the
 * fractional-currency sense USD cents would imply. So `cents / 100` is the
 * peso amount to render, and `Math.round` guards against ever being handed a
 * non-multiple-of-100 value (shouldn't happen in practice, but keeps the
 * displayed amount an integer peso figure either way rather than leaving it
 * to `Intl`'s own rounding of a fractional peso amount).
 *
 * `Intl.NumberFormat('es-CO', ...).format(...)` renders the currency symbol
 * followed by a NO-BREAK SPACE (e.g. `"$ 45.900"`), not a regular
 * space — normalized here to an ordinary space (U+0020) so callers get the
 * exact `"$ 45.900"` shape (search/copy-paste/string-equality all behave
 * more predictably with a plain space than an invisible NBSP). */
export function formatCOP(cents: number): string {
  const pesos = Math.round(cents / 100);
  return formatter.format(pesos).replaceAll(NBSP, ' ');
}
