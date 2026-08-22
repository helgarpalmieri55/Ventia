import type { AgentCommandBudget, AgentCommandRefusalReason } from '@ventia/core';

/**
 * Who gets the last AI message of the month — the merchant asking questions,
 * or the shopper the storefront is trying to sell to.
 *
 * Split out of `agent-command.service.ts`, and structurally typed rather than
 * importing Prisma or the budget service, so the whole decision can be
 * exercised with no database, no Redis and no model. That is the same split
 * `dashboard-range.ts` keeps, for the same reason: this is the judgement call
 * in this feature most likely to be argued with later, and an argument settled
 * by running a test is shorter than one settled by reading a loop.
 *
 * ## The decision
 *
 * The merchant assistant and the shopper agent spend ONE counter,
 * `TenantLimits.aiMessagesMonth`. That was chosen deliberately (the plan sells
 * "mensajes de IA"; a second quota would be a number nobody was sold), and it
 * creates a consequence worth stating plainly:
 *
 *   **A merchant who spends the month's allowance on business questions makes
 *   their own storefront go silent.**
 *
 * The shopper agent is what earns the merchant money. An owner exploring their
 * numbers on the 3rd could leave every customer for the next four weeks
 * hearing `BUDGET_EXHAUSTED_REPLY`, with nothing in the product connecting the
 * two events.
 *
 * So the merchant assistant yields first: it stops at
 * `limit - shopperReserve`, while the shopper agent keeps its full
 * `aiMessagesMonth`. Nothing here changes what the storefront may spend —
 * `AgentBudgetService.check()` is untouched — this is a ceiling this surface
 * puts on ITSELF. The one whose silence costs the merchant nothing is the one
 * that goes quiet.
 */

/**
 * The share of the monthly allowance the merchant assistant will not touch.
 *
 * A fraction rather than a fixed count so it scales with the plan: 20% of
 * básico's 500 leaves 100 shopper messages after the owner has spent
 * everything else, and a larger plan reserves proportionally more. A fixed
 * number would be either meaningless on a big plan or swallow a small one
 * whole.
 *
 * Rounded UP, so a small plan still reserves something rather than rounding
 * its protection away to zero.
 */
export const SHOPPER_RESERVE_FRACTION = 0.2;

/** The month's usage, as this module needs it. Declared structurally rather
 * than importing `BudgetStatus` so this file pulls in no database client —
 * `AgentBudgetService.check()`'s return value satisfies it as-is. */
export interface MonthlyUsage {
  used: number;
  limit: number;
  warning: boolean;
}

/** What the merchant is shown, plus whether this question may run at all. */
export interface CommandBudgetDecision {
  budget: AgentCommandBudget;
  /** `null` when the question may be answered. Otherwise why it was refused —
   * the two cases are different problems with different remedies, so the API
   * reports which one applies rather than one generic "sin cupo". */
  refusal: AgentCommandRefusalReason | null;
}

/**
 * The reserve arithmetic, and the two boundaries that matter.
 *
 * `exhausted` is checked FIRST and is the stronger statement: when the whole
 * allowance is gone there is no reserve left to protect, and telling a
 * merchant "lo estoy guardando para tus clientes" at that moment would be
 * false — their customers are getting the fallback sentence too. Reversing
 * these two lines makes the endpoint lie at exactly the moment the merchant
 * most needs to know to upgrade.
 */
export function decideCommandBudget(usage: MonthlyUsage): CommandBudgetDecision {
  const shopperReserve = Math.ceil(usage.limit * SHOPPER_RESERVE_FRACTION);
  const budget: AgentCommandBudget = {
    used: usage.used,
    limit: usage.limit,
    shopperReserve,
    // Clamped at zero in both cases. A negative "te quedan" is meaningless to
    // a merchant, and an unprovisioned tenant (limit 0) would otherwise report
    // a negative remainder rather than plainly none.
    remainingForCommands: Math.max(0, usage.limit - shopperReserve - usage.used),
    remainingTotal: Math.max(0, usage.limit - usage.used),
    warning: usage.warning,
  };

  if (budget.remainingTotal <= 0) return { budget, refusal: 'exhausted' };
  if (budget.remainingForCommands <= 0) return { budget, refusal: 'shopper_reserve' };
  return { budget, refusal: null };
}

/** The budget as it stands AFTER this question is recorded, which is what the
 * merchant should be shown: "te quedan N" has to mean N more questions, not N
 * including the one they just asked. */
export function budgetAfterAnswering(usage: MonthlyUsage): AgentCommandBudget {
  return decideCommandBudget({ ...usage, used: usage.used + 1 }).budget;
}
