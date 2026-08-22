import { HttpException } from '@nestjs/common';
import {
  DASHBOARD_DEFAULT_RANGE_DAYS,
  DASHBOARD_MAX_RANGE_DAYS,
  type DashboardQuery,
  type DashboardRange,
} from '@ventia/core';
import { addBogotaDays, bogotaDayOf, daysInRange } from './bogota-day';

/**
 * Which window the tablero answers about, and which window it compares
 * against.
 *
 * Split out of `dashboard.service.ts` so both decisions can be exercised
 * without a database — they are the two judgement calls in this feature most
 * likely to be argued with later, and an argument settled by running a test is
 * shorter than one settled by reading a query.
 */

/**
 * Resolves the requested window, filling in defaults from the clock.
 *
 * Defaults to the last {@link DASHBOARD_DEFAULT_RANGE_DAYS} days ENDING TODAY
 * in Bogota, inclusive of today — a merchant opening the tablero at 10 a.m.
 * wants this morning's sales in it, not a window that ends last night.
 *
 * `from` alone means "from then until today"; `to` alone means "the default
 * window ending then", which is what a caller paging back through history
 * wants.
 *
 * The span cap is enforced here rather than in the schema because only a
 * clock can measure the span of a request that omits a bound. It is a 400 and
 * not a silent truncation: a dashboard that quietly answers about a different
 * range than the one in the URL is worse than one that says no.
 */
export function resolveRange(query: DashboardQuery, now: Date): DashboardRange {
  const today = bogotaDayOf(now);
  const to = query.to ?? today;
  const from = query.from ?? addBogotaDays(to, -(DASHBOARD_DEFAULT_RANGE_DAYS - 1));

  if (from > to) {
    // Reachable only through the `to`-alone path (the schema already rejects an
    // explicit from > to): `?to=2020-01-01` with no `from` is fine, but a
    // caller could otherwise hand us `from` in the future and `to` from the
    // clock.
    throw new HttpException(
      { error: 'VALIDATION_FAILED', details: { from: 'from no puede ser posterior a to' } },
      400,
    );
  }

  const days = daysInRange(from, to);
  if (days > DASHBOARD_MAX_RANGE_DAYS) {
    throw new HttpException(
      {
        error: 'VALIDATION_FAILED',
        details: { range: `el rango no puede superar ${DASHBOARD_MAX_RANGE_DAYS} días` },
      },
      400,
    );
  }

  return { from, to, days };
}

/**
 * The window the KPIs compare against: the same number of days, ending the day
 * before `range` starts.
 *
 * "vs ayer" — what the design's tiles say — is only meaningful for a one-day
 * range, and it is exactly what this rule produces for one: ask for
 * `from=to=hoy` and the comparison window is yesterday. For a 30-day range the
 * honest comparison is the 30 days before it, not yesterday, and not "the same
 * range last month" (months are 28 to 31 days long, so that comparison
 * silently changes the denominator and would make February look like a
 * disaster every year).
 *
 * Immediately preceding rather than the same weekdays a year ago: retail is
 * weekly-seasonal, so a 7-day or 14-day window compares like with like here,
 * and a merchant can always ask for two explicit ranges if they want a
 * year-on-year read.
 */
export function previousWindow(range: DashboardRange): DashboardRange {
  const to = addBogotaDays(range.from, -1);
  const from = addBogotaDays(to, -(range.days - 1));
  return { from, to, days: range.days };
}
