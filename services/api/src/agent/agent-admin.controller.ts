import { Controller, Get, Inject, UseGuards } from '@nestjs/common';
import { tenantDb } from '@ventia/db';
import { AdminSessionGuard } from '../admin/admin-session.guard';
import { AdminSession, type AdminSessionContext } from '../admin/roles.decorator';
import { AgentBudgetService, currentYearMonth } from './agent-budget.service';

/**
 * What the merchant sees about their AI agent (docs/SPEC.md §7): how much of
 * this month's allowance is spent, and what the agent has actually sold.
 *
 * One endpoint rather than two because they answer one question — "is this
 * thing worth what it costs" — and the admin page renders them side by side.
 *
 * ## Not owner-only
 *
 * Unlike `SettingsController`, this is readable by staff as well. It exposes
 * no credentials and no customer data; it is the same "how are we doing"
 * information a staff member handling orders has every reason to see, and the
 * CONFIGURATION of the agent (which is owner-only) lives elsewhere.
 */
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
    const status = await this.budget.check(tenantId);

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
      messages: {
        used: status.used,
        limit: status.limit,
        /** SPEC §7's 90% merchant warning. Computed server-side so the admin
         * page and any future email notice agree on when it fires. */
        warning: status.warning,
        /** False once the hard cap is reached — at which point the widget is
         * still up but every shopper gets the fixed fallback. */
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
