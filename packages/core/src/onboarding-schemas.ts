import { z } from 'zod';

/** Same alphabet slugify() produces (lowercase, digits, single internal
 * hyphens, no leading/trailing hyphen) — an explicitly-supplied slug must
 * match it too, since it ends up as a subdomain label (`${slug}.${rootDomain}`,
 * see onboarding.service.ts#provisionTenant) where uppercase, dots, or a
 * leading/trailing hyphen are either invalid or silently mismatch what DNS
 * actually resolves. */
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export const tenantProvisionSchema = z.object({
  storeName: z.string().min(2).max(80),
  slug: z.string().min(1).max(60).regex(SLUG_PATTERN, 'slug inválido').optional(),
});

/** `store_info` step payload — see onboardingStepSchema's doc comment for how
 * this gets applied to the loosely-typed `data` field. */
export const storeInfoDataSchema = z.object({
  category: z.string().max(60).optional(),
  contactEmail: z.string().email().optional(),
  contactPhone: z.string().max(20).optional(),
  description: z.string().max(500).optional(),
});

/** `payments` step payload. */
export const paymentsDataSchema = z.object({
  codEnabled: z.boolean(),
});

export const ONBOARDING_STEPS = ['store_info', 'branding', 'products', 'payments'] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

/**
 * `data` is deliberately typed as `z.record(z.unknown())` rather than a
 * discriminated union keyed on `step`: the wizard has four steps and only
 * two (`store_info`, `payments`) have a real, persisted payload shape today
 * — `branding` and `products` write their actual data through the theme and
 * product endpoints respectively, so `data` for those steps is accepted and
 * ignored here (it only ever marks the step done).
 *
 * The `superRefine` below re-validates `data` against the matching per-step
 * schema (storeInfoDataSchema / paymentsDataSchema) when one applies, and
 * re-homes any resulting issues under `data.<field>` — the same path a flat
 * `data: storeInfoDataSchema` field would have produced — so parseOr400's
 * VALIDATION_FAILED response shape is indistinguishable from a "real" nested
 * schema to callers.
 */
export const onboardingStepSchema = z
  .object({
    step: z.enum(ONBOARDING_STEPS),
    data: z.record(z.unknown()).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.data === undefined) return;
    const stepSchema =
      value.step === 'store_info' ? storeInfoDataSchema : value.step === 'payments' ? paymentsDataSchema : undefined;
    if (!stepSchema) return;
    const result = stepSchema.safeParse(value.data);
    if (!result.success) {
      for (const issue of result.error.issues) {
        ctx.addIssue({ ...issue, path: ['data', ...issue.path] });
      }
    }
  });

export type TenantProvisionInput = z.infer<typeof tenantProvisionSchema>;
export type OnboardingStepInput = z.infer<typeof onboardingStepSchema>;
export type StoreInfoData = z.infer<typeof storeInfoDataSchema>;
export type PaymentsData = z.infer<typeof paymentsDataSchema>;
