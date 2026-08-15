import { apiFetch } from './api';
import type { OrderStatus } from './orders-api';

/** Mirrors `PaymentAlertOrder` from
 * `services/api/src/payment-alerts/payment-alerts.service.ts` — hand-written
 * rather than imported for the same reason `orders-api.ts` hand-writes
 * `OrderStatus`: this app cannot reach into `services/api/src`. */
export interface PaymentAlertOrder {
  id: string;
  number: number;
  status: OrderStatus;
  paymentStatus: string;
  createdAt: string;
  email: string;
}

/** Every action a merchant can record against an alert. Mirrors the
 * `WebhookEventReviewAction` enum in schema.prisma. */
export type ReviewAction = 'refunded' | 'order_taken_again' | 'no_action_needed' | 'other' | 'reopened';

/** Mirrors `PaymentAlertReview`. `reviewedByEmail` is a snapshot the API took
 * when the review was filed, not a live join — see the model's comment. */
export interface PaymentAlertReview {
  action: ReviewAction;
  note: string | null;
  reviewedByEmail: string;
  reviewedAt: string;
}

/** Mirrors `PaymentAlertDTO`. Note what is NOT here and never will be: the
 * gateway `payload`. The API projects it away server-side (it carries shopper
 * PII and signature material); this type exists partly to make that boundary
 * visible on the client too. */
export interface PaymentAlert {
  id: string;
  provider: string;
  eventId: string;
  occurredAt: string;
  /** A REAL order of this merchant's, or null. Never the gateway's unmatched
   * claim — that is `referencedOrderNumber`. */
  orderNumber: number | null;
  /** The order number the GATEWAY's payload named, matched or not. Rendered
   * only ever as the gateway's own reference. */
  referencedOrderNumber: number | null;
  amountCents: number | null;
  order: PaymentAlertOrder | null;
  /** The current review, or null while the alert is still pending. */
  review: PaymentAlertReview | null;
}

export interface PaymentAlertListResponse {
  items: PaymentAlert[];
  total: number;
  page: number;
  pageSize: number;
}

/** Which half of the page: the alarm, or the record of what was handled. */
export type AlertStatusFilter = 'pending' | 'reviewed';

/** The dedicated page's route. Single source of truth shared by `nav.ts`, the
 * shell banner's CTA, and the banner's own "am I already on that page?"
 * check — three places that must never drift apart. */
export const ALERTS_PATH = '/pagos-por-revisar';

export interface PaymentAlertListParams {
  page: number;
  pageSize: number;
  status: AlertStatusFilter;
}

export function listPaymentAlerts(params: PaymentAlertListParams): Promise<PaymentAlertListResponse> {
  const qs = new URLSearchParams();
  qs.set('page', String(params.page));
  qs.set('pageSize', String(params.pageSize));
  qs.set('status', params.status);
  return apiFetch<PaymentAlertListResponse>(`/v1/admin/payment-alerts?${qs.toString()}`);
}

export interface ReviewPaymentAlertResponse {
  review: PaymentAlertReview;
  pending: boolean;
}

/** Records what the merchant did about one alert. Append-only server-side:
 * this never edits or removes anything, and `reopened` is how a mistaken
 * review is undone (by adding a row, not by deleting one). */
export function reviewPaymentAlert(
  id: string,
  input: { action: ReviewAction; note?: string },
): Promise<ReviewPaymentAlertResponse> {
  return apiFetch<ReviewPaymentAlertResponse>(`/v1/admin/payment-alerts/${id}/review`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/** What the merchant picks from, in their words. `reopened` is deliberately
 * absent: it is not a resolution, it is the undo, and it gets its own button
 * in the "Revisados" section rather than a slot in this list. */
export const REVIEW_ACTION_OPTIONS: ReadonlyArray<{ value: ReviewAction; label: string }> = [
  { value: 'refunded', label: 'Le devolví el dinero' },
  { value: 'order_taken_again', label: 'El cliente volvió a hacer el pedido' },
  { value: 'no_action_needed', label: 'No había nada que hacer' },
  { value: 'other', label: 'Otra cosa' },
];

/** Past-tense labels for displaying a review that already happened, including
 * the undo. */
export const REVIEW_ACTION_LABEL: Record<ReviewAction, string> = {
  refunded: 'Devolvió el dinero',
  order_taken_again: 'El cliente volvió a hacer el pedido',
  no_action_needed: 'No había nada que hacer',
  other: 'Otra cosa',
  reopened: 'Lo reabrió',
};

/** Merchant-facing gateway names. A merchant knows "Wompi", not `wompi` —
 * and an unrecognized provider falls back to the raw id rather than to a
 * generic word, because that id is exactly what they'd type into a support
 * ticket. */
const PROVIDER_LABEL: Record<string, string> = {
  wompi: 'Wompi',
  mercadopago: 'Mercado Pago',
  epayco: 'ePayco',
};

export function providerLabel(provider: string): string {
  return PROVIDER_LABEL[provider] ?? provider;
}

/**
 * The banner's one-line summary. Singular/plural is written out rather than
 * bolted on with a trailing `(s)`, which reads as machine output in Spanish.
 *
 * Deliberately says what HAPPENED and to WHOM ("le cobraron al cliente"),
 * not what the system's enum is called: the merchant reading this has never
 * heard of a webhook and does not need to.
 *
 * Tuteo, like every other merchant-facing string in this app (see
 * lib/errors.ts: "Alcanzaste el límite de tu plan", "Debes iniciar sesión").
 * The banner previously mixed in an usted-style "su pedido" while the page
 * next to it used "Recibiste"/"tu pasarela"; "a ningún pedido" also happens
 * to be the more accurate phrase, since the whole point is that the payment
 * landed on no order at all.
 */
export function alertsBannerSummary(total: number): string {
  return total === 1
    ? 'Recibiste 1 pago que no se pudo aplicar a ningún pedido. Al cliente ya le cobraron.'
    : `Recibiste ${total} pagos que no se pudieron aplicar a ningún pedido. A esos clientes ya les cobraron.`;
}

/**
 * Which of the genuinely different situations this row is.
 *
 * `paid_order_not_settleable` is written whenever `markPaid` returns false,
 * and it returns false for ANY order that is not `PENDING` +
 * (`PENDING`|`FAILED`) — so one result code covers at least two situations
 * whose correct remedies are OPPOSITE:
 *
 *  - `expired`       — the dominant case. The order was cancelled (almost
 *                      always by the 15-minute stock-reservation expiry)
 *                      before the payment arrived. The customer paid and has
 *                      NO order.
 *  - `double_charge` — a second PAID event on an order that was ALREADY
 *                      settled: a shopper who retried checkout and was
 *                      charged twice. The customer DOES have their order, and
 *                      only the duplicate should be refunded.
 *  - `unidentified`  — the event could not be tied to an order at all, so we
 *                      must not claim to know which of the two it is.
 */
export type AlertCause = 'expired' | 'double_charge' | 'unidentified';

export interface AlertGuidance {
  cause: AlertCause;
  /** What actually happened, in this row's own terms. */
  whatHappened: string;
  /** What the merchant should do about THIS row. */
  whatToDo: string;
}

/**
 * Per-row guidance derived from the resolved order's real state.
 *
 * This replaces a blanket paragraph that asserted, for every row, that the
 * order "ya estaba cancelado" and that the customer "no tiene un pedido" —
 * which was false (and money-losing) for the double-charge case: a merchant
 * following it would refund against an order they had already delivered. The
 * reviewer hit exactly that live, on a row reading "Estado del pedido:
 * Entregado / PAID".
 *
 * Keyed on `paymentStatus === 'PAID'` rather than on `status`, because "was
 * this order already settled?" is precisely the question that separates the
 * two remedies — and an order can be PAID at any fulfilment stage
 * (CONFIRMED through DELIVERED), or even PAID and later CANCELLED.
 *
 * Note also what none of these say: "toma el pedido de nuevo [en el panel]".
 * There is no way to create an order in the admin — `orders.controller.ts`
 * exposes only `@Get`/`@Get(':id')` and five `@Patch` transitions, and the
 * admin has no order-creation UI — so an instruction to re-enter the order
 * here describes an action the product cannot perform. If the customer takes
 * it again they place a NEW order in the storefront.
 */
export function alertGuidance(alert: Pick<PaymentAlert, 'order'>): AlertGuidance {
  if (!alert.order) {
    return {
      cause: 'unidentified',
      whatHappened: 'No pudimos identificar a qué pedido corresponde este pago.',
      whatToDo:
        'Busca la referencia de la pasarela en el panel de tu pasarela para ver a quién le cobraron y por cuánto. Desde ahí puedes devolverle el dinero si corresponde.',
    };
  }

  if (alert.order.paymentStatus === 'PAID') {
    return {
      cause: 'double_charge',
      whatHappened:
        'Este pedido ya estaba pagado cuando llegó este segundo cobro. Lo más probable es que el cliente haya intentado pagar dos veces y se le haya cobrado dos veces.',
      whatToDo:
        'El cliente sí tiene su pedido y no hay que rehacerlo: no lo canceles. Devuélvele únicamente este cobro duplicado desde el panel de tu pasarela.',
    };
  }

  return {
    cause: 'expired',
    whatHappened:
      'Cuando llegó el pago, este pedido ya no se podía completar: se canceló antes, casi siempre porque el cliente demoró más de 15 minutos en pagar y venció la reserva de inventario. Al cliente le cobraron y se quedó sin pedido.',
    whatToDo:
      'El pedido no se puede revivir desde el panel. Habla con el cliente: si todavía tienes el inventario y quiere el pedido, tiene que hacer un pedido nuevo en tu tienda. Si no, devuélvele el dinero desde el panel de tu pasarela.',
  };
}

/** The dedicated page's pagination footer, matching `/pedidos`'s
 * "Página X de Y · N pedidos" shape with this page's own noun. */
export function alertsCountLabel(total: number): string {
  return total === 1 ? '1 pago por revisar' : `${total} pagos por revisar`;
}
