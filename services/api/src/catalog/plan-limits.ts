import { tenantDb } from '@ventia/db';
import { assertPlanQuota, planQuotaExceeded } from '../common/plan-limits';
import type { AdminSessionContext } from '../admin/roles.decorator';

/**
 * The `productsMax` limit (docs/SPEC.md §5 point 5), expressed against the
 * shared enforcement in `src/common/plan-limits.ts`.
 *
 * This file is now only the catalog-specific half of the check — WHAT counts
 * as a product against the plan. The plan row read, the fail-open/fail-closed
 * decision and the 402 body all live in the shared module, so this limit
 * errors identically to the other five.
 *
 * Counts only non-archived products (archived rows don't count toward the
 * limit — archiving is how a tenant makes room without losing history). The
 * count deliberately stays on `tenantDb`: it must be RLS-scoped, unlike the
 * limits row itself.
 *
 * `additionalCount` defaults to 1 (the single-product-create path in
 * products.service.ts). The CSV bulk-import commit path passes the number of
 * CREATE rows in the file plus any un-archives (never plain updates —
 * replacing an existing product doesn't grow the tenant's product count), so a
 * 500-row file that's mostly updates isn't blocked by a small plan limit.
 */
export async function assertProductLimit(session: AdminSessionContext, additionalCount = 1): Promise<void> {
  await assertPlanQuota(productQuotaCheck(session.tenantId, additionalCount));
}

/**
 * The same check as {@link assertProductLimit}, answered instead of thrown.
 *
 * Used by the CSV dry-run's `limitExceeded` flag, which has to agree with what
 * commit will do — sharing the check is what guarantees that rather than
 * hoping two hand-written comparisons stay in step.
 */
export async function productLimitWouldBeExceeded(
  session: AdminSessionContext,
  additionalCount: number,
): Promise<boolean> {
  return planQuotaExceeded(productQuotaCheck(session.tenantId, additionalCount));
}

function productQuotaCheck(tenantId: string, additional: number) {
  return {
    tenantId,
    quota: 'productsMax' as const,
    additional,
    count: () => tenantDb(tenantId).product.count({ where: { status: { not: 'archived' } } }),
    // Pre-existing behaviour, preserved deliberately: a tenant with no
    // `TenantLimits` row is treated as unlimited here. See the note on
    // `assertPlanQuota` for why this one word is not simply flipped to
    // 'block' in this change.
    whenUnprovisioned: 'allow' as const,
  };
}
