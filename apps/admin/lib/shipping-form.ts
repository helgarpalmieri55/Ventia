import { shippingMethodSchema, type ShippingMethodInput } from '@ventia/core';

/** The Envíos tab's form-state shape — a flattened, always-fully-populated
 * pair derived from `@ventia/core`'s `ShippingSettingsInput` (whose
 * `codRestrictedDepartamentos` is optional), so the tab's `useState` never
 * has to deal with an absent array. */
export interface ShippingFormState {
  methods: ShippingMethodInput[];
  codRestrictedDepartamentos: string[];
}

/** The empty-shipping-config default — used both for a brand-new tenant
 * (whose `settings.shipping` is still `{}`, per
 * `services/api/src/settings/settings.controller.ts`'s `toResponse` doc
 * comment: "the admin UI ... handles defaulting this to `{ methods: [] }`
 * client-side") and as the fallback for a malformed saved shape. */
export const DEFAULT_SHIPPING_FORM: ShippingFormState = {
  methods: [],
  codRestrictedDepartamentos: [],
};

/** Maps `GET /v1/admin/settings`'s `shipping` (a `Record<string, unknown>` —
 * `{}` for a tenant that has never called `PATCH /settings/shipping`,
 * otherwise whatever that PATCH last stored) to the Envíos tab's form state.
 *
 * Same "revisit must not clobber saved data" rationale as
 * `lib/theme-form.ts`'s `themeToFormState`: `PATCH /settings/shipping` is a
 * wholesale replace (not a merge — see the controller's doc comment: "a
 * methods array has no meaningful partial-update semantics"), so if this
 * function ever silently dropped a merchant's saved methods on load, the
 * next save would permanently erase them. Falls back to
 * {@link DEFAULT_SHIPPING_FORM} per-field whenever `shipping` is absent,
 * empty, or a field has the wrong shape — never throws.
 *
 * Each element of the `methods` array is additionally validated against
 * `shippingMethodSchema` and dropped if it doesn't parse: the only write
 * path (`PATCH /v1/admin/settings/shipping`) already enforces this shape
 * server-side, so a non-conforming element can only reach here via direct
 * DB tampering, a future looser write path, or JSON corruption — but
 * `shipping-tab.tsx`'s `methodToDraft` switches on `method.type` with no
 * fallback branch, so a malformed element (wrong/missing `type`, or not an
 * object at all) would otherwise throw and crash the whole `/configuracion`
 * page (all 4 tabs are always-mounted siblings with no error boundary
 * anywhere in this app) rather than just degrading this one tab. Filtering
 * here — the single choke point every caller goes through — closes that gap
 * at the source instead of requiring every future reader of `methods` to
 * defend against it individually. */
export function shippingToFormState(shipping: Record<string, unknown> | undefined): ShippingFormState {
  if (!shipping || Object.keys(shipping).length === 0) return DEFAULT_SHIPPING_FORM;

  const methods = Array.isArray(shipping.methods)
    ? shipping.methods.filter((m): m is ShippingMethodInput => shippingMethodSchema.safeParse(m).success)
    : DEFAULT_SHIPPING_FORM.methods;

  const codRestrictedDepartamentos = Array.isArray(shipping.codRestrictedDepartamentos)
    ? (shipping.codRestrictedDepartamentos as string[])
    : DEFAULT_SHIPPING_FORM.codRestrictedDepartamentos;

  return { methods, codRestrictedDepartamentos };
}

/** Builds a fresh flat-rate method for the "add method" control.
 *
 * Deviation from the brief's illustrative snippet (`label: ''`): `label` is
 * `z.string().min(1).max(60)` in `shippingMethodSchema`, so an empty label
 * would make `shippingMethodSchema.safeParse(newFlatMethod())` fail — but
 * the brief's own test list requires exactly that call to succeed
 * (`.success === true`). A short, editable placeholder label resolves the
 * conflict in favor of the explicit, checkable test requirement rather than
 * the illustrative comment; the merchant can still rename or clear it (the
 * empty-string case is then caught by the normal save-time validation error,
 * same as every other required text field on this page). */
export function newFlatMethod(): ShippingMethodInput {
  return { id: crypto.randomUUID(), type: 'flat', label: 'Envío estándar', priceCents: 0, enabled: true };
}

/** Builds a fresh zone (per-departamento rate table) method — starts with
 * an empty `ratesByDepartamento` so no departamento is pre-populated with a
 * price the merchant didn't choose (the tab's UI treats an absent
 * departamento as "not set", not "$0"). Same non-empty-placeholder-label
 * reasoning as {@link newFlatMethod}. */
export function newZoneMethod(): ShippingMethodInput {
  return { id: crypto.randomUUID(), type: 'zone', label: 'Por departamento', ratesByDepartamento: {}, enabled: true };
}

/** Builds a fresh free-shipping-over-a-threshold method. Same
 * non-empty-placeholder-label reasoning as {@link newFlatMethod}. */
export function newFreeOverMethod(): ShippingMethodInput {
  return {
    id: crypto.randomUUID(),
    type: 'free_over',
    label: 'Envío gratis',
    thresholdCents: 0,
    fallbackPriceCents: 0,
    enabled: true,
  };
}

/** Builds a fresh in-store-pickup method (no `instructions` — optional).
 * Same non-empty-placeholder-label reasoning as {@link newFlatMethod}. */
export function newPickupMethod(): ShippingMethodInput {
  return { id: crypto.randomUUID(), type: 'pickup', label: 'Recoger en tienda', enabled: true };
}
