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

/** `providers.mercadopago` credentials, as accepted by `PATCH
 * /v1/admin/settings/payments` (P3b Task 4). Mirrors `wompiCredentialsSchema`'s
 * exact field-optionality choices: `sandbox` required for the same reason
 * (every credential set needs an explicit environment, never silently
 * defaulted); `eventsSecret` optional even though
 * `MercadoPagoProvider.verifyAndParseWebhook` (packages/payments/src/
 * mercadopago.ts) throws unconditionally without it — checked against that
 * adapter directly: `createCheckoutSession` (the operation that actually lets
 * a merchant accept a payment at all) never reads `eventsSecret`, only
 * `verifyAndParseWebhook` does. That's the exact same shape as Wompi's own
 * `eventsSecret` (also optional, also only load-bearing for webhook
 * verification, not checkout) — not a stricter case that would justify
 * diverging from Wompi's convention, so this keeps it optional-plus-a-
 * checkout/webhook-time guard rather than making it required here. */
export const mercadopagoCredentialsSchema = z.object({
  publicKey: z.string().min(1),
  privateKey: z.string().min(1),
  eventsSecret: z.string().min(1).optional(),
  sandbox: z.boolean(),
});

/** `providers.epayco` credentials, as accepted by `PATCH
 * /v1/admin/settings/payments` (P3b Task 4). `eventsSecret` (P_KEY) and
 * `epaycoCustomerId` (P_CUST_ID_CLIENTE) are both optional for the identical
 * reason `mercadopagoCredentialsSchema`'s `eventsSecret` is: checked directly
 * against `EpaycoProvider` (packages/payments/src/epayco.ts) —
 * `createCheckoutSession` only needs `publicKey`/`privateKey` (HTTP Basic
 * login), while `requireEventsSecret`/`requireEpaycoCustomerId` (both throw
 * unconditionally if missing) are only ever called from
 * `verifyAndParseWebhook`. So a merchant can save partial ePayco credentials
 * and start accepting checkouts before wiring up the webhook secrets, same
 * "can save partial credentials, fails at checkout/webhook time" posture
 * already accepted for Wompi (a P3a review finding) — not a case where either
 * adapter's core checkout-creation path is unconditionally blocked by a
 * missing field, which is the bar that would justify making these required
 * here instead. */
export const epaycoCredentialsSchema = z.object({
  publicKey: z.string().min(1),
  privateKey: z.string().min(1),
  eventsSecret: z.string().min(1).optional(), // P_KEY
  epaycoCustomerId: z.string().min(1).optional(), // P_CUST_ID_CLIENTE
  sandbox: z.boolean(),
});

/** `PATCH /v1/admin/settings/payments` body — merged into
 * `tenants.settings.payments`, same shape as onboarding's `payments` step,
 * widened (P3a Task 3) with an optional nested `providers.wompi` object, and
 * further widened (P3b Task 4) with optional `providers.mercadopago`/
 * `providers.epayco` siblings.
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
      mercadopago: mercadopagoCredentialsSchema.optional(),
      epayco: epaycoCredentialsSchema.optional(),
    })
    .optional(),
});

export type StoreSettingsInput = z.infer<typeof storeSettingsSchema>;
export type ThemeInput = z.infer<typeof themeSchema>;
export type WompiCredentialsInput = z.infer<typeof wompiCredentialsSchema>;
export type MercadopagoCredentialsInput = z.infer<typeof mercadopagoCredentialsSchema>;
export type EpaycoCredentialsInput = z.infer<typeof epaycoCredentialsSchema>;
export type PaymentsSettingsInput = z.infer<typeof paymentsSettingsSchema>;
