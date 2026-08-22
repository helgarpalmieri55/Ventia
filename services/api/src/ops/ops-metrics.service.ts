import { Inject, Injectable } from '@nestjs/common';
import { platformDb } from '@ventia/db';
import { currentYearMonth } from '../agent/agent-budget.service';
import { agentPricing, microUsdToCents } from '../agent/agent-pricing';
import { QueueHealthService, type QueueHealthReport } from '../observability/queue-health.service';

/**
 * One snapshot of what the platform is costing and whether it is healthy,
 * per store and in total.
 *
 * ## One builder, two transports
 *
 * The OPS application polls `GET /v1/ops/metrics`, and `ops-push.worker.ts`
 * POSTs the same object on a schedule. Both call {@link snapshot} — there is
 * deliberately no second assembly path, because two payloads that are supposed
 * to be identical and are built separately do not stay identical, and the
 * divergence shows up as a monitoring system disagreeing with itself during an
 * incident.
 *
 * ## What "health" means here, per store
 *
 * Not uptime — a store has no process of its own. It means: is this merchant
 * in a state where a shopper can actually buy something, and is anything about
 * to stop working? Each signal below is something an operator can act on:
 * a store live with no verified domain is unreachable, one at 100% of its AI
 * budget has a silent agent, one with orders stuck PENDING for hours has a
 * payment problem the merchant has probably not noticed.
 *
 * ## Cost is honest about not knowing
 *
 * Every cost field is `null` when model prices are not configured, never 0.
 * See agent-pricing.ts — the whole reason `costMicroUsd` exists is that its
 * predecessor reported an unwritten column as zero and looked correct doing it.
 */

/** An order still PENDING after this long is a signal, not a normal in-flight
 * checkout. Chosen well above the 15-minute stock-reservation TTL so ordinary
 * abandoned checkouts (already handled by `stock-reservation.worker.ts`) do
 * not show up as incidents. */
const STUCK_ORDER_MS = 60 * 60_000;

/** Fraction of the AI budget at which a store is called `warning`. Matches
 * `AgentBudgetService`'s own threshold so the OPS app and the merchant-facing
 * warning fire together rather than a few messages apart. */
const AI_WARNING_RATIO = 0.9;

export type StoreHealth = 'ok' | 'warning' | 'critical';

export interface StoreMetrics {
  tenantId: string;
  slug: string;
  name: string;
  status: string;
  plan: string | null;
  ai: {
    messages: number;
    messagesLimit: number;
    percentUsed: number | null;
    inputTokens: number;
    outputTokens: number;
    /** Prompt-cache traffic. `cacheReadTokens` climbing while `inputTokens`
     * stays flat is caching working; both flat means the prompt is below the
     * provider's minimum cacheable length and the marker is being ignored. */
    cacheWriteTokens: number;
    cacheReadTokens: number;
    /** `null` when prices are unconfigured — see the class doc. */
    costMicroUsd: number | null;
    costCents: number | null;
  };
  storefront: {
    hasPrimaryDomain: boolean;
    primaryDomainVerified: boolean;
    customDomains: number;
  };
  orders24h: { created: number; paid: number; failed: number; stuckPending: number };
  /** Everything wrong with this store right now, as short stable codes the OPS
   * app can alert on without parsing prose. Empty means healthy. */
  issues: string[];
  health: StoreHealth;
}

export interface OpsSnapshot {
  generatedAt: string;
  month: string;
  platform: {
    /** Seconds this API process has been up. Per-process and therefore per
     * replica — the OPS app should treat a reset as a restart, which is
     * exactly the signal it wants. */
    uptimeSeconds: number;
    tenants: { total: number; live: number; draft: number; suspended: number };
    ai: {
      messages: number;
      inputTokens: number;
      outputTokens: number;
      cacheWriteTokens: number;
      cacheReadTokens: number;
      costMicroUsd: number | null;
      costCents: number | null;
    };
    /** Whether model prices are configured at all. When false every cost field
     * above and in every store is `null`, and the OPS app should render "no
     * configurado" rather than a zero. */
    costConfigured: boolean;
  };
  dependencies: {
    database: { ok: boolean; latencyMs: number | null; error?: string };
    redis: { ok: boolean; error?: string };
  };
  queues: QueueHealthReport['queues'];
  stores: StoreMetrics[];
}

@Injectable()
export class OpsMetricsService {
  // Explicit @Inject: esbuild (vitest's transform) emits no `design:paramtypes`.
  constructor(@Inject(QueueHealthService) private readonly queueHealth: QueueHealthService) {}

  async snapshot(now: Date = new Date()): Promise<OpsSnapshot> {
    const month = currentYearMonth(now);
    const pricingConfigured = agentPricing() !== null;
    const since = new Date(now.getTime() - 24 * 60 * 60_000);
    const stuckBefore = new Date(now.getTime() - STUCK_ORDER_MS);

    // Every read runs on `platformDb`: this is cross-tenant by definition, and
    // going through `tenantDb` would mean N round trips and N role switches to
    // assemble one snapshot.
    const [tenants, usageRows, orderRows, dbHealth, queueReport] = await Promise.all([
      platformDb.tenant.findMany({
        select: {
          id: true,
          slug: true,
          name: true,
          status: true,
          plan: true,
          limits: { select: { aiMessagesMonth: true } },
          domains: { select: { isPrimary: true, verifiedAt: true, domain: true } },
        },
        orderBy: { slug: 'asc' },
      }),
      platformDb.agentUsage.findMany({ where: { month } }),
      platformDb.order.groupBy({
        by: ['tenantId', 'paymentStatus'],
        where: { createdAt: { gte: since } },
        _count: { _all: true },
      }),
      this.databaseHealth(),
      this.queueHealth.snapshot(0).catch((error): QueueHealthReport => ({
        generatedAt: now.toISOString(),
        redis: { ok: false, error: message(error) },
        sentry: { enabled: false },
        queues: [],
      })),
    ]);

    const stuckByTenant = await this.stuckPendingByTenant(stuckBefore);
    const usageByTenant = new Map(usageRows.map((row) => [row.tenantId, row]));
    const ordersByTenant = groupOrders(orderRows);

    const stores = tenants.map((tenant) =>
      this.storeMetrics(tenant, usageByTenant.get(tenant.id), ordersByTenant.get(tenant.id), stuckByTenant.get(tenant.id) ?? 0, pricingConfigured),
    );

    const totalMicroUsd = usageRows.reduce((sum, row) => sum + Number(row.costMicroUsd), 0);

    return {
      generatedAt: now.toISOString(),
      month,
      platform: {
        uptimeSeconds: Math.round(process.uptime()),
        tenants: {
          total: tenants.length,
          live: tenants.filter((t) => t.status === 'live').length,
          draft: tenants.filter((t) => t.status === 'draft').length,
          suspended: tenants.filter((t) => t.status === 'suspended').length,
        },
        ai: {
          messages: usageRows.reduce((sum, row) => sum + row.messagesCount, 0),
          inputTokens: usageRows.reduce((sum, row) => sum + row.inputTokens, 0),
          outputTokens: usageRows.reduce((sum, row) => sum + row.outputTokens, 0),
          cacheWriteTokens: usageRows.reduce((sum, row) => sum + row.cacheWriteTokens, 0),
          cacheReadTokens: usageRows.reduce((sum, row) => sum + row.cacheReadTokens, 0),
          // Summed in micro-USD and rounded ONCE at the end. Rounding each
          // tenant to cents first and adding those would lose most of the
          // total on a platform of small stores.
          costMicroUsd: pricingConfigured ? totalMicroUsd : null,
          costCents: pricingConfigured ? microUsdToCents(totalMicroUsd) : null,
        },
        costConfigured: pricingConfigured,
      },
      dependencies: {
        database: dbHealth,
        redis: queueReport.redis,
      },
      queues: queueReport.queues,
      stores,
    };
  }

  /** A trivial round trip, timed. `SELECT 1` rather than a table read on
   * purpose: this answers "can we reach Postgres", and a query that touches a
   * table would also fail on a migration problem, which is a different alarm. */
  private async databaseHealth(): Promise<OpsSnapshot['dependencies']['database']> {
    const started = process.hrtime.bigint();
    try {
      await platformDb.$queryRaw`SELECT 1`;
      return { ok: true, latencyMs: Number(process.hrtime.bigint() - started) / 1_000_000 };
    } catch (error) {
      return { ok: false, latencyMs: null, error: message(error) };
    }
  }

  /** Orders left PENDING past {@link STUCK_ORDER_MS} — the signal that a
   * merchant's payment provider is misconfigured or a gateway is down. */
  private async stuckPendingByTenant(before: Date): Promise<Map<string, number>> {
    const rows = await platformDb.order.groupBy({
      by: ['tenantId'],
      where: { paymentStatus: 'PENDING', status: 'PENDING', createdAt: { lt: before } },
      _count: { _all: true },
    });
    return new Map(rows.map((row) => [row.tenantId, row._count._all]));
  }

  private storeMetrics(
    tenant: TenantRow,
    usage: UsageRow | undefined,
    orders: OrderCounts | undefined,
    stuckPending: number,
    pricingConfigured: boolean,
  ): StoreMetrics {
    const limit = tenant.limits?.aiMessagesMonth ?? 0;
    const messages = usage?.messagesCount ?? 0;
    const microUsd = Number(usage?.costMicroUsd ?? 0n);
    const primary = tenant.domains.find((d) => d.isPrimary) ?? null;
    const issues: string[] = [];

    // Percent is null, not 0, when there is no limit to be a percentage of —
    // "0% used" reads as healthy for a tenant that is actually capped at zero.
    const percentUsed = limit > 0 ? Math.round((messages / limit) * 100) : null;

    if (limit === 0) issues.push('ai_budget_unprovisioned');
    else if (messages >= limit) issues.push('ai_budget_exhausted');
    else if (messages >= limit * AI_WARNING_RATIO) issues.push('ai_budget_warning');

    // Only a LIVE store is expected to be reachable. A draft one without a
    // verified domain is mid-onboarding, which is not an incident.
    if (tenant.status === 'live') {
      if (!primary) issues.push('no_primary_domain');
      else if (primary.verifiedAt === null) issues.push('primary_domain_unverified');
    }
    if (stuckPending > 0) issues.push('orders_stuck_pending');

    return {
      tenantId: tenant.id,
      slug: tenant.slug,
      name: tenant.name,
      status: tenant.status,
      plan: tenant.plan ?? null,
      ai: {
        messages,
        messagesLimit: limit,
        percentUsed,
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        cacheWriteTokens: usage?.cacheWriteTokens ?? 0,
        cacheReadTokens: usage?.cacheReadTokens ?? 0,
        costMicroUsd: pricingConfigured ? microUsd : null,
        costCents: pricingConfigured ? microUsdToCents(microUsd) : null,
      },
      storefront: {
        hasPrimaryDomain: primary !== null,
        primaryDomainVerified: primary?.verifiedAt != null,
        customDomains: tenant.domains.length,
      },
      orders24h: {
        created: orders?.created ?? 0,
        paid: orders?.paid ?? 0,
        failed: orders?.failed ?? 0,
        stuckPending,
      },
      issues,
      health: healthFrom(issues),
    };
  }
}

/**
 * Worst-issue-wins. `critical` is reserved for the two states where a shopper
 * cannot complete a purchase — an unreachable live store, or money that has
 * been taken but not settled. A silent agent is bad and is not that.
 */
function healthFrom(issues: string[]): StoreHealth {
  if (issues.some((i) => i === 'no_primary_domain' || i === 'primary_domain_unverified' || i === 'orders_stuck_pending')) {
    return 'critical';
  }
  return issues.length > 0 ? 'warning' : 'ok';
}

interface OrderCounts {
  created: number;
  paid: number;
  failed: number;
}

function groupOrders(
  rows: Array<{ tenantId: string; paymentStatus: string; _count: { _all: number } }>,
): Map<string, OrderCounts> {
  const byTenant = new Map<string, OrderCounts>();
  for (const row of rows) {
    const entry = byTenant.get(row.tenantId) ?? { created: 0, paid: 0, failed: 0 };
    entry.created += row._count._all;
    if (row.paymentStatus === 'PAID') entry.paid += row._count._all;
    if (row.paymentStatus === 'FAILED') entry.failed += row._count._all;
    byTenant.set(row.tenantId, entry);
  }
  return byTenant;
}

/** Error text without leaking a stack into a payload that crosses the network. */
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface TenantRow {
  id: string;
  slug: string;
  name: string;
  status: string;
  plan: string | null;
  limits: { aiMessagesMonth: number } | null;
  domains: Array<{ isPrimary: boolean; verifiedAt: Date | null; domain: string }>;
}

interface UsageRow {
  messagesCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  costMicroUsd: bigint;
}
