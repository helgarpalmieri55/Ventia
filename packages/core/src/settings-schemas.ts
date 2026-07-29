import { z } from 'zod';

/** `PATCH /v1/admin/settings/store` body. `storeInfo`, when present, is
 * merged (not replaced) into `tenants.settings.storeInfo` by the caller —
 * same partial-merge shape as onboarding-schemas.ts's `store_info` step,
 * duplicated here rather than reused because this endpoint additionally
 * accepts `name` (Tenant.name), which the wizard step does not. */
export const storeSettingsSchema = z.object({
  name: z.string().min(2).max(80).optional(),
  storeInfo: z
    .object({
      category: z.string().max(60).optional(),
      contactEmail: z.string().email().optional(),
      contactPhone: z.string().max(20).optional(),
      description: z.string().max(500).optional(),
    })
    .optional(),
});

/** Fixed catalog of 5 font pairings (spec §5.4) — storefront theming does not
 * allow arbitrary font selection, only one of these curated pairs. */
export const FONT_PAIRS = [
  'inter-lora',
  'poppins-source',
  'montserrat-merriweather',
  'raleway-open',
  'worksans-bitter',
] as const;
export type FontPair = (typeof FONT_PAIRS)[number];

export const RADIUS_OPTIONS = ['none', 'sm', 'md', 'lg', 'full'] as const;
export type Radius = (typeof RADIUS_OPTIONS)[number];

const hexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);

/** `PUT /v1/admin/settings/theme` body. A PUT, not a PATCH: the caller
 * replaces `tenants.theme` wholesale, so every field required by the
 * storefront renderer (colors, fontPair, radius) must be present in every
 * request — there is no partial-theme concept. */
export const themeSchema = z.object({
  logoUrl: z.string().url().optional(),
  faviconUrl: z.string().url().optional(),
  colors: z.object({
    primary: hexColorSchema,
    background: hexColorSchema,
    foreground: hexColorSchema,
  }),
  fontPair: z.enum(FONT_PAIRS),
  radius: z.enum(RADIUS_OPTIONS),
});

/** `providers.wompi` credentials, as accepted by `PATCH
 * /v1/admin/settings/payments` — see `packages/payments/src/index.ts`'s
 * `TenantProviderConfig` (P3a Task 2) for why `integritySecret` and
 * `eventsSecret` are two distinct optional fields rather than one. `sandbox`
 * is required (not optional): unlike the two secrets, which genuinely don't
 * apply to every future provider, every Wompi credential set needs SOME
 * explicit environment, and defaulting it silently (e.g. to `true`) would be
 * a real footgun (an owner who forgets to flip it to `false` before going
 * live, or vice versa) — better to make the caller say it every time. */
export const wompiCredentialsSchema = z.object({
  publicKey: z.string().min(1),
  privateKey: z.string().min(1),
  integritySecret: z.string().min(1).optional(),
  eventsSecret: z.string().min(1).optional(),
  sandbox: z.boolean(),
});

/** `PATCH /v1/admin/settings/payments` body — merged into
 * `tenants.settings.payments`, same shape as onboarding's `payments` step,
 * now widened (P3a Task 3) with an optional nested `providers.wompi` object.
 *
 * Both `codEnabled` and `providers` are optional at the top level so a
 * caller can PATCH just one without the other (`settings.controller.ts`'s
 * `updatePayments` merges each in-place independently) — a design doc
 * decision 8. This deliberately does NOT `.refine()` to reject a body with
 * neither key present: a `{}` PATCH is simply accepted as a no-op (nothing
 * to merge, nothing changes) rather than rejected as an error. That's a
 * conscious choice, not an oversight — an empty PATCH is harmless, and a
 * rejection would just be one more edge case for callers to special-case for
 * no real safety benefit. */
export const paymentsSettingsSchema = z.object({
  codEnabled: z.boolean().optional(),
  providers: z
    .object({
      wompi: wompiCredentialsSchema.optional(),
    })
    .optional(),
});

export type StoreSettingsInput = z.infer<typeof storeSettingsSchema>;
export type ThemeInput = z.infer<typeof themeSchema>;
export type WompiCredentialsInput = z.infer<typeof wompiCredentialsSchema>;
export type PaymentsSettingsInput = z.infer<typeof paymentsSettingsSchema>;
