import { Injectable } from '@nestjs/common';
import { platformDb } from '@ventia/db';
import { isPlanFeatureEnabledOn, loadPlanLimits } from '../common/plan-limits';

/**
 * The per-tenant monthly AI budget (docs/SPEC.md §7): "at 90% → merchant
 * warning; at 100% → agent replies with a fixed fallback and stops calling the
 * model. Hard cap, no exceptions."
 *
 * ## What is counted
 *
 * SHOPPER TURNS ANSWERED, not model API calls. One question that makes the
 * agent call three tools and the model four times is one message, because
 * "AI messages/month" is what a merchant was sold on their plan
 * (`TenantLimits.aiMessagesMonth`) and it is the only unit they can reason
 * about. Tokens are recorded alongside for cost visibility and are explicitly
 * NOT what the cap enforces — a merchant cannot predict token counts, so
 * capping on them would make the plan limit feel arbitrary.
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
  /** Whether the agent may call the model at all for this turn. */
  allowed: boolean;
  used: number;
  limit: number;
  /** True from 90% of the limit onward — the merchant-warning threshold. Still
   * `allowed`; this is a signal to surface, not a block. */
  warning: boolean;
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

/** The one thing the agent says when a store is out of budget. Fixed text, not
 * a model call — the whole point of the cap is that no model call happens. */
export const BUDGET_EXHAUSTED_REPLY =
  'En este momento no puedo responderte por chat. Escríbele directamente a la tienda y con gusto te ayudan.';

const WARNING_THRESHOLD = 0.9;

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
    const limit = limits?.aiMessagesMonth ?? 0;
    const used = usage?.messagesCount ?? 0;

    return {
      allowed: used < limit,
      used,
      limit,
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
    tokens: { inputTokens: number; outputTokens: number },
    now: Date = new Date(),
  ): Promise<void> {
    const month = currentYearMonth(now);
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
        inputTokens: tokens.inputTokens,
        outputTokens: tokens.outputTokens,
      },
      update: {
        messagesCount: { increment: 1 },
        inputTokens: { increment: tokens.inputTokens },
        outputTokens: { increment: tokens.outputTokens },
      },
    });
  }
}
