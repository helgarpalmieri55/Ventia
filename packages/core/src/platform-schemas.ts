import { z } from 'zod';
import { PLANS, type PlanId, type PlanLimits } from './tenant.js';

/**
 * Contracts for the platform-operator API (`services/api/src/platform/**`,
 * docs/SPEC.md §6 M9). This is Ventia's OWN back office — the surface a
 * Ventia operator uses to look across every merchant — not anything a
 * merchant can reach. Keeping the shapes here rather than in the API service
 * is the same rule the rest of this package follows: request/response
 * contracts are shared vocabulary, so they live in `@ventia/core`.
 */

/** The three tiers of SPEC §5 point 5, in ascending order. Exported as a
 * tuple so it can seed both the Zod enum below and any UI that renders the
 * tiers in order. */
export const PLAN_IDS = ['basico', 'pro', 'premium'] as const satisfies readonly PlanId[];

export const planIdSchema = z.enum(PLAN_IDS);

export const tenantStatusSchema = z.enum(['draft', 'live', 'suspended']);

/**
 * THE plan → limits table.
 *
 * It resolves through `PLANS` in `./tenant.ts` rather than restating the six
 * numbers here, and that indirection is the point. `PLANS` was already the
 * table two live call sites provision from — `packages/db/src/seed.ts` and
 * `services/api/src/onboarding/onboarding.service.ts` (which writes
 * `PLANS.basico` into `TenantLimits` at signup). A second literal copy in
 * this file would be a second source of truth by definition: the platform
 * admin would grant `pro` one set of numbers while onboarding granted
 * `basico` a set that had drifted, and nothing would fail loudly when they
 * disagreed. "Single source of truth" is a property of there being exactly
 * one copy, not of which file it sits in.
 *
 * What this function adds over reading `PLANS[plan]` directly is the
 * guarantee callers actually need: a `TenantLimits`-shaped object for a plan
 * id, total over `PlanId`, so `PlatformService.assignPlan` cannot be handed
 * a plan it has no limits for.
 *
 * Current values (from `./tenant.ts`, restated here only as documentation —
 * edit them THERE):
 *
 * | plan    | productsMax | aiMessagesMonth | staffSeats | customDomain | humanHandoff | whatsappChannel |
 * |---------|-------------|-----------------|------------|--------------|--------------|-----------------|
 * | basico  |         100 |             500 |          1 | no           | no           | no              |
 * | pro     |       1 000 |           3 000 |          3 | yes          | no           | yes             |
 * | premium |      10 000 |          10 000 |         10 | yes          | yes          | yes             |
 */
export function planLimitsFor(plan: PlanId): PlanLimits {
  return PLANS[plan];
}

/** `GET /v1/platform/tenants` query string.
 *
 * `z.coerce` on the paging fields because these arrive as strings off the
 * query string; `perPage` is capped at 100 so an operator (or a bug in the
 * admin UI) cannot ask for one page containing every tenant on the platform,
 * which is a full-table scan plus a GMV aggregate over every order ever
 * placed. */
export const platformTenantListQuerySchema = z.object({
  /** Free-text search over tenant name and slug. Trimmed; an all-whitespace
   * `q` is treated as absent rather than as a search for `''` (which would
   * match every tenant and read as a filter that silently did nothing). */
  q: z.string().trim().min(1).max(120).optional(),
  status: tenantStatusSchema.optional(),
  plan: planIdSchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(25),
});

/** `PATCH /v1/platform/tenants/:id/plan` body. */
export const assignPlanSchema = z.object({
  plan: planIdSchema,
  /** Free-text operator note, persisted onto the audit row. Optional — but
   * the audit row is written either way. */
  note: z.string().trim().max(500).optional(),
});

/** `POST /v1/platform/tenants/:id/suspend` body.
 *
 * `reason` is REQUIRED, unlike the note on a plan change. Suspension takes a
 * merchant's storefront off the air; the audit trail has to answer "why" for
 * every one of them, and a required field is the only version of that which
 * survives a hurried operator. */
export const suspendTenantSchema = z.object({
  reason: z.string().trim().min(1).max(500),
});

/** `POST /v1/platform/tenants/:id/reactivate` body. */
export const reactivateTenantSchema = z.object({
  note: z.string().trim().max(500).optional(),
});

/** Path-param guard for every `/v1/platform/tenants/:id` route. Prisma throws
 * an opaque P2023 ("inconsistent column data") on a non-UUID `@db.Uuid`
 * lookup, which surfaces as a 500; validating first turns that into a 400. */
export const platformTenantIdSchema = z.string().uuid();

export type PlatformTenantListQuery = z.infer<typeof platformTenantListQuerySchema>;
export type AssignPlanInput = z.infer<typeof assignPlanSchema>;
export type SuspendTenantInput = z.infer<typeof suspendTenantSchema>;
export type ReactivateTenantInput = z.infer<typeof reactivateTenantSchema>;
