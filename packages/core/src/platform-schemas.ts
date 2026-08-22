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
export const PLAN_IDS = ['emprende', 'crece', 'escala'] as const satisfies readonly PlanId[];

export const planIdSchema = z.enum(PLAN_IDS);

export const tenantStatusSchema = z.enum(['draft', 'live', 'suspended']);

/**
 * THE plan → limits table.
 *
 * It resolves through `PLANS` in `./tenant.ts` rather than restating the six
 * numbers here, and that indirection is the point. `PLANS` was already the
 * table two live call sites provision from — `packages/db/src/seed.ts` and
 * `services/api/src/onboarding/onboarding.service.ts` (which writes
 * `PLANS.emprende` into `TenantLimits` at signup). A second literal copy in
 * this file would be a second source of truth by definition: the platform
 * admin would grant `crece` one set of numbers while onboarding granted
 * `emprende` a set that had drifted, and nothing would fail loudly when they
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
 * | plan     | productsMax | aiCreditsMonth | staffSeats | dominio | handoff | WhatsApp | Instagram |
 * |----------|-------------|----------------|------------|---------|---------|----------|-----------|
 * | emprende |         300 |            500 |          1 | no      | no      | sí       | no        |
 * | crece    |       3 000 |          1 200 |          5 | sí      | sí      | sí       | sí        |
 * | escala   |  ilimitados |          2 800 |         15 | sí      | sí      | sí       | sí        |
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

// ---------------------------------------------------------------------------
// Subscription tracking, v1 manual (SPEC §6 M9: "plan, price, paid-until date,
// notes")
// ---------------------------------------------------------------------------

/**
 * `paidUntil` — the instant a merchant's paid period ends.
 *
 * Accepts two shapes and NOTHING else, deliberately:
 *
 *   - `YYYY-MM-DD` — what an operator actually types, and what a date input
 *     submits. Interpreted as the END of that day **in Colombia** (UTC-05:00,
 *     which has no DST), not as midnight UTC. The difference is five hours of
 *     someone's grace period, and this is the direction that errs toward the
 *     merchant: "pagó hasta el 31 de agosto" means the 31st is theirs.
 *   - A full ISO-8601 timestamp, for a caller that already has an instant.
 *
 * `z.coerce.date()` is deliberately NOT used. It accepts a bare number (`0`
 * becomes 1970, i.e. instantly overdue, i.e. a store taken offline by a
 * malformed field) and a pile of implementation-defined string formats that
 * differ between JS engines. The value on this field decides whether a
 * storefront stays up; it is worth being strict about.
 *
 * The year bound catches the gross typo (`2026` mistyped as `2016`) that would
 * otherwise read as "years overdue" and suspend a paying store. It cannot
 * catch a plausible-but-wrong date — nothing can — which is why the API echoes
 * `overdue` / `suspendsOn` back in the response, so the operator sees the
 * consequence at the moment they record it rather than the next morning.
 */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
/** Colombia is UTC-05:00 year round (no daylight saving). */
export const COLOMBIA_UTC_OFFSET = '-05:00';

/** True for a `YYYY-MM-DD` string that names a day that actually exists.
 * `new Date('2026-02-31T…')` does not fail — it rolls forward to 3 March, so
 * a typo'd date would be silently accepted as a different (later) one. */
function isRealCalendarDay(v: string): boolean {
  const parsed = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === v;
}

export const paidUntilSchema = z
  .string()
  .trim()
  .refine((v) => (DATE_ONLY.test(v) ? isRealCalendarDay(v) : ISO_INSTANT.test(v)), {
    message: 'Usa una fecha YYYY-MM-DD o una marca de tiempo ISO-8601',
  })
  .transform((v) => new Date(DATE_ONLY.test(v) ? `${v}T23:59:59.999${COLOMBIA_UTC_OFFSET}` : v))
  .refine((d) => !Number.isNaN(d.getTime()), { message: 'Fecha inválida' })
  .refine((d) => d.getUTCFullYear() >= 2020 && d.getUTCFullYear() <= 2100, {
    message: 'La fecha está fuera de rango (2020-2100)',
  });

/**
 * `PUT /v1/platform/tenants/:id/subscription` body — the whole subscription,
 * every time.
 *
 * PUT with a complete body rather than PATCH with a partial one, because there
 * is exactly one subscription per tenant and the operator UI loads it before
 * editing it. A partial update whose `paidUntil` was omitted-by-accident
 * versus omitted-on-purpose is indistinguishable on the wire, and on this
 * field that ambiguity is the difference between a store staying up and going
 * down.
 *
 * `paidUntil` is nullable rather than optional-and-absent: `null` is a
 * MEANINGFUL, recordable state ("we have their plan and price on file, nobody
 * has paid yet"), and the auto-suspend sweep treats it as not-delinquent. See
 * `subscription-sweep.worker.ts` for why that is the only safe reading.
 */
export const recordSubscriptionSchema = z.object({
  plan: planIdSchema,
  /** COP cents, like every other money column in this schema. 0 is allowed —
   * a pilot merchant or a comped account is a real thing an operator records,
   * and forcing them to invent a price would be worse data. */
  priceCents: z.number().int().min(0).max(1_000_000_000),
  paidUntil: paidUntilSchema.nullable(),
  /** Free text: "pago por transferencia", "factura 0142", "piloto sin cobro". */
  notes: z.string().trim().max(1000).nullable().default(null),
});

export type RecordSubscriptionInput = z.infer<typeof recordSubscriptionSchema>;
