/**
 * READ-ONLY, DISPLAY-ONLY projection of a stored `WebhookEvent.payload` down
 * to the two identifiers that can point it back at an `Order`.
 *
 * ## Why this exists at all
 *
 * `WebhookEvent` has no `orderId` column. The webhook handler
 * (services/api/src/payments/webhooks.controller.ts) resolves an event to an
 * order in memory, from the adapter-verified `reference`, and never persists
 * that link. So the only way to tell a merchant WHICH order a
 * `paid_order_not_settleable` event was about, without editing the settle
 * path, is to read it back out of the durable payload.
 *
 * Adding an `orderId` column and writing it from the handler would be
 * strictly better — one authoritative link, no per-provider payload
 * knowledge, and Mercado Pago (see below) would stop being a partial case.
 * That is a change to `webhooks.controller.ts`, which this work is explicitly
 * not permitted to touch, so it is raised as a follow-up instead of made
 * here.
 *
 * ## Why it is safe for this to be imperfect
 *
 * Nothing here can settle, cancel, refund or otherwise move money. Its entire
 * output is two nullable display hints, and every failure mode degrades to
 * `null` — which the UI renders as "no pudimos identificar el pedido" next to
 * the gateway's own event id, still leaving the merchant able to find the
 * charge in their gateway dashboard. A wrong guess is the only thing that
 * would actually be harmful, which is why the parsing below is strict
 * (exact field paths per provider, `/^\d+$/` on the reference, no coercion,
 * no fuzzy search) and why an unknown provider yields nothing rather than
 * guessing at field names.
 *
 * ## Per-provider reality
 *
 *  - **wompi** — `data.transaction.reference` is the exact string
 *    `WompiProvider.createCheckoutSession` sent as `reference:
 *    order.orderNumber`, and it is signature-covered on the delivered event.
 *    `data.transaction.id` is Wompi's own transaction id (`providerRef`).
 *    Resolves essentially always.
 *  - **epayco** — `x_extra1` is the slot the adapter puts the order number in
 *    and reads back (see epayco.ts). `x_ref_payco` is ePayco's transaction
 *    id. Resolves essentially always. Note `x_extra1` is NOT covered by
 *    ePayco's confirmation hash — irrelevant here, since this value is used
 *    only to look up a row to display, never to authorize anything.
 *  - **mercadopago** — the delivered notification body is deliberately just
 *    `{type, data:{id}}` (design doc decision 5). It carries NO
 *    `external_reference`, `status` or amount; the adapter gets those from an
 *    authenticated `GET /v1/payments/{id}` that is never persisted. So the
 *    only link available is `data.id` -> `Order.providerRef`, which resolves
 *    only when that order actually has a providerRef recorded. When it does
 *    not, the alert still lists, with a null order.
 */

/** `Order.number` is a Postgres `int4`; a larger value would make Prisma
 * throw on the Int filter rather than simply not match. Same bound
 * webhooks.controller.ts applies to a reference before using it. */
const MAX_ORDER_NUMBER = 2_147_483_647;

export interface WebhookLinks {
  /** The `Order.number` this event names, or `null` when the payload carries
   * no usable reference for this provider. */
  orderNumber: number | null;
  /** The gateway's own transaction/payment id, or `null`. Matched against
   * `Order.providerRef` as a fallback when `orderNumber` is null. */
  providerRef: string | null;
}

const NONE: WebhookLinks = { orderNumber: null, providerRef: null };

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Exactly webhooks.controller.ts's `referenceIsPlainOrderNumber` rule:
 * `/^\d+$/` (never `Number()`, which maps `" 42 "`, `"4.2e1"`, `"+42"` and
 * `"0x2a"` all onto the same order) plus the int4 upper bound. */
function toOrderNumber(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return parsed <= MAX_ORDER_NUMBER ? parsed : null;
}

function toProviderRef(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function projectWebhookLinks(provider: string, payload: unknown): WebhookLinks {
  const body = asRecord(payload);
  if (!body) return NONE;

  if (provider === 'wompi') {
    const transaction = asRecord(asRecord(body.data)?.transaction);
    if (!transaction) return NONE;
    return {
      orderNumber: toOrderNumber(transaction.reference),
      providerRef: toProviderRef(transaction.id),
    };
  }

  if (provider === 'epayco') {
    return {
      orderNumber: toOrderNumber(body.x_extra1),
      providerRef: toProviderRef(body.x_ref_payco),
    };
  }

  if (provider === 'mercadopago') {
    return {
      orderNumber: null,
      providerRef: toProviderRef(asRecord(body.data)?.id),
    };
  }

  // A provider this file has never seen. Guessing at field names here is the
  // one thing that could produce a WRONG order link, so it deliberately
  // produces none — the alert still lists with the gateway's event id.
  return NONE;
}
