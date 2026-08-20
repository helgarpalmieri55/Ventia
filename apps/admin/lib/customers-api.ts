import { apiFetch } from './api';

/** Client for `/v1/admin/customers` — the Clientes section (SPEC §6 M8) and
 * the Ley 1581 supresión action (SPEC §9). Types are hand-written rather than
 * imported, same reason as `conversations-api.ts`: this app cannot reach into
 * `services/api/src`. */

export const CUSTOMERS_PATH = '/clientes';

export interface Customer {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  ordersCount: number;
  totalSpentCents: number;
  /** The server's own verdict, derived from the sentinel values it wrote —
   * never re-derived here, so the UI cannot disagree with the database. */
  anonymized: boolean;
}

export interface CustomerListResponse {
  items: Customer[];
  total: number;
  page: number;
  pageSize: number;
}

export interface CustomerOrder {
  id: string;
  number: number;
  status: string;
  paymentStatus: string;
  totalCents: number;
  createdAt: string;
}

export interface CustomerDetail extends Customer {
  orders: CustomerOrder[];
}

/** Mirrors `PRIVACY_REQUEST_CHANNELS` in `@ventia/core` — a closed list, not
 * free text, so the audit row this ends up in can never contain the personal
 * data the same action just erased. */
export const REQUEST_CHANNELS = ['correo', 'whatsapp', 'telefono', 'presencial', 'otro'] as const;
export type RequestChannel = (typeof REQUEST_CHANNELS)[number];

export const REQUEST_CHANNEL_LABELS: Record<RequestChannel, string> = {
  correo: 'Correo electrónico',
  whatsapp: 'WhatsApp',
  telefono: 'Llamada telefónica',
  presencial: 'En la tienda',
  otro: 'Otro medio',
};

/** The word the merchant must type. Same literal the API requires, so a UI
 * that forgets to ask still cannot anonymize by accident. */
export const CONFIRM_WORD = 'ANONIMIZAR';

export interface AnonymizeCounts {
  customer: number;
  orders: number;
  orderEvents: number;
  conversations: number;
  messages: number;
  notifications: number;
  auditLogs: number;
  webhookEvents: number;
}

export interface AnonymizeResponse {
  customerId: string;
  alreadyAnonymized: boolean;
  counts: AnonymizeCounts;
}

export async function listCustomers(q: string, page: number, pageSize = 20): Promise<CustomerListResponse> {
  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  if (q.trim()) params.set('q', q.trim());
  return apiFetch<CustomerListResponse>(`/v1/admin/customers?${params.toString()}`);
}

export async function getCustomer(id: string): Promise<CustomerDetail> {
  return apiFetch<CustomerDetail>(`/v1/admin/customers/${id}`);
}

export async function anonymizeCustomer(id: string, requestChannel: RequestChannel): Promise<AnonymizeResponse> {
  return apiFetch<AnonymizeResponse>(`/v1/admin/customers/${id}/anonymize`, {
    method: 'POST',
    body: JSON.stringify({ requestChannel, confirm: CONFIRM_WORD }),
  });
}

/** How a customer is named in a table cell when they have no name on file —
 * and, once anonymized, what replaces the name they used to have. The server
 * writes `Cliente anonimizado` into `name`, so this is only a fallback for a
 * customer who never gave one. */
export function customerLabel(customer: Customer): string {
  return customer.name?.trim() || customer.email?.trim() || customer.phone?.trim() || 'Cliente sin datos';
}

/** es-CO summary of what an anonymization actually rewrote, for the success
 * message. Zero-count tables are omitted so a merchant reads a sentence, not
 * a table of zeroes. */
export function anonymizeSummary(response: AnonymizeResponse): string {
  if (response.alreadyAnonymized) {
    return 'Este cliente ya estaba anonimizado. No había datos personales por eliminar.';
  }
  const parts: string[] = [];
  const push = (n: number, one: string, many: string) => {
    if (n > 0) parts.push(`${n} ${n === 1 ? one : many}`);
  };
  push(response.counts.orders, 'pedido', 'pedidos');
  push(response.counts.orderEvents, 'evento de pedido', 'eventos de pedido');
  push(response.counts.conversations, 'conversación', 'conversaciones');
  push(response.counts.messages, 'mensaje', 'mensajes');
  push(response.counts.notifications, 'notificación', 'notificaciones');
  push(response.counts.auditLogs, 'registro de auditoría', 'registros de auditoría');
  push(response.counts.webhookEvents, 'evento de pasarela', 'eventos de pasarela');
  if (parts.length === 0) return 'Eliminamos los datos personales del cliente.';
  return `Eliminamos los datos personales del cliente y de ${parts.join(', ')}. Los montos, las fechas y los pedidos siguen intactos.`;
}
