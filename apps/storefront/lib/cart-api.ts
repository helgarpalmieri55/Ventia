/** Client-side typed cart client, called from the browser (unlike
 * `storefront-api.ts`'s `fetchStorefront`/`fetchStorefrontOrNull`, which run
 * inside Server Components on the API's own network).
 *
 * Deviation from the task brief's illustrative signatures
 * (`fetchCart(apiUrl, tenantHost)` etc.): those params make sense for a
 * SERVER-side caller reaching `API_INTERNAL_URL` directly with an explicit
 * `x-tenant-domain` header, the way `fetchStorefront` does. This module runs
 * in the browser instead, where neither param is meaningful —
 * `API_INTERNAL_URL` is an internal-network hostname the browser can't reach
 * at all, and the tenant host is simply whatever origin the browser is
 * already on (no need to pass it explicitly). Every call here goes through
 * the same-origin `/api/cart/...` Route Handler proxy
 * (`app/api/cart/[[...path]]/route.ts`), which reads the tenant off the
 * incoming request's own `Host` header server-side and forwards to the API —
 * see that file's doc comment for the full reasoning (also: a cross-origin
 * `Set-Cookie` from the API's own domain wouldn't be readable back from the
 * storefront's origin, which is the other reason this indirection exists).
 * So the signatures below drop `apiUrl`/`tenantHost` entirely in favor of a
 * fixed same-origin path, matching what the browser actually needs.
 *
 * `fetchImpl` is still threaded through (default `fetch`), mirroring
 * `fetchStorefront`'s/`fetchTenantForHost`'s injectable-fetch convention, so
 * `cart-api.test.ts` can assert on call shape without a real network.
 */

export interface CartLine {
  id: string;
  productId: string;
  variantId: string | null;
  qty: number;
  name: string;
  priceCents: number;
  lineSubtotalCents: number;
  lineTaxCents: number;
}

export interface Cart {
  lines: CartLine[];
  subtotalCents: number;
  taxCents: number;
}

/** Thrown for any non-2xx response from the `/api/cart/...` proxy. Kept
 * deliberately plain (status + raw body text) — this is a small client-side
 * surface, not the admin app's full error-code-mapping `lib/errors.ts`. */
export class CartApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`cart api error ${status}: ${body}`);
  }
}

async function request(
  path: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
): Promise<Cart> {
  const res = await fetchImpl(`/api/cart${path}`, {
    ...init,
    // Always needed: the cart is identified by the `ventia_cart` cookie the
    // proxy route forwards both ways, and a same-origin fetch still needs
    // this explicitly to send/receive cookies from `fetch` (unlike a plain
    // browser navigation).
    credentials: 'include',
  });
  const text = await res.text();
  if (!res.ok) throw new CartApiError(res.status, text);
  return JSON.parse(text) as Cart;
}

export async function fetchCart(fetchImpl: typeof fetch = fetch): Promise<Cart> {
  return request('', { method: 'GET' }, fetchImpl);
}

export async function addCartItem(
  productId: string,
  variantId: string | null,
  qty: number,
  fetchImpl: typeof fetch = fetch,
): Promise<Cart> {
  return request(
    '/items',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ productId, variantId, qty }),
    },
    fetchImpl,
  );
}

export async function updateCartItem(
  itemId: string,
  qty: number,
  fetchImpl: typeof fetch = fetch,
): Promise<Cart> {
  return request(
    `/items/${encodeURIComponent(itemId)}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ qty }),
    },
    fetchImpl,
  );
}

export async function removeCartItem(itemId: string, fetchImpl: typeof fetch = fetch): Promise<Cart> {
  return request(`/items/${encodeURIComponent(itemId)}`, { method: 'DELETE' }, fetchImpl);
}
