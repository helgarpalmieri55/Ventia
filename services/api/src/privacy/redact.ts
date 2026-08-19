import { ANON_ADDRESS_LINE, ANON_NAME, ANON_PHONE, ANON_REDACTED, isAnonymizedValue } from '@ventia/core';

/**
 * The JSON scrubber shared by every loosely-typed column this flow has to
 * clean: `OrderEvent.data`, `AuditLog.data`, `Message.toolCalls` and
 * `WebhookEvent.payload`.
 *
 * Two independent rules, applied together, because neither is sufficient
 * alone:
 *
 *  1. **By key** ({@link PII_KEYS}) — catches personal data in shapes this
 *     codebase has never seen, which is exactly what a gateway webhook
 *     payload is. `customer_email` is redacted whether or not we happen to
 *     know the shopper's address.
 *  2. **By value** — catches personal data under an innocent key, which is
 *     exactly what a merchant's free-text cancellation reason ("cliente Ana
 *     Gómez pidió cancelar") is. The values scrubbed are the ones read off
 *     the customer's own typed columns moments earlier, so this cannot
 *     redact a third party's data by accident.
 *
 * It is defense in depth, not a proof: arbitrary JSON written by a future
 * feature under a key nobody listed here, carrying data that is not any of
 * this customer's known values, would survive. That is why the typed columns
 * (`Customer.email`, `Order.shippingAddress`, …) are rewritten field by field
 * rather than run through this.
 */

type Json = unknown;

/** Normalizes a JSON key for matching: lowercased, with `_`, `-` and spaces
 * stripped, so `customer_email`, `customerEmail` and `Customer-Email` all
 * collapse to the same token. */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[\s_-]/g, '');
}

/**
 * Keys whose VALUE is personal data, in normalized form.
 *
 * Matched exactly rather than by substring, on purpose: a substring rule on
 * `name` would also redact `nameSnapshot` (a product name, which belongs to
 * the merchant's catalog, not to the shopper) and `providerName`. An exact
 * set is predictable, greppable, and testable; the value rule below is what
 * covers the keys nobody thought of.
 */
export const PII_KEYS: ReadonlySet<string> = new Set([
  // contact
  'email',
  'emailaddress',
  'customeremail',
  'buyeremail',
  'payeremail',
  'phone',
  'phonenumber',
  'customerphone',
  'contactphone',
  'telefono',
  'celular',
  'mobile',
  'recipient',
  'shopperref',
  // identity
  'name',
  'fullname',
  'firstname',
  'lastname',
  'customername',
  'contactname',
  'nombre',
  'nombrecompleto',
  'apellidos',
  'razonsocial',
  'documento',
  'numerodocumento',
  'legalid',
  'legalidnumber',
  'identification',
  'identificationnumber',
  'cedula',
  'nit',
  // street-level location. `departamento`/`municipio` are deliberately absent:
  // SPEC §9 keeps aggregate geography, it is the door number that is personal.
  'direccion',
  'address',
  'addressline1',
  'addressline2',
  'shippingaddress',
  'billingaddress',
  'barrio',
  'complemento',
  'notas',
  'notes',
]);

/** Escapes a string for literal use inside a RegExp. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Shortest secret eligible for SUBSTRING replacement.
 *
 * Exact (whole-string, case-insensitive) matches are always replaced whatever
 * their length. Substring replacement is gated because a two-letter surname
 * appearing inside `CONFIRMED` or a uuid would shred unrelated data — and the
 * damage from over-redacting an audit trail is not recoverable either.
 */
const MIN_SUBSTRING_SECRET = 5;

export interface Redactor {
  (value: Json): Json;
}

/**
 * Builds a redactor bound to one customer's known personal values.
 *
 * `secrets` should already have sentinels filtered out (see
 * `isAnonymizedValue`) — a redactor that treats its own output as a secret
 * rewrites the same rows on every run and destroys idempotency.
 */
export function buildRedactor(secrets: readonly string[]): Redactor {
  const exact = new Set(secrets.map((s) => s.trim().toLowerCase()).filter((s) => s.length > 0));
  const patterns = secrets
    .map((s) => s.trim())
    .filter((s) => s.length >= MIN_SUBSTRING_SECRET)
    // Longest first, so redacting "ana.gomez@correo.co" does not leave a
    // dangling "@correo.co" behind after "ana.gomez" was replaced separately.
    .sort((a, b) => b.length - a.length)
    .map((s) => new RegExp(escapeRegExp(s), 'gi'));

  function redactString(value: string): string {
    if (exact.has(value.trim().toLowerCase())) return ANON_REDACTED;
    let out = value;
    for (const pattern of patterns) out = out.replace(pattern, ANON_REDACTED);
    return out;
  }

  function walk(value: Json): Json {
    if (typeof value === 'string') return redactString(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') {
      const source = value as Record<string, Json>;
      const out: Record<string, Json> = {};
      // Object.keys order is preserved so an unchanged object serializes
      // identically to its input — which is how callers detect "nothing
      // changed" and skip the UPDATE (see PrivacyService).
      for (const key of Object.keys(source)) {
        out[key] = PII_KEYS.has(normalizeKey(key)) ? redactKeyedValue(source[key]) : walk(source[key]);
      }
      return out;
    }
    return value;
  }

  /**
   * A value sitting under a known-PII key. Objects and arrays are still walked
   * (a `shippingAddress` key holds a whole address object whose departamento
   * must survive... but see the caveat: here we are in FREE-FORM json, not the
   * typed `Order.shippingAddress` column, so nested structure under a PII key
   * is scrubbed field-by-field by the same rules rather than blanked, which
   * keeps `{"address":{"departamento":"Antioquia","direccion":"Cra 1"}}`
   * useful); scalars are blanked outright.
   */
  function redactKeyedValue(value: Json): Json {
    if (value === null || value === undefined) return value;
    if (Array.isArray(value) || typeof value === 'object') return walk(value);
    return ANON_REDACTED;
  }

  return walk;
}

/** Digits-only form of a phone, matching `normalizePhone` in
 * `packages/whatsapp` — the transform that produced every WhatsApp
 * `Conversation.shopperRef` in the database. */
export function phoneDigits(raw: string): string {
  return raw.split('@')[0]!.replace(/\D/g, '');
}

/** Keys of a shipping address that are aggregate geography, not personal data,
 * and therefore survive anonymization (SPEC §9: "keep amounts for accounting";
 * the same logic keeps departamento/municipio for shipping-zone reporting). */
const ADDRESS_KEPT_KEYS: ReadonlySet<string> = new Set(['departamentoCode', 'departamentoName', 'municipioName']);

/**
 * Rewrites `Order.shippingAddress` in place.
 *
 * Field-by-field rather than through {@link buildRedactor}: this column has a
 * known schema (`checkoutAddressSchema`), and a known schema deserves an
 * explicit, auditable decision per field rather than a heuristic. Unknown keys
 * are dropped rather than kept-and-redacted — an address JSON this service
 * does not recognise is exactly where an unreviewed PII field would hide.
 *
 * `barrio` and `complemento` are dropped despite looking geographic: a barrio
 * plus a municipio narrows a person down far more than a departamento does,
 * and `complemento` is literally an apartment number. `notas` is shopper prose
 * ("dejar con el portero, apto 502").
 */
export function anonymizeAddress(value: unknown): Record<string, unknown> {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    if (ADDRESS_KEPT_KEYS.has(key)) out[key] = source[key];
  }
  out.nombreCompleto = ANON_NAME;
  out.telefono = ANON_PHONE;
  out.direccion = ANON_ADDRESS_LINE;
  return out;
}

/** True when an address JSON is already in the shape {@link anonymizeAddress}
 * produces. Used only for reporting/asserting; the anonymizer itself detects
 * "no change" by comparing serialized before/after, which also covers this. */
export function isAnonymizedAddress(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const a = value as Record<string, unknown>;
  return (
    typeof a.nombreCompleto === 'string' &&
    isAnonymizedValue(a.nombreCompleto) &&
    typeof a.telefono === 'string' &&
    isAnonymizedValue(a.telefono) &&
    typeof a.direccion === 'string' &&
    isAnonymizedValue(a.direccion)
  );
}
