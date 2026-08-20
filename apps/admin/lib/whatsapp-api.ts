import { apiFetch } from './api';

/**
 * Client for `/v1/admin/whatsapp/numbers` (owner-only — see
 * `services/api/src/whatsapp/whatsapp-admin.controller.ts`), plus the pure
 * form logic the tab needs.
 *
 * Types are hand-written mirrors of the server's, for the same reason
 * `payment-alerts-api.ts` hand-writes its own: this app cannot import from
 * `services/api/src`. The request bodies mirror `whatsappConnectSchema` in
 * `packages/core/src/whatsapp-schemas.ts` rather than importing its inferred
 * type, because that schema's `displayPhone` is a *transform* (typed `string`
 * in, `string` out) and reusing `WhatsAppConnectInput` here would silently
 * claim this form produces already-normalized `+57…` values. It does not — the
 * server normalizes.
 */

export type WhatsAppProviderId = 'cloud' | 'evolution';

/**
 * A connected number as the admin is allowed to see it — mirrors
 * `WhatsAppNumberView` in `whatsapp-numbers.service.ts`.
 *
 * There is deliberately no token, app secret or verify token here, and none
 * should ever be added: the API does not return them (they exist only
 * encrypted, decrypted for the duration of one outbound send), and the merchant
 * needs to know WHICH number is connected and whether it works, never the
 * credentials that make it work.
 */
export interface WhatsAppNumber {
  id: string;
  provider: WhatsAppProviderId;
  externalId: string;
  displayPhone: string;
  /** Typed `string`, not the two-value union `PATCH` accepts: the column also
   * carries `pending` (the state a row is created in and leaves by
   * verification), and a union here would be a lie the first time a `pending`
   * row arrives. {@link whatsappStatusLabel} handles the open set. */
  status: string;
  /** ISO-8601. `Date` on the server, a string by the time JSON gets here. */
  createdAt: string;
}

export interface WhatsAppNumbersResponse {
  items: WhatsAppNumber[];
  /** `TenantLimits.whatsappChannel`. False means the connect form must not be
   * shown at all: `POST` would 402, and the inbound handler drops messages for
   * a tenant without the channel anyway (whatsapp-inbound.service.ts). */
  channelEnabled: boolean;
  /** `https://api.…/webhooks/whatsapp` — the provider path and, for Cloud, the
   * `?number=` query param are appended client-side by
   * {@link whatsappCallbackUrl}. */
  callbackBaseUrl: string;
}

/** The two states an owner can move a number between. `pending` is absent on
 * purpose — see `whatsappNumberUpdateSchema`'s comment. */
export type WhatsAppNumberStatusInput = 'connected' | 'disabled';

/* -------------------------------------------------------------------------- */
/* Request bodies                                                             */
/* -------------------------------------------------------------------------- */

export interface WhatsAppCloudConnectBody {
  provider: 'cloud';
  phoneNumberId: string;
  accessToken: string;
  appSecret: string;
  verifyToken: string;
  displayPhone: string;
}

export interface WhatsAppEvolutionConnectBody {
  provider: 'evolution';
  instanceName: string;
  apiKey: string;
  baseUrl: string;
  displayPhone: string;
}

/** Mirrors the server's discriminated union. Kept a union rather than one
 * object of optionals for exactly the reason the schema is one: a Cloud
 * connection saved without `appSecret` could never verify a single inbound
 * delivery, and optional fields would let the form produce that. */
export type WhatsAppConnectBody = WhatsAppCloudConnectBody | WhatsAppEvolutionConnectBody;

/* -------------------------------------------------------------------------- */
/* Form state                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The connect form's raw field state: every provider's fields at once, so
 * switching the provider picker back and forth does not lose what was already
 * typed. Only the chosen provider's fields ever leave the browser — see
 * {@link buildWhatsAppConnectPayload}.
 *
 * As in `wompi-form.ts`, there is no `*ToFormState` counterpart: `GET` never
 * returns a credential to prefill from, so every secret field starts blank on
 * every mount, full stop.
 */
export interface WhatsAppFormFields {
  provider: WhatsAppProviderId;
  displayPhone: string;
  phoneNumberId: string;
  accessToken: string;
  appSecret: string;
  verifyToken: string;
  instanceName: string;
  apiKey: string;
  baseUrl: string;
}

export const BLANK_WHATSAPP_FORM: WhatsAppFormFields = {
  // Cloud is the default because it is the production provider; Evolution is
  // the self-hosted/development one (whatsapp design §2).
  provider: 'cloud',
  displayPhone: '',
  phoneNumberId: '',
  accessToken: '',
  appSecret: '',
  verifyToken: '',
  instanceName: '',
  apiKey: '',
  baseUrl: '',
};

/**
 * Maps the form state to the `POST` body for the CHOSEN provider only.
 *
 * The other provider's fields are omitted entirely rather than sent blank.
 * Zod would strip them anyway, so this is not about validation passing — it is
 * about not putting a secret the merchant typed into the wrong provider's form
 * onto the wire (and into any request log along the way) for a connection that
 * will never use it.
 *
 * Values go as typed, not trimmed: every field in `whatsappConnectSchema` is
 * `.trim()`-ed server-side, so trimming here would only duplicate that — and
 * `displayPhone` in particular is normalized there (`300 123 4567` →
 * `+573001234567`), which is not something this form should try to anticipate.
 */
export function buildWhatsAppConnectPayload(fields: WhatsAppFormFields): WhatsAppConnectBody {
  if (fields.provider === 'evolution') {
    return {
      provider: 'evolution',
      instanceName: fields.instanceName,
      apiKey: fields.apiKey,
      baseUrl: fields.baseUrl,
      displayPhone: fields.displayPhone,
    };
  }
  return {
    provider: 'cloud',
    phoneNumberId: fields.phoneNumberId,
    accessToken: fields.accessToken,
    appSecret: fields.appSecret,
    verifyToken: fields.verifyToken,
    displayPhone: fields.displayPhone,
  };
}

/* -------------------------------------------------------------------------- */
/* The callback URL                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The exact URL the merchant must configure with their provider.
 *
 * ## Why Cloud's carries `?number=<phoneNumberId>` and why that is not optional
 *
 * Meta's subscription handshake is a `GET` with only `hub.mode`,
 * `hub.verify_token` and `hub.challenge` — nothing identifying WHICH number is
 * being verified. One webhook URL serves every tenant on the platform (Meta
 * delivers per app, not per number), so `whatsapp-webhooks.controller.ts`'s
 * `verify` looks the number up by the `number` query param and answers 403
 * when it is missing. A callback URL pasted without it therefore fails
 * verification every time, with a Meta-side error that says nothing about the
 * cause — which is precisely why this is built in one place and tested.
 *
 * ## Why Evolution's does not
 *
 * Evolution has no `GET` handshake at all (`verify` 404s for any provider but
 * `cloud`), and its `POST` payload names the instance in its own `instance`
 * field, so the routing key is already in the body. Adding a query param there
 * would be cargo-culted noise.
 *
 * Returns `null` when a Cloud URL is asked for without a `phoneNumberId`: half
 * a callback URL is worse than none, because it looks copyable.
 */
export function whatsappCallbackUrl(
  callbackBaseUrl: string,
  provider: WhatsAppProviderId,
  externalId: string,
): string | null {
  const base = callbackBaseUrl.trim().replace(/\/+$/, '');
  if (!base) return null;

  if (provider === 'evolution') return `${base}/evolution`;

  const phoneNumberId = externalId.trim();
  if (!phoneNumberId) return null;
  return `${base}/cloud?number=${encodeURIComponent(phoneNumberId)}`;
}

/* -------------------------------------------------------------------------- */
/* Labels                                                                     */
/* -------------------------------------------------------------------------- */

/** Provider names as the merchant meets them in the provider's own dashboard,
 * not as the enum spells them. */
export const WHATSAPP_PROVIDER_LABEL: Record<WhatsAppProviderId, string> = {
  cloud: 'WhatsApp Cloud API (Meta)',
  evolution: 'Evolution API (servidor propio)',
};

/** What each provider calls its routing key, so the list can label the value
 * with the words the merchant will search for in that dashboard. */
export const WHATSAPP_EXTERNAL_ID_LABEL: Record<WhatsAppProviderId, string> = {
  cloud: 'Phone number ID',
  evolution: 'Instancia',
};

const STATUS_LABELS: Record<string, string> = {
  connected: 'Conectado',
  disabled: 'Desactivado',
  pending: 'Pendiente de verificar',
};

/** es-CO label for a row's status. Falls back to the raw value rather than to
 * a generic word: an unrecognized status is exactly what a merchant would
 * quote in a support ticket. */
export function whatsappStatusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

/* -------------------------------------------------------------------------- */
/* Requests                                                                   */
/* -------------------------------------------------------------------------- */

export function listWhatsAppNumbers(): Promise<WhatsAppNumbersResponse> {
  return apiFetch<WhatsAppNumbersResponse>('/v1/admin/whatsapp/numbers');
}

/** Connects a number, or re-connects one this store already owns (rotating a
 * token is a re-connect — the API has no credential-edit endpoint on purpose).
 * A re-connect returns the SAME row id, which is what lets the caller merge the
 * result into the list instead of appending a duplicate. */
export function connectWhatsAppNumber(body: WhatsAppConnectBody): Promise<WhatsAppNumber> {
  return apiFetch<WhatsAppNumber>('/v1/admin/whatsapp/numbers', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function setWhatsAppNumberStatus(id: string, status: WhatsAppNumberStatusInput): Promise<WhatsAppNumber> {
  return apiFetch<WhatsAppNumber>(`/v1/admin/whatsapp/numbers/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  });
}

export function disconnectWhatsAppNumber(id: string): Promise<{ ok: true }> {
  return apiFetch<{ ok: true }>(`/v1/admin/whatsapp/numbers/${id}`, { method: 'DELETE' });
}
