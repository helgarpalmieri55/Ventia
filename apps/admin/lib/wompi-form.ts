import type { WompiCredentialsInput } from '@ventia/core';

/** The Wompi credentials form's raw field state — every field is always a
 * plain string/boolean-or-null so the form's `useState` calls never deal
 * with an absent value. Unlike `ShippingFormState`/`ThemeFormState`, there is
 * no `*ToFormState` counterpart that hydrates this FROM a saved value:
 * `GET /v1/admin/settings` never returns a plaintext `privateKey`/
 * `integritySecret`/`eventsSecret` (see `settings.controller.ts`'s
 * `maskedWompiView` — there is nothing to decrypt-and-prefill even if this
 * app wanted to), so every credential field starts blank on every page load,
 * full stop. `sandbox` starts as `null` (not `false`) so the tab can tell
 * "the merchant hasn't chosen an environment yet this session" apart from
 * "the merchant chose sandbox" — `wompiCredentialsSchema.sandbox` is a
 * required boolean with no default (see its doc comment: an owner who
 * forgets to flip it shouldn't get a silent default), so this form must
 * never coerce `null` into a boolean on its own. */
export interface WompiFormFields {
  publicKey: string;
  privateKey: string;
  integritySecret: string;
  eventsSecret: string;
  sandbox: boolean | null;
}

export const BLANK_WOMPI_FORM: WompiFormFields = {
  publicKey: '',
  privateKey: '',
  integritySecret: '',
  eventsSecret: '',
  sandbox: null,
};

/** Builds the `PATCH /v1/admin/settings/payments` `providers.wompi` payload
 * from the form's raw field state — or `null` if `sandbox` hasn't been
 * chosen yet (the one field this module itself must validate client-side,
 * since there is no sensible default to fall back to and letting a `{}`-ish
 * value through would just bounce back as a confusing VALIDATION_FAILED).
 *
 * `integritySecret`/`eventsSecret` are OMITTED entirely (not sent as `''`)
 * when left blank: `wompiCredentialsSchema` marks both `.min(1).optional()`,
 * so an empty string is not a valid "no value" signal — it would fail
 * `.min(1)` and bounce back as VALIDATION_FAILED instead of being treated as
 * "leave this secret unset." Whitespace-only input is treated the same as
 * blank (trimmed before the emptiness check), since a secret that's pure
 * whitespace could never be a real Wompi credential. `publicKey`/
 * `privateKey` are required by the schema either way, so they're always
 * included as typed (not trimmed — an intentional leading/trailing space in
 * a real secret, however unlikely, is not this form's business to strip). */
export function buildWompiCredentialsPayload(fields: WompiFormFields): WompiCredentialsInput | null {
  if (fields.sandbox === null) return null;

  const integritySecret = fields.integritySecret.trim();
  const eventsSecret = fields.eventsSecret.trim();

  return {
    publicKey: fields.publicKey,
    privateKey: fields.privateKey,
    sandbox: fields.sandbox,
    ...(integritySecret ? { integritySecret } : {}),
    ...(eventsSecret ? { eventsSecret } : {}),
  };
}
