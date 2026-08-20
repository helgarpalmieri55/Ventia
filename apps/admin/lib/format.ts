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

// ---- Bogotá-pinned dates --------------------------------------------
//
// `formatDateCO` above formats in the RUNTIME's time zone, which is right for
// the merchant admin (a Colombian merchant on a Colombian laptop) and wrong
// for anything whose meaning is a calendar day the API computed.
//
// The subscription surface is exactly that case. `paidUntil: '2026-09-01'` is
// stored by the API as the END of that Bogotá day — `2026-09-01T23:59:59.999-05:00`,
// i.e. `2026-09-02T04:59:59.999Z` on the wire. Formatted in UTC (or in any
// zone east of Bogotá) that renders as **2 September**: the operator is shown
// a different day than the one they typed, and the derived `suspendsOn` is
// shown a day later than the day the sweep will actually take the store
// offline. Pinning the zone is what makes "se suspende el 8 de septiembre"
// mean the 8th.
//
// One shared constant, because a second literal is a second answer.

export const BOGOTA_TIME_ZONE = 'America/Bogota';

const bogotaShortDate = new Intl.DateTimeFormat('es-CO', {
  timeZone: BOGOTA_TIME_ZONE,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

const bogotaLongDate = new Intl.DateTimeFormat('es-CO', {
  timeZone: BOGOTA_TIME_ZONE,
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

// `en-CA` is the locale whose short numeric date IS `YYYY-MM-DD`, which is
// what `<input type="date">` requires and what the API's `paidUntil` accepts.
// Formatting through Intl rather than slicing `toISOString()` is the whole
// point: the slice would give the UTC day.
const bogotaDateInput = new Intl.DateTimeFormat('en-CA', {
  timeZone: BOGOTA_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function toDate(value: string | Date): Date | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** `'2026-09-02T04:59:59.999Z'` -> `'01/09/2026'` (the Bogotá day). `null`
 * for anything unparseable, so the caller decides what a missing date looks
 * like rather than getting "Invalid Date" rendered at a user. */
export function formatDateBogota(value: string | Date): string | null {
  const date = toDate(value);
  return date ? bogotaShortDate.format(date) : null;
}

/** `'2026-09-09T04:59:59.999Z'` -> `'8 de septiembre de 2026'`. Used for the
 * one sentence an operator has to read as prose — the date a store goes
 * offline. */
export function formatLongDateBogota(value: string | Date): string | null {
  const date = toDate(value);
  return date ? bogotaLongDate.format(date) : null;
}

/** The Bogotá calendar day of an instant, as `YYYY-MM-DD` — the value an
 * `<input type="date">` holds and the value the API's `paidUntil` accepts.
 * Round-trips: what the operator sees in the field is the day the API will
 * store back. */
export function toBogotaDateInput(value: string | Date): string | null {
  const date = toDate(value);
  return date ? bogotaDateInput.format(date) : null;
}
