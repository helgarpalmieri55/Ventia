/**
 * Civil-day arithmetic in Colombian time, for the tablero.
 *
 * ## Why the dashboard cannot use UTC days
 *
 * "Hoy" for a merchant in Medellín runs from 00:00 to 24:00 COT. A UTC day
 * runs from 19:00 the previous evening to 19:00 today in their reckoning, so
 * a UTC-bucketed dashboard credits every sale made after 7 p.m. to tomorrow.
 * On a store whose evening is its busiest hour that is not a rounding error:
 * the "hoy" tile reads low all day and then jumps at 7 p.m. for no reason the
 * merchant can see, and yesterday's total keeps changing after midnight.
 *
 * ## Why a fixed offset rather than `Intl` or a tz database
 *
 * Same reasoning as `settings/document-template.ts`'s `formatSpanishDate`,
 * and deliberately the same constant: Colombia is UTC-5 all year and has not
 * observed DST since 1993, so `-5h` is EXACT here, not an approximation.
 * `Intl.DateTimeFormat` would make the answer depend on the Node build's ICU
 * data — a `small-icu` runtime silently falls back and would bucket a
 * merchant's sales into the wrong day — and a zone database would be a
 * dependency bought for a country that does not need one.
 *
 * If Colombia ever adopts DST (it is proposed every few years), this file is
 * the single place that has to learn about it, and the tests below it are the
 * ones that will fail.
 */

/** Milliseconds `America/Bogota` runs BEHIND UTC. */
export const BOGOTA_OFFSET_MS = 5 * 60 * 60 * 1000;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** The `YYYY-MM-DD` civil day an instant falls on in Bogota. */
export function bogotaDayOf(instant: Date): string {
  const shifted = new Date(instant.getTime() - BOGOTA_OFFSET_MS);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** The instant a Bogota civil day begins, as a UTC `Date`.
 *
 * `2026-08-21` -> `2026-08-21T05:00:00Z`. Used as an INCLUSIVE lower bound and,
 * for the day after the range's end, as an EXCLUSIVE upper bound — half-open
 * intervals, so an order created at exactly midnight belongs to one day and
 * not to two. */
export function startOfBogotaDay(day: string): Date {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + BOGOTA_OFFSET_MS);
}

/** The civil day `n` days after `day` (negative `n` goes back).
 *
 * Goes through `Date.UTC` rather than string arithmetic so month and year
 * boundaries, and leap days, are the calendar's problem and not this file's. */
export function addBogotaDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return isoDay(new Date(Date.UTC(y, m - 1, d) + n * MS_PER_DAY));
}

/** Days in the INCLUSIVE range `[from, to]`. `daysInRange('2026-08-21',
 * '2026-08-21')` is 1 — a one-day range is one day, not zero. */
export function daysInRange(from: string, to: string): number {
  const a = startOfBogotaDay(from).getTime();
  const b = startOfBogotaDay(to).getTime();
  return Math.round((b - a) / MS_PER_DAY) + 1;
}

/** Every civil day in the inclusive range, ascending. Drives the zero-filled
 * sales series, so the chart has a point for every day the merchant asked
 * about rather than only for the days that happened to sell. */
export function eachBogotaDay(from: string, to: string): string[] {
  const days: string[] = [];
  for (let day = from; day <= to; day = addBogotaDays(day, 1)) days.push(day);
  return days;
}

function isoDay(utc: Date): string {
  const y = utc.getUTCFullYear();
  const m = String(utc.getUTCMonth() + 1).padStart(2, '0');
  const d = String(utc.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
