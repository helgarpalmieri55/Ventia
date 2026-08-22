import { Injectable } from '@nestjs/common';
import { platformDb } from '@ventia/db';
import { creditsFor, overageCeiling, type CreditedAction } from '@ventia/core';
import { isPlanFeatureEnabledOn, loadPlanLimits } from '../common/plan-limits';
import { priceMicroUsd, type TokenCounts } from './agent-pricing';

/**
 * The per-tenant monthly AI budget.
 *
 * ## Reaching the allowance no longer silences the agent
 *
 * This used to be a hard cap: at 100% the agent stopped calling the model and
 * answered a fixed sentence. That was the wrong failure. A store hits its
 * allowance on the day it is selling most — a 20th of December, a Black Friday
 * — and a merchant does not read the silence as a quota notice. They read it
 * as the shop being broken, at the hour it costs them most, and the support
 * ticket says "se cayó la tienda", not "me quedé sin créditos".
 *
 * So credits past the allowance are billed as overage instead of refused, and
 * `warning` fires earlier (80%) so the merchant sees it coming. The merchant
 * who overspends is a merchant whose store is working.
 *
 * There is still a stop, at {@link overageCeiling} — three times the
 * allowance. That backstop is not for the honest busy store; it is for a
 * scripted abuser or a loop of ours burning credits nobody authorised, where
 * the difference between bounded and unbounded is the difference between a
 * refund and a disaster.
 *
 * ## What is counted
 *
 * CREDITS, weighted per action (see `@ventia/core`'s `CREDIT_COST`): a shopper
 * turn costs 1, a merchant question 2, because the merchant's assistant reads
 * far more context to answer and costs about twice as much. One shopper
 * question that makes the agent call three tools and the model four times is
 * still ONE credit — the merchant was sold credits, and they cannot predict
 * tool loops. Tokens are recorded alongside for cost visibility and are
 * explicitly NOT what the allowance enforces.
 *
 * ## Why the check and the increment are separate calls
 *
 * `check()` runs BEFORE the model call and `record()` runs after, rather than
 * one reserve-and-refund. A turn that fails mid-flight (a model error, a
 * dropped connection) then costs the merchant nothing, which is the right
 * direction to be wrong in: over-counting bills a merchant for something they
 * did not get, and there is no refund path.
 *
 * The cost of that ordering is a small over-run under concurrency — several
 * shoppers answered simultaneously can each pass a check that was true when
 * they read it. That is bounded by concurrency, not unbounded, and erring a
 * few messages over a monthly limit is plainly better than erring toward
 * charging for failures.
 *
 * ## Why `platformDb`
 *
 * The counter is deliberately NOT writable by tenant-scoped code — see
 * migration 20260818090000_agent_usage. A cap a tenant can write to is not a
 * cap. `platformDb` is the schema owner, so these writes are unaffected by
 * that revocation, and the `tenantId` is passed explicitly on every query.
 */

export interface BudgetStatus {
  /** Whether the agent may call the model at all for this turn. False only
   * past the overage ceiling — reaching the plan allowance does not set it. */
  allowed: boolean;
  used: number;
  limit: number;
  /** True from 80% of the allowance onward. A signal to surface, not a block;
   * earlier than the old 90% because it now warns about money about to be
   * spent rather than about a wall about to be hit. */
  warning: boolean;
  /** Credits consumed BEYOND the plan allowance this month, billed as
   * overage. Zero for the great majority of stores. */
  overage: number;
  /** Where the agent really does stop. */
  ceiling: number;
  /**
   * Whether this tenant's plan includes human handoff
   * (`TenantLimits.humanHandoff`), which decides whether `escalate_to_human` is
   * offered to the model at all.
   *
   * Not a budget concern, and it is here for one reason: this method already
   * reads the `TenantLimits` row on every single turn, and a second query for
   * one boolean off the same row would be pure waste. The name of the method
   * is the only thing that suffers.
   */
  handoffEnabled: boolean;
}

/** The one thing the agent says past the overage ceiling. Fixed text, not a
 * model call — the whole point of the ceiling is that no model call happens. */
export const BUDGET_EXHAUSTED_REPLY =
  'En este momento no puedo responderte por chat. Escríbele directamente a la tienda y con gusto te ayudan.';

/** Warn at 80%, not 90%. The merchant now needs time to decide whether to move
 * up a plan BEFORE the overage starts, and 90% of a 500-credit allowance is
 * fifty credits of notice — an afternoon on a busy store. */
const WARNING_THRESHOLD = 0.8;

/** `YYYY-MM` in UTC. UTC rather than the store's local time so the bucket a
 * turn lands in never depends on which server answered it — two API instances
 * in different zones must agree on which month it is. */
export function currentYearMonth(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

@Injectable()
export class AgentBudgetService {
  /** Reads this tenant's plan limit and month-to-date usage. Called before any
   * model call. */
  async check(tenantId: string, now: Date = new Date()): Promise<BudgetStatus> {
    const month = currentYearMonth(now);
    const [limits, usage] = await Promise.all([
      // Via common/plan-limits.ts so this — the reference implementation of
      // the "no row means zero" posture — reads the plan row through the same
      // helper as every other limit rather than alongside it.
      loadPlanLimits(tenantId),
      platformDb.agentUsage.findUnique({ where: { tenantId_month: { tenantId, month } } }),
    ]);

    // A tenant with no `TenantLimits` row has not been provisioned onto a plan.
    // Treated as a zero budget rather than an unlimited one: an unprovisioned
    // store getting free unmetered AI is the failure that costs money and
    // hides itself, whereas a store that cannot use the agent notices
    // immediately and gets fixed.
    const limit = limits?.aiCreditsMonth ?? 0;
    const used = usage?.creditsUsed ?? 0;
    // A tenant with no plan row has a limit of 0, and therefore a ceiling of
    // 0: unprovisioned still means no agent, which is the posture the comment
    // above is about. Overage never rescues a store that was never on a plan.
    const ceiling = overageCeiling({ aiCreditsMonth: limit });

    return {
      allowed: used < ceiling,
      used,
      limit,
      overage: Math.max(0, used - limit),
      ceiling,
      warning: limit > 0 && used >= Math.floor(limit * WARNING_THRESHOLD),
      // Same posture as the budget itself: no plan row means not provisioned,
      // which is `false` rather than a permissive default.
      handoffEnabled: isPlanFeatureEnabledOn(limits, 'humanHandoff'),
    };
  }

  /** Records one answered turn plus whatever it cost in tokens. Called after
   * the model call completes. */
  async record(
    tenantId: string,
    tokens: TokenCounts,
    /**
     * Which action this was, which decides what it costs against the
     * allowance. Defaults to the shopper turn: it is the overwhelming majority
     * of traffic, and a caller that forgets to say should under-charge the
     * merchant rather than over-charge them.
     */
    action: CreditedAction = 'shopperMessage',
    now: Date = new Date(),
  ): Promise<void> {
    const month = currentYearMonth(now);
    const credits = creditsFor(action);
    // Priced HERE, at write time, rather than derived on read from the token
    // totals. These rows are monthly aggregates, so a later read would have to
    // price January's tokens at whatever the price happens to be when someone
    // opens the dashboard — which is not what January cost. `null` when prices
    // are not configured (see agent-pricing.ts): the column then stays 0, and
    // readers are told the pricing is unconfigured rather than being handed a
    // fabricated zero. That distinction is the whole reason this column exists
    // instead of `costCents`, which nothing ever wrote.
    const costMicroUsd = priceMicroUsd(tokens) ?? 0;
    // An upsert on the (tenantId, month) unique key rather than
    // find-then-create: two shoppers answered in the same instant would
    // otherwise race to create the month's row, and one of the counts would be
    // lost to the constraint violation. The increments are atomic in Postgres,
    // so the concurrent case adds correctly.
    await platformDb.agentUsage.upsert({
      where: { tenantId_month: { tenantId, month } },
      create: {
        tenantId,
        month,
        messagesCount: 1,
        creditsUsed: credits,
        inputTokens: tokens.inputTokens,
        outputTokens: tokens.outputTokens,
        cacheWriteTokens: tokens.cacheWriteTokens ?? 0,
        cacheReadTokens: tokens.cacheReadTokens ?? 0,
        costMicroUsd,
      },
      update: {
        messagesCount: { increment: 1 },
        // Weighted, unlike `messagesCount` beside it. The two diverge as soon
        // as a merchant question is answered, and that divergence is the point
        // — one is "turns taken", the other is "allowance consumed".
        creditsUsed: { increment: credits },
        inputTokens: { increment: tokens.inputTokens },
        outputTokens: { increment: tokens.outputTokens },
        cacheWriteTokens: { increment: tokens.cacheWriteTokens ?? 0 },
        cacheReadTokens: { increment: tokens.cacheReadTokens ?? 0 },
        // Atomic like its siblings: two shoppers answered in the same instant
        // must add both costs, not race and keep one.
        costMicroUsd: { increment: costMicroUsd },
      },
    });
  }
}
