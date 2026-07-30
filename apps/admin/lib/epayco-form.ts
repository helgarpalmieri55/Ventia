import type { EpaycoCredentialsInput } from '@ventia/core';

/** The ePayco credentials form's raw field state — mirrors
 * `WompiFormFields`'s exact shape/reasoning (see `wompi-form.ts`'s doc
 * comment), with `integritySecret` dropped (ePayco has no checkout-signing
 * secret analogue to Wompi's) and one field ADDED: `epaycoCustomerId`
 * (ePayco's `P_CUST_ID_CLIENTE`), which pairs with `eventsSecret` (ePayco's
 * `P_KEY`) to form the confirmation-signature secret pair — see design doc
 * decision 7 / `epaycoCredentialsSchema`'s doc comment in
 * `packages/core/src/settings-schemas.ts`. Both `P_CUST_ID_CLIENTE`/`P_KEY`
 * naming is real ePayco dashboard terminology, verified against
 * docs.epayco.com during this phase's Task 3 research (see
 * `packages/payments/src/epayco.ts`'s own `requireEventsSecret`/
 * `requireEpaycoCustomerId` error messages, which cite the same names) — not
 * invented here.
 *
 * Every field is a plain string/boolean-or-null so `useState` never deals
 * with an absent value; there is no `*ToFormState` hydration counterpart
 * because `GET /v1/admin/settings` never returns a plaintext `privateKey`/
 * `eventsSecret`/`epaycoCustomerId` (see `settings.controller.ts`'s
 * `maskedProviderView`), so every credential field starts blank on every page
 * load. `sandbox` starts `null` (not `false`) for the identical reason
 * Wompi's/Mercado Pago's do: `epaycoCredentialsSchema.sandbox` is a required
 * boolean with no default, so this form must never silently coerce an unmade
 * choice into one. */
export interface EpaycoFormFields {
  publicKey: string;
  privateKey: string;
  eventsSecret: string;
  epaycoCustomerId: string;
  sandbox: boolean | null;
}

export const BLANK_EPAYCO_FORM: EpaycoFormFields = {
  publicKey: '',
  privateKey: '',
  eventsSecret: '',
  epaycoCustomerId: '',
  sandbox: null,
};

/** Builds the `PATCH /v1/admin/settings/payments` `providers.epayco` payload
 * from the form's raw field state — or `null` if `sandbox` hasn't been
 * chosen yet, same one client-side check `buildWompiCredentialsPayload`/
 * `buildMercadoPagoCredentialsPayload` do and for the same reason.
 *
 * `eventsSecret` (`P_KEY`) and `epaycoCustomerId` (`P_CUST_ID_CLIENTE`) are
 * BOTH OMITTED entirely (not sent as `''`) when left blank:
 * `epaycoCredentialsSchema` marks both `.min(1).optional()`, so an empty
 * string is not a valid "no value" signal — it would fail `.min(1)` and
 * bounce back as VALIDATION_FAILED instead of being treated as "leave this
 * secret unset." Whitespace-only input is treated the same as blank (trimmed
 * before the emptiness check). `publicKey`/`privateKey` are required by the
 * schema either way, so they're always included as typed (not trimmed — an
 * intentional leading/trailing space in a real secret is not this form's
 * business to strip). */
export function buildEpaycoCredentialsPayload(fields: EpaycoFormFields): EpaycoCredentialsInput | null {
  if (fields.sandbox === null) return null;

  const eventsSecret = fields.eventsSecret.trim();
  const epaycoCustomerId = fields.epaycoCustomerId.trim();

  return {
    publicKey: fields.publicKey,
    privateKey: fields.privateKey,
    sandbox: fields.sandbox,
    ...(eventsSecret ? { eventsSecret } : {}),
    ...(epaycoCustomerId ? { epaycoCustomerId } : {}),
  };
}
