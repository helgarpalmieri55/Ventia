import { apiFetch } from './api';

/** Hand-written locally rather than imported from `@ventia/db` or
 * `services/api/src/orders/transitions.ts`: this app doesn't depend on
 * `@ventia/db` (only `@ventia/core`/`@ventia/ui`, see package.json) and
 * can't reach into `services/api/src` at all (that's a separate deployable,
 * not a workspace package this app depends on) — same reasoning as
 * `productos/page.tsx`'s locally hand-rolled `ProductStatus` union rather
 * than importing Prisma's generated enum. */
export type OrderStatus = 'PENDING' | 'CONFIRMED' | 'PREPARING' | 'SHIPPED' | 'DELIVERED' | 'CANCELLED';

export type OrderAction = 'confirm' | 'preparing' | 'shipped' | 'delivered' | 'cancel';

/** `''` renders as "Todos" and is never sent as a `status` query param, same
 * convention as `productos/page.tsx`'s `StatusFilter`. */
export type OrderStatusFilter = '' | OrderStatus;

/** Mirrors `OrderDTO` from `services/api/src/orders/orders.service.ts`,
 * trimmed to the fields the list table actually renders — same "narrower
 * than the wire shape" convention as `productos/page.tsx`'s
 * `ProductListItem` (which also doesn't mirror every `ProductDTO` field). */
export interface OrderListItem {
  id: string;
  number: number;
  status: OrderStatus;
  email: string;
  totalCents: number;
  createdAt: string;
}

export interface OrderListResponse {
  items: OrderListItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface OrderItem {
  id: string;
  productId: string | null;
  variantId: string | null;
  nameSnapshot: string;
  priceCentsSnapshot: number;
  qty: number;
  taxRateSnapshot: string;
}

export interface OrderEvent {
  id: string;
  type: string;
  actor: string;
  data: unknown;
  createdAt: string;
}

/** Full merchant-facing shape — mirrors `OrderDetail` (which extends
 * `OrderDTO` with `items`/`events`) field-for-field, no redaction: this is
 * the merchant's own view of their own order, unlike the storefront's
 * narrower public tracking DTO. */
export interface OrderDetail {
  id: string;
  number: number;
  status: OrderStatus;
  paymentStatus: string;
  paymentProvider: string | null;
  customerId: string | null;
  email: string;
  phone: string;
  shippingAddress: unknown;
  billingFields: unknown;
  shippingMethod: string | null;
  // The tenant's CURRENT label for `shippingMethod` (an opaque id, never a
  // label itself — resolved server-side by
  // services/api/src/checkout/shipping.service.ts's `findMethodLabel`).
  // `null` when the id no longer matches any of the tenant's configured
  // methods (deleted since this order was placed) — render a graceful
  // fallback, never the raw `shippingMethod` id itself.
  shippingMethodLabel: string | null;
  shippingCents: number;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  source: string;
  createdAt: string;
  updatedAt: string;
  items: OrderItem[];
  events: OrderEvent[];
}

/** Order numbers are always rendered with this prefix in merchant-facing
 * text (spec's "never expose raw UUIDs... e.g. VNT-1042") — same literal
 * pattern as `services/api/src/mailer/order-emails.ts`'s `vnt()`; a small
 * per-module copy here rather than a shared one. */
export function vnt(orderNumber: number): string {
  return `VNT-${orderNumber}`;
}

export const STATUS_LABEL: Record<OrderStatus, string> = {
  PENDING: 'Pendiente',
  CONFIRMED: 'Confirmado',
  PREPARING: 'Preparando',
  SHIPPED: 'Enviado',
  DELIVERED: 'Entregado',
  CANCELLED: 'Cancelado',
};

export const STATUS_BADGE_VARIANT: Record<OrderStatus, 'default' | 'secondary' | 'destructive'> = {
  PENDING: 'secondary',
  CONFIRMED: 'secondary',
  PREPARING: 'secondary',
  SHIPPED: 'secondary',
  DELIVERED: 'default',
  CANCELLED: 'destructive',
};

export const ACTION_LABEL: Record<OrderAction, string> = {
  confirm: 'Confirmar pedido',
  preparing: 'Marcar en preparación',
  shipped: 'Marcar enviado',
  delivered: 'Marcar entregado',
  cancel: 'Cancelar pedido',
};

/**
 * CLIENT-SIDE MIRROR of `services/api/src/orders/transitions.ts`'s
 * `ALLOWED_ACTIONS`, hand-written independently (not imported — this app
 * cannot import from `services/api/src` at all, and even if it could, the
 * whole point of `test/orders-status.test.ts` is to catch drift between two
 * independently-maintained copies). Used ONLY to decide which action buttons
 * to render on `/pedidos/[id]` — a UX nicety, NOT a security boundary: the
 * server independently and authoritatively re-checks this same table (under
 * an advisory lock) on every PATCH regardless of what this array says, and
 * rejects an invalid transition with `409 INVALID_TRANSITION` even if this
 * mirror is stale or wrong. Keep in sync with the server's table by hand;
 * `orders-status.test.ts` asserts the exact expected set per status so a
 * future drift shows up as a failing test rather than a silently wrong
 * button.
 */
export const ALLOWED_ACTIONS: Record<OrderStatus, OrderAction[]> = {
  PENDING: ['confirm', 'cancel'],
  CONFIRMED: ['preparing', 'cancel'],
  PREPARING: ['shipped', 'cancel'],
  SHIPPED: ['delivered', 'cancel'],
  DELIVERED: [],
  CANCELLED: [],
};

/** The subset of an order this gate reads — so the check can be unit-tested
 * without building a whole `OrderDetail`. */
export interface PaymentGateFields {
  paymentStatus: string;
  paymentProvider: string | null;
}

/**
 * CLIENT-SIDE MIRROR of `services/api/src/orders/transitions.ts`'s
 * `isBlockedByPendingOnlinePayment` — the same "confirm is COD-only" rule,
 * hand-written independently for the same reason `ALLOWED_ACTIONS` above is
 * (this app cannot import from `services/api/src`).
 *
 * `ALLOWED_ACTIONS` alone said "PENDING can be confirmed", so `/pedidos/[id]`
 * rendered "Confirmar pedido" for EVERY pending order — including an
 * online-payment order still waiting on its gateway, where pressing it
 * double-decremented stock and stranded the order in CONFIRMED/PENDING (see
 * the server-side function's doc comment for the reproduced damage).
 *
 * Like `ALLOWED_ACTIONS`, this is a UX gate and NOT a security boundary: the
 * server re-checks the same rule under an advisory lock on every PATCH and
 * answers `409 ONLINE_PAYMENT_PENDING` regardless of what this returns.
 */
export function isConfirmBlockedByPayment(order: PaymentGateFields): boolean {
  return order.paymentStatus === 'PENDING' && order.paymentProvider !== null;
}

/** `shippingAddress` comes over the wire as `Prisma.JsonValue` (loosely
 * typed server-side too, see `orders.service.ts`'s `OrderDTO`) — defensively
 * narrowed to the `CheckoutAddressInput` shape (`@ventia/core`'s
 * `address-schemas.ts`) since that's the only shape checkout ever writes,
 * but nothing on this side guarantees it at the type level. Every field
 * beyond the required 5 is optional in the schema, so each is read as
 * `undefined` rather than assumed present. */
export interface ShippingAddressFields {
  nombreCompleto?: string;
  telefono?: string;
  departamentoCode?: string;
  municipioName?: string;
  direccion?: string;
  complemento?: string;
  barrio?: string;
  notas?: string;
}

export function parseShippingAddress(value: unknown): ShippingAddressFields {
  if (typeof value !== 'object' || value === null) return {};
  const record = value as Record<string, unknown>;
  const str = (key: string): string | undefined => (typeof record[key] === 'string' ? (record[key] as string) : undefined);
  return {
    nombreCompleto: str('nombreCompleto'),
    telefono: str('telefono'),
    departamentoCode: str('departamentoCode'),
    municipioName: str('municipioName'),
    direccion: str('direccion'),
    complemento: str('complemento'),
    barrio: str('barrio'),
    notas: str('notas'),
  };
}

export interface OrderListParams {
  status?: OrderStatusFilter;
  page: number;
  pageSize: number;
}

/** Thin wrapper functions below: both `/pedidos` pages need the exact same
 * 6 endpoints, so centralizing the URL/method/body-shape here (rather than
 * repeating `apiFetch` calls inline like `productos/page.tsx` does for its
 * single call site) avoids duplicating that shape across the list and
 * detail pages. */
export function listOrders(params: OrderListParams): Promise<OrderListResponse> {
  const qs = new URLSearchParams();
  if (params.status) qs.set('status', params.status);
  qs.set('page', String(params.page));
  qs.set('pageSize', String(params.pageSize));
  return apiFetch<OrderListResponse>(`/v1/admin/orders?${qs.toString()}`);
}

export function getOrder(id: string): Promise<OrderDetail> {
  return apiFetch<OrderDetail>(`/v1/admin/orders/${id}`);
}

export function confirmOrder(id: string): Promise<OrderDetail> {
  return apiFetch<OrderDetail>(`/v1/admin/orders/${id}/confirm`, { method: 'PATCH' });
}

export function markPreparing(id: string): Promise<OrderDetail> {
  return apiFetch<OrderDetail>(`/v1/admin/orders/${id}/preparing`, { method: 'PATCH' });
}

export interface ShippedPayload {
  carrier: string;
  trackingNumber: string;
}

export function markShipped(id: string, body: ShippedPayload): Promise<OrderDetail> {
  return apiFetch<OrderDetail>(`/v1/admin/orders/${id}/shipped`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export function markDelivered(id: string): Promise<OrderDetail> {
  return apiFetch<OrderDetail>(`/v1/admin/orders/${id}/delivered`, { method: 'PATCH' });
}

export interface CancelPayload {
  reason: string;
}

export function cancelOrder(id: string, body: CancelPayload): Promise<OrderDetail> {
  return apiFetch<OrderDetail>(`/v1/admin/orders/${id}/cancel`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}
