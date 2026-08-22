import type { DashboardAiResolution, DashboardKpi } from '@ventia/core';

/**
 * The arithmetic behind the four tiles, kept pure and apart from the queries
 * so the interesting decisions can be tested without a database.
 *
 * Every function here has the same job: refuse to invent a number. A brand-new
 * store and a store having a bad week must not be rendered the same way, and
 * neither may be rendered as `Infinity`, `NaN` or a triumphant `+100%`.
 */

/**
 * Percentage change against the previous window, or `null` when there is no
 * honest one.
 *
 * `previous === 0` is the whole point. The three tempting answers are all
 * wrong in the same way:
 *
 *   - `Infinity` / `NaN` — leaks a division into the JSON, and
 *     `JSON.stringify` turns both into `null` anyway, but only after
 *     something downstream has already tried to render them.
 *   - `+100%` — the arithmetic for "doubled", claimed for a store that went
 *     from nothing to its first sale. It reads as growth against a real base
 *     and there is no base at all.
 *   - `0%` — reads as "no change" for the most eventful week the store has
 *     had.
 *
 * `null` says the only true thing: this window has nothing to be compared
 * against. Every consumer has to handle it, which is the intent.
 */
export function changePct(value: number, previous: number): number | null {
  if (previous === 0) return null;
  return Math.round(((value - previous) / previous) * 100);
}

/** Assembles one count/money tile. */
export function kpi(value: number, previous: number): DashboardKpi {
  return { value, previous, changePct: changePct(value, previous) };
}

/**
 * Share of conversations the agent finished WITHOUT pulling in a person, as a
 * percentage with one decimal, or `null` when there were no conversations.
 *
 * One decimal rather than a whole number because whole-number rounding turns
 * 99.6% into a flat "100%" — a tile claiming the agent has never once needed
 * help, on a store where it needed help this morning. The raw counts travel
 * with it (see {@link aiResolution}) so a merchant can always see the
 * denominator behind the percentage.
 */
export function resolutionPct(conversations: number, handedToHuman: number): number | null {
  if (conversations === 0) return null;
  return round1(((conversations - handedToHuman) / conversations) * 100);
}

/**
 * The AI-resolution tile.
 *
 * The comparison is in percentage POINTS, deliberately. A rate that moves from
 * 40% to 50% has risen ten points; expressing that as "+25%" is a true
 * sentence about a ratio of ratios that no one reads correctly at a glance,
 * and it makes a store improving from 4% to 5% look identical to one
 * improving from 40% to 50%.
 *
 * Null propagates: no conversations in either window means no comparison,
 * for the same reason `changePct` refuses a zero base.
 */
export function aiResolution(
  current: { conversations: number; handedToHuman: number },
  previous: { conversations: number; handedToHuman: number },
): DashboardAiResolution {
  const ratePct = resolutionPct(current.conversations, current.handedToHuman);
  const previousRatePct = resolutionPct(previous.conversations, previous.handedToHuman);
  return {
    ratePct,
    previousRatePct,
    changePoints: ratePct === null || previousRatePct === null ? null : round1(ratePct - previousRatePct),
    conversations: current.conversations,
    handedToHuman: current.handedToHuman,
  };
}

/**
 * A slice's share of the window, or `null` when the window holds no orders.
 *
 * `null` and not `0`: on an empty store every slice would otherwise report a
 * confident 0%, which draws as a legend full of measurements next to a ring
 * with nothing in it. Null lets the UI show "aún no hay ventas" once, for the
 * whole chart.
 */
export function sharePct(part: number, total: number): number | null {
  if (total === 0) return null;
  return round1((part / total) * 100);
}

/** One decimal place, without the floating-point tail that `toFixed` + parse
 * leaves behind on values like 33.33333333333333. */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
