/** Client-side typed client for the public order-tracking lookup, mirroring
 * `cart-api.ts`'s browser-side/`fetchImpl`-injectable style (see that file's
 * doc comment for the full reasoning on why this goes through a same-origin
 * proxy rather than calling `API_INTERNAL_URL` directly — the browser can't
 * reach that internal hostname at all). Unlike `cart-api.ts`, there's no
 * cookie concern here: `GET /v1/storefront/orders/track` is a stateless,
 * per-request lookup keyed by `orderNumber` + `contact` in the query string,
 * not a session/cookie-scoped resource — so `credentials: 'include'` isn't
 * needed and there's nothing to forward both ways.
 *
 * Mirrors `OrderTrackingDto`
 * (services/api/src/checkout/order-tracking.controller.ts) — kept as a local
 * copy, same as `OrderConfirmationDto` in the confirmation page (no shared
 * package between the API and this app).
 */

export type OrderStatus = 'PENDING' | 'CONFIRMED' | 'PREPARING' | 'SHIPPED' | 'DELIVERED' | 'CANCELLED';

export interface OrderTracking {
  orderNumber: number;
  status: OrderStatus;
  createdAt: string;
  items: Array<{ nameSnapshot: string; qty: number; priceCentsSnapshot: number }>;
  totalCents: number;
  shippingCiudad: string;
  shippingDepartamento: string;
  shipment: { carrier: string; trackingNumber: string } | null;
  events: Array<{ type: string; createdAt: string }>;
}

/** Thrown for any non-2xx response from the `/api/orders/track` proxy. Same
 * plain "status + raw body text" shape as `CartApiError` — status is kept
 * even though the page above only renders a single generic "not found"
 * message for every non-2xx case (matching the backend's deliberate
 * identical-404-for-wrong-contact-vs-nonexistent posture — see
 * order-tracking.controller.ts), so a future caller (or a test) can still
 * branch on it if needed. */
export class TrackingApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`tracking api error ${status}: ${body}`);
  }
}

export async function trackOrder(
  orderNumber: string,
  contact: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OrderTracking> {
  const res = await fetchImpl(
    `/api/orders/track?orderNumber=${encodeURIComponent(orderNumber)}&contact=${encodeURIComponent(contact)}`,
    { method: 'GET' },
  );
  const text = await res.text();
  if (!res.ok) throw new TrackingApiError(res.status, text);
  return JSON.parse(text) as OrderTracking;
}
