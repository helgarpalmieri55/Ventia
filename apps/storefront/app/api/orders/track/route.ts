/** Same-origin proxy for the browser's `GET /api/orders/track` calls to the
 * API's `GET /v1/storefront/orders/track` (see
 * services/api/src/checkout/order-tracking.controller.ts). Same two reasons
 * this indirection exists as `app/api/cart/[[...path]]/route.ts` (see that
 * file's doc comment for the full explanation) — `API_INTERNAL_URL` is an
 * internal-network hostname the browser can't reach, so this Route Handler
 * (running server-side, same-origin as the browser) forwards to it instead.
 *
 * Simpler than the cart proxy in one respect: this endpoint is a stateless,
 * cookie-free, per-request GET lookup (order number + contact, no session),
 * so there's no `Set-Cookie`/`cookie` forwarding to do at all. Still a plain
 * (non catch-all) route file, per the task brief — there's only the one path
 * this ever proxies to (`/v1/storefront/orders/track`), unlike the cart
 * proxy's `/items`, `/items/:id`, etc.
 */

const API_URL = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';

export async function GET(req: Request): Promise<Response> {
  const host = req.headers.get('host') ?? '';
  const url = new URL(req.url);

  const upstreamRes = await fetch(`${API_URL}/v1/storefront/orders/track${url.search}`, {
    method: 'GET',
    headers: { 'x-tenant-domain': host },
    cache: 'no-store',
  });

  const bodyText = await upstreamRes.text();
  return new Response(bodyText, {
    status: upstreamRes.status,
    headers: { 'content-type': upstreamRes.headers.get('content-type') ?? 'application/json' },
  });
}
