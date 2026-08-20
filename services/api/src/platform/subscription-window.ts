/**
 * The two dates the manual subscription feature turns on: when a merchant gets
 * warned, and when their store goes offline (docs/SPEC.md §6 M9 — "auto-suspend
 * N days past due (configurable, default 7) with warning email at N-3").
 *
 * These live in their own file rather than in the sweep worker because two
 * unrelated callers need them and neither may import the other:
 * `subscription-sweep.worker.ts` acts on them, and `platform.service.ts`
 * REPORTS them on the tenant-detail read, so an operator sees the same
 * `suspendsOn` date the job will act on. A second copy of `paidUntil + N days`
 * in the read path would be a second source of truth for when a store dies.
 */

/** SPEC's default. Overridden per deployment by `SUBSCRIPTION_GRACE_DAYS`. */
const DEFAULT_GRACE_DAYS = 7;

/**
 * SPEC's "warning email at N-3" — three days of notice before suspension, not
 * a configurable second knob. One number to reason about is enough; the notice
 * period is a property of the product's promise, not of a deployment.
 */
export const WARNING_LEAD_DAYS = 3;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The grace window in days, from env, with the same posture as
 * `retentionMonths()` in agent/conversation-retention.worker.ts and
 * `RATE_LIMITS` in common/rate-limit.ts: optional, and a malformed value falls
 * back to the default instead of being propagated.
 *
 * Both rejected shapes would take stores offline that should not be:
 *
 *  - `NaN` days makes the cutoff an Invalid Date, and every `paidUntil <
 *    cutoff` comparison against it is FALSE — which fails safe (nobody is
 *    suspended) but silently, so a deployment could run for months believing
 *    it had auto-suspension when it had none.
 *  - `0` or a negative would put the suspension cutoff at or after "now",
 *    suspending every merchant the moment their paid period ends, with no
 *    grace at all and — since the warning fires at N-3, i.e. already in the
 *    past — no warning either.
 *
 * So: integer, strictly positive, or 7.
 */
export function subscriptionGraceDays(): number {
  const raw = process.env.SUBSCRIPTION_GRACE_DAYS;
  if (raw === undefined) return DEFAULT_GRACE_DAYS;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_GRACE_DAYS;
}

/**
 * How many days past `paidUntil` the warning goes out: N-3.
 *
 * Clamped at 0 for the degenerate configuration `SUBSCRIPTION_GRACE_DAYS <= 3`,
 * where N-3 would be a NEGATIVE offset — a warning sent before the merchant is
 * even late. Sending it the moment they go past due is the closest honest
 * reading of "warn before you suspend" in a window too short to give three
 * days of notice, and it keeps the invariant the sweep depends on: the warning
 * threshold is never later than the suspension threshold.
 */
export function warningLeadDaysPastDue(graceDays: number = subscriptionGraceDays()): number {
  return Math.max(0, graceDays - WARNING_LEAD_DAYS);
}

/** `date` plus `days`, in whole days of 86 400 000 ms.
 *
 * UTC-arithmetic on purpose (no calendar month/DST handling like
 * `retentionCutoff`'s): Colombia has no daylight saving, the window is a
 * handful of days rather than months, and the operator-facing meaning of "7
 * days" here is 7 × 24 h. */
export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * MS_PER_DAY);
}

/** The instant this subscription's tenant becomes suspendable. */
export function suspensionDueAt(paidUntil: Date, graceDays: number = subscriptionGraceDays()): Date {
  return addDays(paidUntil, graceDays);
}

/** The instant this subscription's tenant becomes warnable. */
export function warningDueAt(paidUntil: Date, graceDays: number = subscriptionGraceDays()): Date {
  return addDays(paidUntil, warningLeadDaysPastDue(graceDays));
}

/**
 * What an operator (and the admin UI) is shown about where a subscription sits
 * in its cycle. Derived, never stored — a stored copy would go stale the
 * moment the clock moved.
 *
 *  - `sin_fecha`  — no `paidUntil` recorded. The sweep ignores it entirely.
 *  - `al_dia`     — paid period has not ended.
 *  - `vencida`    — past due, inside the grace window.
 *  - `por_suspender` — past due AND past the warning threshold; the warning
 *                   email has gone out (or goes out on the next sweep).
 *  - `suspendible` — past the grace window; the next sweep takes the store
 *                   offline (or already did).
 */
export type SubscriptionDueState = 'sin_fecha' | 'al_dia' | 'vencida' | 'por_suspender' | 'suspendible';

export interface SubscriptionWindow {
  state: SubscriptionDueState;
  /** Null when there is no `paidUntil` to count from. */
  suspendsOn: Date | null;
  warnsOn: Date | null;
  graceDays: number;
  /** Whole days past `paidUntil`, floored; 0 while still paid. */
  daysPastDue: number;
}

export function subscriptionWindow(
  paidUntil: Date | null,
  now: Date = new Date(),
  graceDays: number = subscriptionGraceDays(),
): SubscriptionWindow {
  if (!paidUntil) {
    return { state: 'sin_fecha', suspendsOn: null, warnsOn: null, graceDays, daysPastDue: 0 };
  }
  const suspendsOn = suspensionDueAt(paidUntil, graceDays);
  const warnsOn = warningDueAt(paidUntil, graceDays);
  const daysPastDue = Math.max(0, Math.floor((now.getTime() - paidUntil.getTime()) / MS_PER_DAY));

  const state: SubscriptionDueState =
    now >= suspendsOn ? 'suspendible' : now >= warnsOn ? 'por_suspender' : now >= paidUntil ? 'vencida' : 'al_dia';

  return { state, suspendsOn, warnsOn, graceDays, daysPastDue };
}
