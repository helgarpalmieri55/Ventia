import { HttpException, Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import { platformDb, Prisma } from '@ventia/db';
import {
  planLimitsFor,
  type PlatformTenantListQuery,
  type PlanId,
  type TenantStatus,
} from '@ventia/core';
import { REDIS_CLIENT } from '../common/redis.module';
import { currentYearMonth } from '../agent/agent-budget.service';
import type { PlatformOperatorContext } from './platform-operator.decorator';
import { SYSTEM_OPERATOR, writePlatformAudit, type PlatformActor } from './platform-audit';
import { subscriptionWindow, type SubscriptionDueState } from './subscription-window';

/**
 * ## Why every query here uses `platformDb`, when every other service uses `tenantDb`
 *
 * `tenantDb(tenantId)` exists to make it impossible for a merchant-facing
 * request to read another merchant's rows: it sets the RLS GUC per
 * transaction and injects `where: { tenantId }` into every query. That is
 * exactly the guarantee this module must NOT have. "List every tenant on the
 * platform, ranked by GMV" has no tenant to scope to — it is a question about
 * the platform, asked by the platform's own operator, and a tenant-scoped
 * client cannot express it at all (there is no id to pass, and RLS would
 * filter the answer to nothing).
 *
 * So `platformDb` here is not a shortcut around isolation; it is the one
 * place in the codebase whose job is genuinely cross-tenant, and the
 * isolation boundary has been moved up a level to `PlatformAdminGuard` — an
 * env allowlist a merchant cannot write to (see that file). The rule this
 * codebase follows is "tenant-scoped requests use `tenantDb`, and the small,
 * named set of system contexts uses `platformDb`": the RLS-exempt audit
 * writer, the stock-reservation sweep, the reconciliation worker, and this.
 */
@Injectable()
export class PlatformService {
  // Explicit @Inject: esbuild does not emit `design:paramtypes`.
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  // ---- reads ----------------------------------------------------------

  async listTenants(query: PlatformTenantListQuery) {
    const { q, status, plan, page, perPage } = query;

    const where: Prisma.TenantWhereInput = {
      ...(status ? { status } : {}),
      ...(plan ? { plan } : {}),
      // Search covers name and slug — the two things an operator has in hand
      // when a merchant writes in. `mode: 'insensitive'` because nobody
      // remembers a store's capitalization.
      ...(q
        ? {
            OR: [
              { name: { contains: q, mode: Prisma.QueryMode.insensitive } },
              { slug: { contains: q, mode: Prisma.QueryMode.insensitive } },
            ],
          }
        : {}),
    };

    const [total, tenants] = await Promise.all([
      platformDb.tenant.count({ where }),
      platformDb.tenant.findMany({
        where,
        // Newest first: the tenants an operator is most likely to be looking
        // for are the ones that just signed up or just broke. `id` breaks
        // ties so paging is stable when a batch is created in one second.
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * perPage,
        take: perPage,
        include: { limits: true },
      }),
    ]);

    // The two aggregates are fetched for THIS PAGE's tenants only (`in: ids`),
    // never for the whole table. GMV in particular is a sum over every order
    // a tenant has ever placed; doing it platform-wide to render 25 rows
    // would make the list page slower with every sale anyone makes.
    const ids = tenants.map((t) => t.id);
    const [gmv, usage] = await Promise.all([this.gmvByTenant(ids), this.aiUsageByTenant(ids)]);

    return {
      page,
      perPage,
      total,
      /** Ceil, so a caller can render "page 1 of N" without recomputing. */
      totalPages: Math.max(1, Math.ceil(total / perPage)),
      month: currentYearMonth(),
      tenants: tenants.map((t) => ({
        id: t.id,
        slug: t.slug,
        name: t.name,
        status: t.status,
        plan: t.plan,
        createdAt: t.createdAt,
        gmv: gmv.get(t.id) ?? EMPTY_GMV,
        ai: this.aiView(usage.get(t.id), t.limits?.aiMessagesMonth ?? 0),
      })),
    };
  }

  async getTenant(tenantId: string) {
    const tenant = await platformDb.tenant.findUnique({
      where: { id: tenantId },
      include: {
        limits: true,
        domains: { orderBy: [{ isPrimary: 'desc' }, { domain: 'asc' }] },
        // v1 subscription tracking is manual (SPEC §6 M9). Exactly one row per
        // tenant — `Subscription.tenantId` is unique — so there is no "which
        // one is current" question to get wrong. This used to take the newest
        // of many ordered by `id DESC`, which, `id` being a random v4 UUID,
        // was no order at all.
        subscription: true,
      },
    });
    if (!tenant) throw new HttpException({ error: 'TENANT_NOT_FOUND' }, 404);

    const [gmv, usage, staffCount, productCount] = await Promise.all([
      this.gmvByTenant([tenantId]),
      this.aiUsageByTenant([tenantId]),
      platformDb.membership.count({ where: { tenantId } }),
      platformDb.product.count({ where: { tenantId } }),
    ]);

    const subscription = tenant.subscription;

    return {
      id: tenant.id,
      slug: tenant.slug,
      name: tenant.name,
      status: tenant.status,
      plan: tenant.plan,
      createdAt: tenant.createdAt,
      month: currentYearMonth(),
      domains: tenant.domains.map((d) => ({
        domain: d.domain,
        isPrimary: d.isPrimary,
        verifiedAt: d.verifiedAt,
      })),
      // Reported straight off the row rather than derived from `plan`, on
      // purpose: the whole reason an operator opens this page is to find out
      // when the two DISAGREE (a tenant provisioned before a plan's limits
      // changed, or one that never got a `TenantLimits` row at all). Showing
      // `planLimitsFor(tenant.plan)` here would hide exactly that.
      limits: tenant.limits
        ? {
            productsMax: tenant.limits.productsMax,
            aiMessagesMonth: tenant.limits.aiMessagesMonth,
            staffSeats: tenant.limits.staffSeats,
            customDomain: tenant.limits.customDomain,
            humanHandoff: tenant.limits.humanHandoff,
            whatsappChannel: tenant.limits.whatsappChannel,
          }
        : null,
      /** True when `limits` is missing or has drifted from what `plan` should
       * grant — one boolean the admin UI can badge on, so the operator does
       * not have to diff six numbers by eye. Re-assigning the same plan is
       * the fix. */
      limitsMatchPlan: this.limitsMatchPlan(tenant.plan, tenant.limits),
      subscription: subscription ? subscriptionView(subscription) : null,
      counts: { staff: staffCount, products: productCount },
      gmv: gmv.get(tenantId) ?? EMPTY_GMV,
      ai: this.aiView(usage.get(tenantId), tenant.limits?.aiMessagesMonth ?? 0),
    };
  }

  // ---- mutations ------------------------------------------------------

  async assignPlan(tenantId: string, plan: PlanId, note: string | undefined, operator: PlatformOperatorContext) {
    const tenant = await platformDb.tenant.findUnique({
      where: { id: tenantId },
      include: { limits: true },
    });
    if (!tenant) throw new HttpException({ error: 'TENANT_NOT_FOUND' }, 404);

    const limits = planLimitsFor(plan);

    // One transaction for both writes. A plan without its matching
    // `TenantLimits` row is not a half-finished change, it is a WRONG state
    // that enforcement reads: `AgentBudgetService` treats a missing row as a
    // zero AI budget, so a tenant upgraded to `premium` whose limits write
    // failed would show "premium" in the UI while its agent refused every
    // shopper. Both rows land or neither does.
    //
    // `upsert` rather than `update` because a tenant can legitimately have no
    // limits row yet — onboarding writes one, but a tenant created by seed or
    // by an older code path may predate that.
    await platformDb.$transaction([
      platformDb.tenant.update({ where: { id: tenantId }, data: { plan } }),
      platformDb.tenantLimits.upsert({
        where: { tenantId },
        create: { tenantId, ...limits },
        update: { ...limits },
      }),
    ]);

    await writePlatformAudit(operator, 'platform.tenant.plan_assigned', tenantId, {
      previousPlan: tenant.plan,
      plan,
      limits,
      ...(note ? { note } : {}),
    });

    return { id: tenantId, plan, limits, previousPlan: tenant.plan };
  }

  suspend(tenantId: string, reason: string, operator: PlatformOperatorContext) {
    return this.setStatus(tenantId, 'suspended', operator, { reason });
  }

  reactivate(tenantId: string, note: string | undefined, operator: PlatformOperatorContext) {
    return this.setStatus(tenantId, 'live', operator, note ? { note } : {});
  }

  /**
   * The auto-suspend sweep's entry point (SPEC §6 M9 — "auto-suspend N days
   * past due"). Called by `subscription-sweep.worker.ts`, never by a route.
   *
   * It goes through the SAME `setStatus` a human operator's suspend button
   * does, deliberately and not merely for tidiness: `setStatus` is what evicts
   * `DomainResolver`'s Redis entries for every host pointing at the tenant,
   * which is the only reason a suspension reaches the storefront in under the
   * 60 s SPEC §6 M9 requires instead of after the cache TTL. A second,
   * job-specific suspend path would have been a second place for that eviction
   * to be forgotten — and it would have been forgotten silently, because the
   * database row would look correctly suspended while the store kept selling.
   *
   * The audit row is written by `setStatus` too, with `actorUserId: null` and
   * `data.actorEmail: 'sistema@ventia'` (see `SYSTEM_OPERATOR`), plus the
   * numbers that justify it: which date was missed and how many days of grace
   * had elapsed. "Why did my store go down" stays answerable from one query
   * over `AuditLog`, whether a person or the job took it down.
   */
  suspendForNonPayment(tenantId: string, details: { paidUntil: Date; graceDays: number }) {
    return this.setStatus(tenantId, 'suspended', SYSTEM_OPERATOR, {
      reason:
        `Suspensión automática por falta de pago: la suscripción venció el ` +
        `${details.paidUntil.toISOString()} y superó los ${details.graceDays} días de gracia.`,
      automated: true,
      paidUntil: details.paidUntil.toISOString(),
      graceDays: details.graceDays,
    });
  }

  /**
   * Flips `Tenant.status` and — the part that actually matters — makes the
   * flip visible to the storefront immediately.
   *
   * ## The cache-lag problem
   *
   * `PublicTenantGuard` 503s a suspended tenant, but it reads
   * `req.tenant.status`, which `TenantMiddleware` got from `DomainResolver` —
   * and `DomainResolver` caches the whole resolved tenant in Redis under
   * `tenant:domain:<host>` for 60 seconds. So a plain `UPDATE tenants SET
   * status='suspended'` keeps serving the store for up to a minute per cached
   * host. For the two reasons a tenant actually gets suspended that is not a
   * cosmetic delay: non-payment means a minute of service we are not being
   * paid for, and abuse (a fraudulent storefront, a card-testing operation)
   * means a minute more of the thing we suspended them to stop — during which
   * an operator watching the storefront sees no effect and reasonably
   * concludes the button is broken and clicks it again.
   *
   * SPEC §6 M9's acceptance criterion puts a number on it: suspension takes
   * effect on the storefront in < 60 s. Waiting out the TTL meets that bound
   * only exactly, and only if the entry was written the instant before.
   *
   * ## The fix
   *
   * Delete this tenant's cache entries as part of the mutation. Every host
   * that resolves to it lives in `TenantDomain`, so the invalidation set is a
   * lookup away, and the next request re-reads the row and sees `suspended`.
   * Effect is immediate, not eventual.
   *
   * Reactivation invalidates for the same reason in the other direction: a
   * merchant who has just paid should not spend another minute 503ing.
   *
   * ## Two honest limitations
   *
   * 1. **The key format is duplicated.** `cacheKeysFor` below builds
   *    `tenant:domain:<host>` because `DomainResolver` builds that string
   *    inline and exports no key helper, and this change does not own that
   *    file. A drift there would silently restore the 60-second lag, so the
   *    binding is pinned by BEHAVIOR instead of by a shared constant:
   *    `platform-admin.test.ts` suspends a tenant and immediately requests its
   *    storefront through the real middleware, asserting 503. If the key ever
   *    stops matching, that test fails. Folding the key into an exported
   *    `DomainResolver` helper is the follow-up.
   * 2. **Redis is best-effort.** If the DELETE fails, the status change has
   *    still committed and is still correct — it just takes up to 60 s to
   *    bite, which is the old behavior. The mutation is NOT failed for this
   *    (reporting "suspension failed" for a suspension that is recorded in
   *    the database would be worse than reporting a slow one), but the
   *    response carries `storefrontEffective`, so the operator is told which
   *    of the two they got instead of having to guess.
   */
  private async setStatus(
    tenantId: string,
    status: TenantStatus,
    operator: PlatformActor,
    extra: Record<string, unknown>,
  ) {
    const tenant = await platformDb.tenant.findUnique({
      where: { id: tenantId },
      select: { status: true },
    });
    if (!tenant) throw new HttpException({ error: 'TENANT_NOT_FOUND' }, 404);

    // A `draft` tenant reactivated to `live` would LAUNCH a store that its
    // merchant never finished onboarding — a different and much bigger action
    // than "undo a suspension", and not one this endpoint should perform by
    // accident. Suspending a draft is allowed (an abusive signup should be
    // stoppable before launch).
    if (status === 'live' && tenant.status !== 'suspended') {
      throw new HttpException({ error: 'TENANT_NOT_SUSPENDED', status: tenant.status }, 409);
    }

    await platformDb.tenant.update({ where: { id: tenantId }, data: { status } });

    const invalidated = await this.invalidateDomainCache(tenantId);

    await writePlatformAudit(
      operator,
      status === 'suspended' ? 'platform.tenant.suspended' : 'platform.tenant.reactivated',
      tenantId,
      { previousStatus: tenant.status, status, cacheInvalidated: invalidated, ...extra },
    );

    return {
      id: tenantId,
      status,
      previousStatus: tenant.status,
      /** `'immediate'` when the resolver cache was cleared, `'within-60s'`
       * when Redis refused — see the doc comment's limitation 2. */
      storefrontEffective: invalidated ? ('immediate' as const) : ('within-60s' as const),
    };
  }

  /** Deletes `DomainResolver`'s cached resolution for every host that points
   * at this tenant. Returns false if Redis could not be reached (or true
   * vacuously when the tenant has no domains at all — there is then nothing
   * cached that could serve a stale status). */
  private async invalidateDomainCache(tenantId: string): Promise<boolean> {
    try {
      const domains = await platformDb.tenantDomain.findMany({
        where: { tenantId },
        select: { domain: true },
      });
      const keys = cacheKeysFor(domains.map((d) => d.domain));
      if (keys.length > 0) await this.redis.del(...keys);
      return true;
    } catch (err) {
      console.error('[platform] failed to invalidate tenant domain cache', {
        tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  // ---- aggregates -----------------------------------------------------

  /**
   * GMV per tenant: the sum of every non-`CANCELLED` order's total.
   *
   * `CANCELLED` is excluded for the same reason `AgentAdminController` excludes
   * it — a cancelled sale is not a sale, and counting it would flatter exactly
   * the tenants doing worst. Everything else counts, including `PENDING`:
   * this is gross merchandise value, not settled revenue, and a COD order
   * awaiting a phone confirmation is real merchandise moving.
   */
  private async gmvByTenant(tenantIds: string[]): Promise<Map<string, Gmv>> {
    if (tenantIds.length === 0) return new Map();
    const rows = await platformDb.order.groupBy({
      by: ['tenantId'],
      where: { tenantId: { in: tenantIds }, status: { not: 'CANCELLED' } },
      _sum: { totalCents: true },
      _count: { _all: true },
    });
    return new Map(
      rows.map((r) => [r.tenantId, { totalCents: r._sum.totalCents ?? 0, orders: r._count._all }]),
    );
  }

  /** Month-to-date AI usage per tenant, keyed on the same `YYYY-MM` string
   * `AgentBudgetService` meters into — so what an operator sees here is
   * literally the counter the hard cap is enforced against, not a
   * reconstruction of it. */
  private async aiUsageByTenant(tenantIds: string[]) {
    if (tenantIds.length === 0) return new Map<string, AgentUsageRow>();
    const rows = await platformDb.agentUsage.findMany({
      where: { tenantId: { in: tenantIds }, month: currentYearMonth() },
    });
    return new Map(rows.map((r) => [r.tenantId, r]));
  }

  private aiView(usage: AgentUsageRow | undefined, limit: number) {
    const messages = usage?.messagesCount ?? 0;
    return {
      messages,
      /** From `TenantLimits`, not from the plan — see `limitsMatchPlan`. 0
       * means "no plan provisioned", which `AgentBudgetService` enforces as a
       * zero budget. */
      messagesLimit: limit,
      inputTokens: usage?.inputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      costCents: usage?.costCents ?? 0,
      /** Null rather than 0 when there is no limit to be a percentage of —
       * "0% used" would read as healthy for a tenant that is actually hard-
       * capped at zero. */
      percentUsed: limit > 0 ? Math.round((messages / limit) * 100) : null,
    };
  }

  private limitsMatchPlan(plan: PlanId, limits: TenantLimitsRow | null): boolean {
    if (!limits) return false;
    const expected = planLimitsFor(plan);
    return (
      limits.productsMax === expected.productsMax &&
      limits.aiMessagesMonth === expected.aiMessagesMonth &&
      limits.staffSeats === expected.staffSeats &&
      limits.customDomain === expected.customDomain &&
      limits.humanHandoff === expected.humanHandoff &&
      limits.whatsappChannel === expected.whatsappChannel
    );
  }
}

/** The `Subscription` columns any caller of {@link subscriptionView} needs.
 * Structural, so both a full Prisma row and a narrowed `select` satisfy it. */
export interface SubscriptionRow {
  plan: PlanId;
  priceCents: number;
  paidUntil: Date | null;
  notes: string | null;
  updatedAt: Date;
}

/** What a subscription looks like over the wire, on the tenant detail and on
 * the record/update response alike — ONE mapper, so those two can never
 * disagree about what "overdue" means.
 *
 * The four stored columns, plus the derived window: `dueState`, `suspendsOn`
 * and `daysPastDue` are computed from `paidUntil` and the deployment's grace
 * setting at read time, never stored. Storing them would mean a row that says
 * "al día" the day after it stopped being true.
 *
 * The derivation is the SAME function the sweep acts on
 * (`subscription-window.ts`), which is the point: the date an operator is
 * shown here is the date the job will actually suspend on. */
export function subscriptionView(row: SubscriptionRow, now: Date = new Date()) {
  const window = subscriptionWindow(row.paidUntil, now);
  return {
    plan: row.plan,
    priceCents: row.priceCents,
    paidUntil: row.paidUntil,
    notes: row.notes,
    updatedAt: row.updatedAt,
    /** See `SubscriptionDueState`. */
    dueState: window.state as SubscriptionDueState,
    /** When the auto-suspend sweep will take this store offline if nothing is
     * paid — null when no `paidUntil` is on record, which is also the case in
     * which the sweep does nothing at all. */
    suspendsOn: window.suspendsOn,
    /** When the warning email goes out (N-3). */
    warnsOn: window.warnsOn,
    daysPastDue: window.daysPastDue,
    /** Echoed so a UI does not have to know the deployment's setting to
     * explain the dates above. */
    graceDays: window.graceDays,
  };
}

/** Exported because it appears in `PlatformController`'s inferred return
 * types; `declaration: true` (tsconfig.base.json) cannot name a non-exported
 * type across module boundaries. */
export interface Gmv {
  totalCents: number;
  orders: number;
}

const EMPTY_GMV: Gmv = { totalCents: 0, orders: 0 };

interface AgentUsageRow {
  messagesCount: number;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
}

interface TenantLimitsRow {
  productsMax: number;
  aiMessagesMonth: number;
  staffSeats: number;
  customDomain: boolean;
  humanHandoff: boolean;
  whatsappChannel: boolean;
}

/**
 * Rebuilds `DomainResolver`'s Redis keys (`tenant:domain:<host>`) for a set of
 * domains. Lowercased to match `normalizeHost`, which every read side of that
 * cache runs its host through before building the key — an entry written for
 * `Tienda.example.com` would never be found under a differently-cased delete.
 *
 * Exported so a test can assert the format directly alongside the end-to-end
 * behavioral check. See `PlatformService#setStatus`'s limitation 1 on why
 * this string lives here at all.
 */
export function cacheKeysFor(domains: string[]): string[] {
  return domains.map((d) => `tenant:domain:${d.trim().toLowerCase()}`);
}
