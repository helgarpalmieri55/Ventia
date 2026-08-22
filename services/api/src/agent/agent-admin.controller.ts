import { Controller, Get, Inject, UseGuards } from '@nestjs/common';
import { platformDb, tenantDb } from '@ventia/db';
import { CREDIT_COST, OVERAGE_CEILING_MULTIPLIER } from '@ventia/core';
import { AdminSessionGuard } from '../admin/admin-session.guard';
import { AdminSession, type AdminSessionContext } from '../admin/roles.decorator';
import { decideCommandBudget } from '../agent-command/command-budget';
import { AgentBudgetService, currentYearMonth } from './agent-budget.service';

/**
 * What the merchant sees about their AI agent (docs/SPEC.md §7): how much of
 * this month's allowance is spent, and what the agent has actually sold.
 *
 * One endpoint rather than two because they answer one question — "is this
 * thing worth what it costs" — and the admin page renders them side by side.
 *
 * ## Why this grew a `credits` block
 *
 * The allowance is no longer counted in messages and reaching it no longer
 * silences the agent: credits past the plan are billed as overage, and the
 * real stop is at {@link OVERAGE_CEILING_MULTIPLIER} times the allowance (see
 * `AgentBudgetService`). A merchant can therefore now spend money they were
 * never shown, which is the exact failure the old `messages` block could not
 * describe — it had no word for overage, no ceiling, and called credits
 * "messages".
 *
 * So `credits` is the shape `/consumo` renders, and it reports the four
 * numbers that decide what the merchant should do: what is spent, what is
 * left, what is already over, and where the agent actually stops.
 *
 * ## Not owner-only
 *
 * Unlike `SettingsController`, this is readable by staff as well. It exposes
 * no credentials and no customer data; it is the same "how are we doing"
 * information a staff member handling orders has every reason to see, and the
 * CONFIGURATION of the agent (which is owner-only) lives elsewhere.
 */

/**
 * How many of this month's turns were shoppers and how many were the merchant.
 *
 * `AgentUsage` stores two counters and not three: `messagesCount` (turns
 * taken) and `creditsUsed` (allowance consumed, weighted). With a shopper turn
 * at 1 credit and a merchant question at 2, the split falls straight out —
 * every merchant question adds exactly one credit MORE than it adds turns:
 *
 *     credits - turns = merchantQueries
 *
 * Derived rather than stored because a third column could drift out of
 * agreement with the two the budget actually enforces, and then the screen
 * telling the merchant where their money went would be the one that is wrong.
 *
 * Both clamps guard rows that arithmetic alone would turn into nonsense:
 *
 *  - **Below zero.** Rows written before credits existed have `creditsUsed`
 *    at its column default of 0 with `messagesCount` well above it, which
 *    would report a negative number of merchant questions. Zero is also the
 *    honest reading of such a row: nothing about it says the merchant asked
 *    anything.
 *  - **Above the turn count.** `record()` cannot produce more merchant
 *    questions than turns, but a hand-written or seeded row can, and "8
 *    consultas de 5 turnos" is a figure the merchant would rightly not
 *    believe. Clamping keeps the two halves summing to `messagesCount`, which
 *    is the property the breakdown is read for.
 */
export function splitTurns(
  messagesCount: number,
  creditsUsed: number,
): { shopperTurns: number; merchantQueries: number } {
  const merchantQueries = Math.min(Math.max(0, creditsUsed - messagesCount), Math.max(0, messagesCount));
  return { shopperTurns: Math.max(0, messagesCount) - merchantQueries, merchantQueries };
}

@Controller('v1/admin/agent')
@UseGuards(AdminSessionGuard)
export class AgentAdminController {
  // Explicit @Inject, matching every other controller here — esbuild does not
  // emit `design:paramtypes`.
  constructor(@Inject(AgentBudgetService) private readonly budget: AgentBudgetService) {}

  @Get('usage')
  async usage(@AdminSession() session: AdminSessionContext) {
    const { tenantId } = session;
    const month = currentYearMonth();
    // The month's raw row is read alongside the budget status because the two
    // answer different questions: `check()` reports the allowance (credits),
    // the row carries `messagesCount` — and the breakdown of shopper turns vs
    // merchant questions needs both. `platformDb` for the same reason
    // `AgentBudgetService` uses it: the counter is not tenant-writable.
    const [status, usage] = await Promise.all([
      this.budget.check(tenantId),
      platformDb.agentUsage.findUnique({ where: { tenantId_month: { tenantId, month } } }),
    ]);

    const { shopperTurns, merchantQueries } = splitTurns(usage?.messagesCount ?? 0, status.used);

    // The merchant assistant's OWN ceiling, decided by the same function the
    // assistant endpoint refuses with (`agent-command/command-budget.ts`)
    // rather than re-derived here. Two copies of the 20% reserve would be two
    // answers to "why did my assistant stop", and this screen exists to
    // explain the one the endpoint actually applied.
    const command = decideCommandBudget(status);

    const db = tenantDb(tenantId);
    // Month-to-date, so the sales figure lines up with the usage figure beside
    // it — "we spent this much of the allowance and got this much back" only
    // reads correctly if both cover the same window.
    const since = new Date(`${month}-01T00:00:00.000Z`);
    // CANCELLED orders are excluded: a cancelled sale is not a sale, and a KPI
    // that counts them would flatter the agent exactly when it is doing badly.
    const [assisted, all] = await Promise.all([
      db.order.aggregate({
        where: { tenantId, source: 'agent', createdAt: { gte: since }, status: { not: 'CANCELLED' } },
        _count: true,
        _sum: { totalCents: true },
      }),
      db.order.aggregate({
        where: { tenantId, createdAt: { gte: since }, status: { not: 'CANCELLED' } },
        _count: true,
        _sum: { totalCents: true },
      }),
    ]);

    return {
      month,
      credits: {
        /** Allowance consumed this month. The number the plan is sold in. */
        used: status.used,
        /** This plan's monthly allowance. 0 means no plan is provisioned,
         * which `AgentBudgetService` enforces as no agent at all. */
        limit: status.limit,
        /** Credits still inside the allowance. Clamped at zero: a negative
         * "te quedan" means nothing to a merchant, and once it would go
         * negative `overage` is the number that carries the information. */
        remaining: Math.max(0, status.limit - status.used),
        /** Credits already spent BEYOND the allowance, billed as overage.
         * Zero for the great majority of stores. */
        overage: status.overage,
        /** Where the agent really does stop — three times the allowance. */
        ceiling: status.ceiling,
        /** How far past the allowance the ceiling sits, as a multiple, so the
         * UI can say "3 veces tu cupo" without hardcoding the rule. */
        ceilingMultiplier: OVERAGE_CEILING_MULTIPLIER,
        /** True from 80% of the allowance onward. A nudge, not a block. */
        warning: status.warning,
        /** False ONLY past the ceiling. Reaching the allowance does not clear
         * it — that is the whole point of the overage change. */
        allowed: status.allowed,
        /** Can legitimately exceed 100: overage is billed, not refused. Null
         * rather than 0 when there is no allowance to be a percentage of, so
         * an unprovisioned store does not read as "0% used, plenty left" —
         * the same posture as `PlatformService.aiView`. */
        percentUsed: status.limit > 0 ? Math.round((status.used / status.limit) * 100) : null,
        /** What each action costs, so the breakdown below can be explained on
         * screen from the same source the budget charges against. */
        cost: CREDIT_COST,
        /** Where the credits went. Sums to the month's turns, not to
         * `used` — see {@link splitTurns}. */
        breakdown: {
          /** Shopper turns in the storefront or WhatsApp, at 1 credit each. */
          shopperTurns,
          /** The merchant's own questions to their assistant, at 2 each. */
          merchantQueries,
        },
        /**
         * The merchant assistant's self-imposed ceiling.
         *
         * It stops at `limit - reserve` while the shopper agent keeps the full
         * allowance, so the merchant's own questions can never silence their
         * storefront. Reported here because that is otherwise invisible: the
         * merchant sees their assistant refuse while credits plainly remain,
         * and concludes the store is broken.
         */
        merchantAssistant: {
          /** Credits held back for shoppers, untouchable by the assistant. */
          reserve: command.budget.shopperReserve,
          /** Credits the assistant may still spend on questions. */
          remaining: command.budget.remainingForCommands,
          /** Why the assistant is currently refusing, or null if it is not.
           * `shopper_reserve` and `exhausted` are different situations with
           * different remedies, which is why the reason travels rather than a
           * bare boolean. */
          pausedReason: command.refusal,
        },
      },
      /**
       * @deprecated The pre-credits shape, kept so `agente-tab.tsx` and any
       * older client keep rendering rather than blanking out mid-deploy. It is
       * a strict subset of `credits` and carries the two fields it never had a
       * name for (overage, ceiling) nowhere at all — read `credits` instead.
       * `used`/`limit` are CREDITS despite the key, which is precisely why
       * this block is deprecated rather than being fixed in place.
       */
      messages: {
        used: status.used,
        limit: status.limit,
        warning: status.warning,
        allowed: status.allowed,
      },
      // "Ventas asistidas por IA": orders whose cart the agent built
      // (`create_cart_link` sets `Cart.source = 'agent'`, and checkout
      // inherits it onto the order).
      assistedSales: {
        orders: assisted._count,
        revenueCents: assisted._sum.totalCents ?? 0,
        /** Alongside the total, because "8 orders" means nothing without
         * knowing whether the store had 10 orders or 10,000 this month. */
        totalOrders: all._count,
        totalRevenueCents: all._sum.totalCents ?? 0,
      },
    };
  }
}
