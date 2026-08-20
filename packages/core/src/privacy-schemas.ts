import { z } from 'zod';

/**
 * Ley 1581 de 2012 (Habeas Data) — *derecho de supresión*, SPEC §9:
 *
 * > customer data deletion flow: request → anonymize orders (keep amounts for
 * > accounting, strip PII)
 *
 * A Colombian data subject can demand their personal data be erased, but the
 * merchant is simultaneously required to keep transaction records for
 * accounting/tax purposes. The two obligations only reconcile one way:
 * **anonymization, not deletion**. Every row survives, every amount survives,
 * every date and status survives — the person is overwritten with the
 * sentinels below.
 *
 * The sentinels live in `@ventia/core` rather than in the API service because
 * three consumers need to agree on them: the service that writes them, the
 * admin UI that must recognise an already-anonymized customer without asking
 * the API "is this anonymized?", and the anonymizer's OWN idempotency check
 * (see `isAnonymizedValue`) — running the flow twice must be a no-op, which
 * is only possible if the second run can recognise its own first-run output.
 */

/** Replaces `Customer.name` and any `nombreCompleto` in a shipping address. */
export const ANON_NAME = 'Cliente anonimizado';

/** Replaces `Customer.phone`, `Order.phone` and any address `telefono`.
 *
 * A syntactically plausible but unreachable number rather than an empty
 * string: `Order.phone` is `NOT NULL`, and several read paths (order
 * tracking, WhatsApp notifications) treat a present-but-empty string
 * differently from a present one. Ten zeroes is never a real Colombian
 * number and is obviously a placeholder to a human reading the admin. */
export const ANON_PHONE = '0000000000';

/** RFC 2606 reserved TLD — guaranteed never to resolve, so a stray
 * notification aimed at an anonymized order can never reach a real inbox. */
export const ANON_EMAIL_DOMAIN = 'anonimizado.invalid';

/** Replaces the street-level part of an address (`direccion`). Departamento
 * and municipio are deliberately KEPT: they are aggregate geography the
 * merchant needs for shipping-zone reporting, not personal data. */
export const ANON_ADDRESS_LINE = 'Dirección eliminada';

/** The generic leaf replacement used by the JSON redactor for anything that
 * is not one of the typed fields above. */
export const ANON_REDACTED = '[dato eliminado]';

/** Replaces the body of a message the SHOPPER wrote. Their own prose cannot
 * be scanned reliably for personal data, so it is replaced wholesale rather
 * than pattern-matched — see the note on `PrivacyService.anonymizeCustomer`. */
export const ANON_MESSAGE_BODY = '[mensaje eliminado por solicitud de supresión de datos]';

/**
 * The e-mail written onto an anonymized `Customer` and all of its orders.
 *
 * Derived from the customer id rather than a constant so that (a) two
 * anonymized customers do not collapse into one identity in any report that
 * groups by e-mail, and (b) the value is a pure function of the row — which
 * is what makes the whole flow idempotent without adding a column to the
 * schema. `Customer.email` has no unique constraint, so this is a
 * convenience, not a requirement.
 */
export function anonymizedEmailFor(customerId: string): string {
  return `anon-${customerId}@${ANON_EMAIL_DOMAIN}`;
}

/**
 * True when `value` is already one of this module's sentinels.
 *
 * Load-bearing for idempotency: the second run of the anonymizer collects the
 * "secrets" it must scrub out of free-form JSON from the customer's own
 * columns, which by then hold sentinels. Without this filter it would go on to
 * replace `Cliente anonimizado` with `[dato eliminado]` everywhere, changing
 * rows on every run forever — the opposite of a no-op.
 */
export function isAnonymizedValue(value: string | null | undefined): boolean {
  if (!value) return false;
  const v = value.trim();
  if (v === ANON_NAME || v === ANON_PHONE || v === ANON_ADDRESS_LINE) return true;
  if (v === ANON_REDACTED || v === ANON_MESSAGE_BODY) return true;
  return v.endsWith(`@${ANON_EMAIL_DOMAIN}`);
}

/**
 * How the supresión request reached the merchant.
 *
 * A closed enum and NOT free text, deliberately. The audit row this ends up in
 * is the permanent record that the erasure happened, and SPEC §9's whole point
 * is that the erasure is real — a `note: string` field would be the one place
 * in this flow where a merchant could paste "solicitud de Juan Pérez,
 * 3001234567" and quietly re-create the personal data the same request just
 * destroyed. There is no shape of free text that is safe here, so there is no
 * free text.
 */
export const PRIVACY_REQUEST_CHANNELS = ['correo', 'whatsapp', 'telefono', 'presencial', 'otro'] as const;
export type PrivacyRequestChannel = (typeof PRIVACY_REQUEST_CHANNELS)[number];

/** es-CO labels for {@link PRIVACY_REQUEST_CHANNELS}, shared so the admin UI
 * and any future export render the same words. */
export const PRIVACY_REQUEST_CHANNEL_LABELS: Record<PrivacyRequestChannel, string> = {
  correo: 'Correo electrónico',
  whatsapp: 'WhatsApp',
  telefono: 'Llamada telefónica',
  presencial: 'En la tienda',
  otro: 'Otro medio',
};

/** The literal a caller must send to confirm. Irreversible operations in this
 * codebase get a confirmation step (SPEC §6 M6 requires one for cancelling a
 * paid order); this one is irreversible AND legally consequential, so the
 * confirmation is part of the request body rather than only a dialog in the
 * UI — a script or a second admin app cannot skip it. */
export const ANONYMIZE_CONFIRM_TOKEN = 'ANONIMIZAR';

/** `POST /v1/admin/customers/:id/anonymize` body. */
export const anonymizeCustomerSchema = z.object({
  requestChannel: z.enum(PRIVACY_REQUEST_CHANNELS),
  confirm: z.literal(ANONYMIZE_CONFIRM_TOKEN),
});
export type AnonymizeCustomerInput = z.infer<typeof anonymizeCustomerSchema>;

/** `GET /v1/admin/customers` query string.
 *
 * `page`/`pageSize` arrive as strings and are coerced here rather than in the
 * controller, matching `platform-schemas.ts`'s list query. `q` is matched
 * against name/email/phone server-side. */
export const customerListQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type CustomerListQuery = z.infer<typeof customerListQuerySchema>;
