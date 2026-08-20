/** Catch-all Route Handler proxying the browser's `/api/agent/*` calls to the
 * API's `/v1/storefront/agent/*` endpoints (services/api/src/agent/agent.controller.ts).
 *
 * Same two reasons this indirection exists for the cart proxy next door
 * (`app/api/cart/[[...path]]/route.ts` — see its comment for the full
 * argument): `API_INTERNAL_URL` is an internal-network hostname the browser
 * cannot reach, and the tenant is resolved from the incoming request's own
 * `Host` header, which IS the tenant's subdomain when the browser is the
 * caller.
 *
 * ## The one real difference: this proxy must not buffer
 *
 * The cart proxy reads the whole upstream body with `await res.text()` before
 * answering, which is correct for a JSON endpoint and fatal for this one — it
 * would hold every SSE event until the turn finished, turning a stream into a
 * slow single response and defeating the point of streaming at all. The
 * upstream `body` (a `ReadableStream`) is therefore passed straight through,
 * and `Cache-Control`/`X-Accel-Buffering` are carried over so nothing between
 * here and the shopper re-buffers what this deliberately does not.
 */

const API_URL = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';

type RouteParams = { params: Promise<{ path?: string[] }> };

export async function POST(req: Request, { params }: RouteParams): Promise<Response> {
  const host = req.headers.get('host') ?? '';
  const cookie = req.headers.get('cookie');
  const path = (await params).path;

  const upstreamHeaders: Record<string, string> = {
    'x-tenant-domain': host,
    'content-type': 'application/json',
  };
  // Forwarded because SPEC §7 ties the web widget's session to the cart
  // cookie: the agent's tools run for a shopper who may already have a cart.
  if (cookie) upstreamHeaders.cookie = cookie;

  const suffix = path && path.length > 0 ? `/${path.join('/')}` : '';
  const upstream = await fetch(`${API_URL}/v1/storefront/agent${suffix}`, {
    method: 'POST',
    headers: upstreamHeaders,
    body: await req.text(),
    cache: 'no-store',
    // Node's fetch requires this whenever a streaming response might be
    // consumed incrementally rather than buffered.
    // @ts-expect-error -- `duplex` is valid in undici but missing from the DOM RequestInit type
    duplex: 'half',
  });

  const headers = new Headers({
    'content-type': upstream.headers.get('content-type') ?? 'application/json',
    'cache-control': upstream.headers.get('cache-control') ?? 'no-store',
  });
  const accelBuffering = upstream.headers.get('x-accel-buffering');
  if (accelBuffering) headers.set('x-accel-buffering', accelBuffering);

  // `upstream.body` rather than the buffered text — see the comment above.
  // It is `null` only for a body-less response, which this endpoint does not
  // produce, but the fallback keeps a surprising upstream from throwing here.
  return new Response(upstream.body, { status: upstream.status, headers });
}
