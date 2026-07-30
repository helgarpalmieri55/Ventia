import type { MercadopagoCredentialsInput } from '@ventia/core';

/** The Mercado Pago credentials form's raw field state — mirrors
 * `WompiFormFields`'s exact shape/reasoning (see `wompi-form.ts`'s doc
 * comment), minus `integritySecret` (Mercado Pago's checkout flow has no
 * equivalent: `mercadopagoCredentialsSchema` has no `integritySecret` field
 * at all — Wompi is the one adapter that needs a checkout-signing secret, not
 * a shape every provider shares). Every field is a plain string/boolean-or-
 * null so `useState` never deals with an absent value; there is no
 * `*ToFormState` hydration counterpart because `GET /v1/admin/settings` never
 * returns a plaintext `privateKey`/`eventsSecret` (see
 * `settings.controller.ts`'s `maskedProviderView`), so every credential field
 * starts blank on every page load. `sandbox` starts `null` (not `false`) for
 * the identical reason Wompi's does: `mercadopagoCredentialsSchema.sandbox`
 * is a required boolean with no default, so this form must never silently
 * coerce an unmade choice into one. */
export interface MercadoPagoFormFields {
  publicKey: string;
  privateKey: string;
  eventsSecret: string;
  sandbox: boolean | null;
}

export const BLANK_MERCADOPAGO_FORM: MercadoPagoFormFields = {
  publicKey: '',
  privateKey: '',
  eventsSecret: '',
  sandbox: null,
};

/** Builds the `PATCH /v1/admin/settings/payments` `providers.mercadopago`
 * payload from the form's raw field state — or `null` if `sandbox` hasn't
 * been chosen yet, same one client-side check `buildWompiCredentialsPayload`
 * does and for the same reason (no sensible default, and letting an
 * unmade choice through would just bounce back as a confusing
 * VALIDATION_FAILED).
 *
 * `eventsSecret` is OMITTED entirely (not sent as `''`) when left blank:
 * `mercadopagoCredentialsSchema` marks it `.min(1).optional()`, so an empty
 * string is not a valid "no value" signal — it would fail `.min(1)` and
 * bounce back as VALIDATION_FAILED instead of being treated as "leave this
 * secret unset." Whitespace-only input is treated the same as blank (trimmed
 * before the emptiness check). `publicKey`/`privateKey` are required by the
 * schema either way, so they're always included as typed (not trimmed — an
 * intentional leading/trailing space in a real secret is not this form's
 * business to strip). */
export function buildMercadoPagoCredentialsPayload(
  fields: MercadoPagoFormFields,
): MercadopagoCredentialsInput | null {
  if (fields.sandbox === null) return null;

  const eventsSecret = fields.eventsSecret.trim();

  return {
    publicKey: fields.publicKey,
    privateKey: fields.privateKey,
    sandbox: fields.sandbox,
    ...(eventsSecret ? { eventsSecret } : {}),
  };
}
