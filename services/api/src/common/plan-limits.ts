import { HttpException } from '@nestjs/common';
import { platformDb } from '@ventia/db';

/**
 * The single place plan limits (docs/SPEC.md §5 point 5) are read and
 * enforced.
 *
 * Before this module every limit was checked ad hoc at its own call site:
 * three of them read the row through `tenantDb`, three through `platformDb`,
 * two treated a missing `TenantLimits` row as UNLIMITED while the other four
 * treated it as ZERO, and the 402 body came out in two different shapes
 * (`details: { limit }` for the numeric ones, `details: { feature }` for the
 * boolean ones). The admin UI has exactly one upgrade prompt to render, so it
 * needs exactly one error shape to render it from.
 *
 * ## The error shape
 *
 * `402 { error: 'PLAN_LIMIT_EXCEEDED', details: { feature, limit? } }` —
 * generalised from what `whatsapp-admin.controller.ts` already emitted, which
 * was the only call site that said WHICH feature ran out. `feature` is always
 * present (it is the thing the merchant has to upgrade to get); `limit` is
 * present only for the numeric quotas, because "you may have 100 products" is
 * a number worth showing and "your plan does not include WhatsApp" is not.
 * `apps/admin/app/(app)/equipo/page.tsx` reads `details.limit` for the seat
 * message, so that field keeps its meaning exactly.
 *
 * ## Why `platformDb`
 *
 * `TenantLimits` is RLS-scoped and therefore readable through `tenantDb` too,
 * but a plan limit is a fact ABOUT a tenant rather than a fact the tenant
 * owns, and half the call sites (the agent budget, the WhatsApp inbound path)
 * run with no tenant-scoped request context at all. Reading it one way
 * everywhere, with the `tenantId` always passed explicitly, is what makes this
 * module usable from all of them. Tenant-scoped COUNTING stays at the call
 * site on `tenantDb` — see {@link assertPlanQuota}'s `count` callback.
 */

/** The error code `apps/admin/lib/errors.ts` maps to the es-CO upgrade prompt. */
export const PLAN_LIMIT_ERROR = 'PLAN_LIMIT_EXCEEDED';

/** Plan entitlements that are on or off. */
export type PlanBooleanFeature = 'customDomain' | 'humanHandoff' | 'whatsappChannel';

/** Plan entitlements that are a countable ceiling. */
export type PlanQuota = 'productsMax' | 'aiCreditsMonth' | 'staffSeats';

/** Every limit named in SPEC.md §5 point 5. */
export type PlanFeature = PlanBooleanFeature | PlanQuota;

/** The `TenantLimits` row, as this module needs it. Declared structurally
 * rather than importing Prisma's generated type so callers can hand in a row
 * they already loaded (see {@link isPlanFeatureEnabledOn}). */
export interface PlanLimits {
  productsMax: number;
  aiCreditsMonth: number;
  staffSeats: number;
  customDomain: boolean;
  humanHandoff: boolean;
  whatsappChannel: boolean;
}

/**
 * The one typed error every plan limit raises. `402 Payment Required` — the
 * status the whole stack already agreed on: `apps/admin/lib/api.ts` turns it
 * into an `ApiError` whose `code` the UI maps to a single upgrade prompt.
 */
export class PlanLimitExceededException extends HttpException {
  constructor(
    readonly feature: PlanFeature,
    limit?: number,
  ) {
    super(
      {
        error: PLAN_LIMIT_ERROR,
        details: limit === undefined ? { feature } : { feature, limit },
      },
      402,
    );
  }
}

/**
 * Loads a tenant's plan row, or `null` when the tenant has never been
 * provisioned onto a plan.
 *
 * `null` is deliberately not collapsed into a default row here: what "no row"
 * MEANS differs per limit and that decision belongs to the caller, spelled out
 * in one word (see {@link WhenUnprovisioned}) rather than hidden in a `??`.
 */
export async function loadPlanLimits(tenantId: string): Promise<PlanLimits | null> {
  return platformDb.tenantLimits.findUnique({ where: { tenantId } });
}

/**
 * Whether a boolean entitlement is on, given an already-loaded row.
 *
 * **A missing row is `false`, never `true`.** An unprovisioned store that gets
 * a paid feature for free is the failure that costs money and hides itself,
 * whereas a store that cannot use a feature it pays for notices within the
 * hour and gets fixed. This is the posture `agent-budget.service.ts`
 * established for `aiCreditsMonth`/`humanHandoff`, and it is not negotiable
 * per call site — that is why there is no `whenUnprovisioned` parameter here.
 */
export function isPlanFeatureEnabledOn(limits: PlanLimits | null, feature: PlanBooleanFeature): boolean {
  return limits?.[feature] ?? false;
}

/** {@link isPlanFeatureEnabledOn} with the row loaded for you. Use where the
 * answer is a branch (rendering an upgrade panel instead of a form, dropping
 * an inbound message) rather than an error. */
export async function isPlanFeatureEnabled(tenantId: string, feature: PlanBooleanFeature): Promise<boolean> {
  return isPlanFeatureEnabledOn(await loadPlanLimits(tenantId), feature);
}

/**
 * Throws {@link PlanLimitExceededException} unless the tenant's plan includes
 * `feature`. Use on the write paths a merchant reaches from the admin UI, so
 * the 402 lands somewhere the upgrade prompt can be rendered.
 */
export async function assertPlanFeature(tenantId: string, feature: PlanBooleanFeature): Promise<void> {
  if (!(await isPlanFeatureEnabled(tenantId, feature))) {
    throw new PlanLimitExceededException(feature);
  }
}

/**
 * What a missing `TenantLimits` row means for a countable quota.
 *
 * `'block'` is the correct posture and the one the boolean features get
 * unconditionally. `'allow'` exists ONLY to carry the pre-existing behaviour
 * of the two quotas that shipped fail-open (`productsMax`, `staffSeats`),
 * which cannot be flipped from inside this module — see the note on
 * {@link assertPlanQuota}. Making it a required argument is the point: every
 * quota call site now states its posture in one readable word instead of
 * expressing it accidentally through the shape of an `if`.
 */
export type WhenUnprovisioned = 'block' | 'allow';

export interface PlanQuotaCheck {
  tenantId: string;
  /** Which ceiling to check. Also what lands in `details.feature`. */
  quota: PlanQuota;
  /**
   * Counts what the tenant is already using. A callback, not a number, so it
   * runs only when there is a limit to compare it against — and so the count
   * itself can stay on the tenant-scoped client (`tenantDb`) while the limit
   * is read from `platformDb`.
   */
  count: () => Promise<number>;
  /** How much this operation would add. Defaults to 1. */
  additional?: number;
  whenUnprovisioned: WhenUnprovisioned;
}

/**
 * True when the operation would put the tenant over its plan quota. The
 * non-throwing half of {@link assertPlanQuota}, for the paths that need to
 * REPORT the overage rather than refuse it — the CSV dry-run's
 * `limitExceeded` flag exists so the merchant sees the problem before
 * uploading, and it must agree with the commit-time check exactly or the
 * preview lies.
 */
export async function planQuotaExceeded(check: PlanQuotaCheck): Promise<boolean> {
  const limits = await loadPlanLimits(check.tenantId);
  if (!limits) return check.whenUnprovisioned === 'block';

  const additional = check.additional ?? 1;
  return (await check.count()) + additional > limits[check.quota];
}

/**
 * Throws {@link PlanLimitExceededException} when the operation would put the
 * tenant over its plan quota.
 *
 * ### On `whenUnprovisioned: 'allow'`
 *
 * `productsMax` and `staffSeats` have always treated a missing `TenantLimits`
 * row as unlimited, and both behaviours are pinned by tests owned elsewhere
 * (`test/staff.test.ts`'s "no tenantLimits row means unlimited seats"; every
 * product-creating fixture in the suite builds its tenant through
 * `test/admin-helpers.ts#signUpWithTenant`, which writes no limits row).
 * Flipping them to `'block'` is the right end state and is a one-word change
 * per call site — but it needs a `TenantLimits` backfill for tenants created
 * outside `onboarding.service.ts` and a fixture-helper change first, neither
 * of which belongs in a change whose job is to make enforcement uniform
 * without altering what any tenant is allowed to do today.
 */
export async function assertPlanQuota(check: PlanQuotaCheck): Promise<void> {
  const limits = await loadPlanLimits(check.tenantId);
  if (!limits) {
    if (check.whenUnprovisioned === 'block') throw new PlanLimitExceededException(check.quota, 0);
    return;
  }

  const additional = check.additional ?? 1;
  const limit = limits[check.quota];
  if ((await check.count()) + additional > limit) {
    throw new PlanLimitExceededException(check.quota, limit);
  }
}
