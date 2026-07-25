const formatter = new Intl.NumberFormat('es-CO', {
  style: 'currency',
  currency: 'COP',
  maximumFractionDigits: 0,
});

const dateFormatter = new Intl.DateTimeFormat('es-CO', { day: '2-digit', month: '2-digit', year: 'numeric' });

/** Formats an ISO date string (or `Date`) as an es-CO short date, e.g.
 * `formatDateCO('2026-07-25T12:00:00.000Z') -> "25/07/2026"` — used for the
 * "fecha"/"expira" columns on the equipo page's members and invites tables. */
export function formatDateCO(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  return dateFormatter.format(date);
}

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

/** Converts a peso amount (as typed into a form's price input, e.g. "45900")
 * into integer cents for the API's `priceCents` field — the inverse of the
 * `cents / 100` convention documented on {@link formatCOP}. Accepts either a
 * `number` or a raw string (trimmed before parsing, so " 45900 " and "45900"
 * behave identically). Returns `null` — rather than silently coercing to `0`
 * or `NaN` — for anything that isn't a non-negative finite number, so a
 * caller can turn that into a field error instead of submitting a bogus
 * price. `Math.round` guards the rare fractional-peso-cent case (e.g.
 * "45900.005" pesos -> 4590000.5 cents -> rounds to 4590001). */
export function pesosToCents(pesos: string | number): number | null {
  const trimmed = typeof pesos === 'string' ? pesos.trim() : pesos;
  if (trimmed === '') return null;
  const n = typeof trimmed === 'string' ? Number(trimmed) : trimmed;
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

/** Converts integer cents back to a peso amount for populating an *editable*
 * price input (e.g. the edit form's initial value from `GET /v1/admin/products/:id`).
 * Unlike {@link formatCOP} (a display formatter that intentionally rounds to
 * a whole peso), this preserves any fractional-peso remainder exactly so
 * round-tripping a value through {@link pesosToCents} and back doesn't lose
 * precision while the merchant is still editing it. */
export function centsToPesos(cents: number): number {
  return cents / 100;
}
