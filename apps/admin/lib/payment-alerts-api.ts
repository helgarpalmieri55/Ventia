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

/** Mirrors `PaymentAlertDTO`. Note what is NOT here and never will be: the
 * gateway `payload`. The API projects it away server-side (it carries shopper
 * PII and signature material); this type exists partly to make that boundary
 * visible on the client too. */
export interface PaymentAlert {
  id: string;
  provider: string;
  eventId: string;
  occurredAt: string;
  orderNumber: number | null;
  amountCents: number | null;
  order: PaymentAlertOrder | null;
}

export interface PaymentAlertListResponse {
  items: PaymentAlert[];
  total: number;
  page: number;
  pageSize: number;
}

/** The dedicated page's route. Single source of truth shared by `nav.ts`, the
 * shell banner's CTA, and the banner's own "am I already on that page?"
 * check — three places that must never drift apart. */
export const ALERTS_PATH = '/pagos-por-revisar';

export interface PaymentAlertListParams {
  page: number;
  pageSize: number;
}

export function listPaymentAlerts(params: PaymentAlertListParams): Promise<PaymentAlertListResponse> {
  const qs = new URLSearchParams();
  qs.set('page', String(params.page));
  qs.set('pageSize', String(params.pageSize));
  return apiFetch<PaymentAlertListResponse>(`/v1/admin/payment-alerts?${qs.toString()}`);
}

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
 */
export function alertsBannerSummary(total: number): string {
  return total === 1
    ? 'Recibiste 1 pago que no se pudo aplicar a su pedido. Al cliente ya le cobraron.'
    : `Recibiste ${total} pagos que no se pudieron aplicar a sus pedidos. A esos clientes ya les cobraron.`;
}

/** The dedicated page's pagination footer, matching `/pedidos`'s
 * "Página X de Y · N pedidos" shape with this page's own noun. */
export function alertsCountLabel(total: number): string {
  return total === 1 ? '1 pago por revisar' : `${total} pagos por revisar`;
}
