import { z } from 'zod';

/**
 * Schemas for the owner-only WhatsApp number connection flow (P5c —
 * docs/superpowers/specs/2026-08-18-p5-whatsapp-design.md §1 and §2).
 *
 * These feed two things: the `WhatsAppNumber` row (`externalId`, `displayPhone`,
 * `status`, `verifyToken`, `credentialsEnc`) and — once decrypted again at send
 * time — `WhatsAppConfig` in `packages/whatsapp/src/index.ts`. Every field here
 * ends up either in a URL path, in an HTTP header, or in the `@unique` routing
 * column, which is why the bounds below are tighter than "some string".
 */

/* -------------------------------------------------------------------------- */
/* Colombian mobile numbers                                                    */
/* -------------------------------------------------------------------------- */

/** Colombia's country calling code. Not configurable: this platform is
 * Colombia-only (see `colombia-locations.ts`), and a number from anywhere else
 * cannot be a Colombian store's WhatsApp line. */
export const COLOMBIA_COUNTRY_CODE = '57';

/** Every Colombian mobile is exactly 10 digits and starts with `3` — the `3XX`
 * prefixes are the whole of the national mobile range (Claro/Movistar/Tigo/WOM
 * and their MVNOs). Landlines are 7 digits behind a 1-digit area code (or 10
 * digits starting with `60` since the 2022 renumbering), and short codes are
 * 3-6 digits; neither can receive WhatsApp, so neither may pass. */
const COLOMBIAN_MOBILE_RE = /^3\d{9}$/;

/** Punctuation a merchant plausibly types inside a phone number: spaces (incl.
 * non-breaking, which is what a copy-paste from a web page yields), hyphens,
 * dots, and parentheses around a prefix. Stripped before validation; anything
 * else left over is a hard reject rather than something we quietly delete —
 * silently dropping a stray character could turn a typo into a *different,
 * valid* number, and then the store's replies go to a stranger. */
const SEPARATORS_RE = /[\s .\-()]/g;

/**
 * Normalizes anything a Colombian merchant would realistically type into the
 * single canonical E.164 form `+57XXXXXXXXXX`, or returns `null` if it is not
 * a Colombian mobile.
 *
 * Accepted inputs — all of these are the same number:
 *
 * ```
 * 3001234567          300 123 4567        300-123-4567
 * +573001234567       +57 300 123 4567    57 300 123 4567
 * 0057 3001234567     (300) 1234567
 * ```
 *
 * ## Why normalize at all rather than store what was typed
 *
 * `displayPhone` is what an owner sees in `/configuracion`, but it is also the
 * only human-readable handle on the row that routing depends on. Two rows that
 * read `300 123 4567` and `+573001234567` are the same line, and an owner
 * looking at a list of numbers should not have to work that out. One canonical
 * form also means a future "is this number already connected?" check is a
 * string comparison instead of a fuzzy match.
 *
 * ## Why `+57…` and not bare digits
 *
 * The adapters do NOT need this shape — `normalizePhone` in
 * `packages/whatsapp/src/phone.ts` strips to digits at the wire boundary
 * anyway, and it stays the authority there. That helper is deliberately not
 * reused here and this one is not pushed down there either: it does a
 * different job (transport-level cleanup of a JID a *provider* sent, no country
 * rules, never rejects) and `@ventia/core` does not depend on
 * `@ventia/whatsapp`. This form is chosen for the human on the other end of
 * the admin UI, where `+57` is how a Colombian number is written down.
 */
export function normalizeColombianMobile(raw: string): string | null {
  const stripped = raw.trim().replace(SEPARATORS_RE, '');

  // Peel the international prefix in either notation: `+57…` or `0057…` (what
  // you dial from a Colombian landline), plus a bare `57…` on a 12-digit input.
  let digits = stripped;
  if (digits.startsWith('+')) digits = digits.slice(1);
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (!/^\d+$/.test(digits)) return null;
  if (digits.length === 12 && digits.startsWith(COLOMBIA_COUNTRY_CODE)) {
    digits = digits.slice(COLOMBIA_COUNTRY_CODE.length);
  }

  if (!COLOMBIAN_MOBILE_RE.test(digits)) return null;
  return `+${COLOMBIA_COUNTRY_CODE}${digits}`;
}

/**
 * `displayPhone` — the merchant's WhatsApp line, in any format they type,
 * normalized to `+57XXXXXXXXXX`.
 *
 * The `max(24)` runs *before* the transform so a pasted paragraph is rejected
 * as a length problem rather than dragged through the normalizer; 24 is
 * comfortably more than the longest legitimate form (`+57 300 123 4567` is 17).
 * The error message names the expected shape because the alternative — a
 * connected number that silently never receives anything — is the single most
 * expensive mistake available in this form.
 */
export const colombianMobileSchema = z
  .string()
  .trim()
  .max(24)
  .transform((raw, ctx) => {
    const normalized = normalizeColombianMobile(raw);
    if (normalized === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Debe ser un celular colombiano de 10 dígitos que empiece por 3 (por ejemplo 300 123 4567 o +57 300 123 4567). Las líneas fijas y los números cortos no pueden recibir WhatsApp.',
      });
      return z.NEVER;
    }
    return normalized;
  });

/* -------------------------------------------------------------------------- */
/* Secrets                                                                     */
/* -------------------------------------------------------------------------- */

/** Anything that ends up as an HTTP header value (`Authorization: Bearer …`,
 * `apikey: …`) must not contain a control character or a newline: CR/LF in a
 * header value is header injection, and a stray tab or NUL just produces an
 * opaque 400 from the provider hours later. Rejecting at the form is where the
 * merchant can still see which field they mis-pasted. */
const NO_CONTROL_CHARS_RE = /^[^\u0000-\u001f\u007f]+$/;

const headerSafeSecret = (max: number) =>
  z.string().trim().min(8).max(max).regex(NO_CONTROL_CHARS_RE, {
    message: 'No puede contener saltos de línea ni caracteres de control',
  });

/* -------------------------------------------------------------------------- */
/* Connect a number                                                            */
/* -------------------------------------------------------------------------- */

/**
 * `POST /v1/admin/whatsapp/numbers` body (owner-only, plan-gated on
 * `TenantLimits.whatsappChannel` — design §5).
 *
 * A discriminated union on `provider` rather than one object of optionals,
 * because the two providers do not overlap in anything but `displayPhone`.
 * Cloud API identifies a line by a Meta-issued `phone_number_id` and
 * authenticates per-payload with an app-secret HMAC; Evolution identifies it by
 * a self-chosen instance name on a self-hosted base URL and has no per-payload
 * signature at all. Modelling that as `appSecret?: string` would let a Cloud
 * connection be saved with no way to verify a single inbound delivery — the
 * union makes the required-for-Cloud fields actually required.
 */
export const whatsappConnectSchema = z.discriminatedUnion('provider', [
  z.object({
    provider: z.literal('cloud'),
    /** THE routing key (design §1): stored in `WhatsAppNumber.externalId`,
     * `@unique` globally, and matched against
     * `entry[].changes[].value.metadata.phone_number_id` on every delivery.
     *
     * Digits only, and that is a security bound, not tidiness: this value is
     * interpolated straight into a URL path
     * (`graph.facebook.com/v21.0/{phone_number_id}/messages`), so a slash or a
     * `..` in it would repoint an outbound send at a different Graph endpoint.
     * Meta issues these as numeric ids, so nothing legitimate is excluded. */
    phoneNumberId: z
      .string()
      .trim()
      .min(5)
      .max(32)
      .regex(/^\d+$/, { message: 'El phone number ID de Meta son solo dígitos' }),
    /** Permanent or system-user token, sent as `Authorization: Bearer`. Meta's
     * system-user tokens run past 200 characters, so 512 is the ceiling that
     * leaves headroom without accepting a pasted file. */
    accessToken: headerSafeSecret(512),
    /** Meta app secret — the HMAC key for `X-Hub-Signature-256`. 32 hex
     * characters today; bounded generously rather than pinned to a length, so
     * a rotated-format secret does not brick the form. */
    appSecret: headerSafeSecret(128),
    /** Echoed back verbatim during Meta's GET handshake, so it is merchant-
     * chosen text that leaves our system. `min(8)` because a two-character
     * verify token is a shared secret in name only — anyone who guesses it can
     * complete the handshake against this endpoint. */
    verifyToken: headerSafeSecret(128),
    displayPhone: colombianMobileSchema,
  }),
  z.object({
    provider: z.literal('evolution'),
    /** THE routing key for Evolution (design §1, same `externalId` column):
     * the instance name. Restricted to `[A-Za-z0-9._-]` for the same reason
     * `phoneNumberId` is digits-only — it is interpolated into a URL path
     * (`{baseUrl}/message/sendText/{instance}`), and Evolution instance names
     * are slugs in practice. */
    instanceName: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9._-]+$/, {
        message: 'Solo letras, números, puntos, guiones y guiones bajos',
      }),
    /** The instance apikey, sent as the `apikey` header. */
    apiKey: headerSafeSecret(256),
    /** Base URL of the self-hosted Evolution instance. Restricted to
     * http/https: `z.string().url()` alone happily accepts `javascript:` and
     * `file:`, and this value is the prefix of every outbound request this
     * tenant makes. `http` stays allowed because Evolution is the *development*
     * provider (design §2) and typically runs on `http://localhost`. */
    baseUrl: z
      .string()
      .trim()
      .max(200)
      .url()
      .refine((v) => /^https?:\/\//i.test(v), {
        message: 'La URL debe empezar por http:// o https://',
      }),
    displayPhone: colombianMobileSchema,
  }),
]);

/* -------------------------------------------------------------------------- */
/* Update an already-connected number                                          */
/* -------------------------------------------------------------------------- */

/** The two states an owner can move a number between from the admin UI. The
 * third status the column carries, `pending` (design §1), is deliberately NOT
 * here: it is the state a row is *created* in and is left by verification, not
 * by an owner clicking a toggle. Letting the UI write it back would mean an
 * owner could park a live number in a state the connection flow expects to
 * resolve on its own. */
export const WHATSAPP_NUMBER_STATUSES = ['connected', 'disabled'] as const;
export type WhatsAppNumberStatus = (typeof WHATSAPP_NUMBER_STATUSES)[number];

/**
 * `PATCH /v1/admin/whatsapp/numbers/:id` body — enable or disable an already-
 * connected number.
 *
 * Status only. Credentials are not editable in place on purpose: rotating a
 * token is re-connecting, and doing it through this endpoint would mean a
 * half-updated credential set (new token, old app secret) sitting live between
 * two requests. An enum rather than a boolean because the column stores the
 * string, and mapping `enabled: false` → `'disabled'` in the controller is one
 * more place for the two vocabularies to drift apart.
 */
export const whatsappNumberUpdateSchema = z.object({
  status: z.enum(WHATSAPP_NUMBER_STATUSES),
});

export type WhatsAppConnectInput = z.infer<typeof whatsappConnectSchema>;
export type WhatsAppNumberUpdateInput = z.infer<typeof whatsappNumberUpdateSchema>;
