/** Catch-all Route Handler proxying the browser's `/api/cart/*` calls to the
 * API's `/v1/storefront/cart/*` endpoints (services/api/src/checkout/cart.controller.ts).
 *
 * Why this proxy exists (rather than the browser calling the API directly,
 * the way lib/storefront-api.ts's Server Component fetches call
 * `API_INTERNAL_URL`): two separate problems, both solved by routing through
 * this same-origin Route Handler instead —
 *
 * 1. `API_INTERNAL_URL` is an internal-network hostname (e.g.
 *    `http://host.docker.internal:4000` in dev, a private service hostname in
 *    prod) that only the API's own network/host can reach. A Server
 *    Component's fetch runs on the server, inside that network — a browser
 *    fetch from the shopper's machine cannot reach it at all.
 * 2. Even if the browser could reach the API directly (e.g. via its public
 *    `api.ventia.localhost` domain), a `Set-Cookie` from that cross-origin
 *    response would be scoped to `api.ventia.localhost` — never sent back on
 *    later requests from the storefront's own origin
 *    (`{tenant}.ventia.localhost`), where `CartCookieGuard` needs to read it.
 *    Routing both the write and every later read through this Route Handler
 *    (same origin as the browser) means the `ventia_cart` cookie set here
 *    lands on — and is read back from — the storefront's own origin.
 *
 * Tenant resolution: the incoming request's `Host` header IS the tenant's
 * own subdomain here (this route is hit by the browser, not by another
 * server), so it's forwarded verbatim as `x-tenant-domain` — no separate
 * tenant lookup needed (matching PublicTenantGuard's `x-tenant-domain`
 * expectation, same header lib/storefront-api.ts's Server Component fetches
 * already use, just sourced from the browser's Host instead of a
 * server-resolved one).
 */

import { isSafeProxyPath } from '../../../../lib/proxy-path';

const API_URL = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';

async function proxy(req: Request, path: string[] | undefined): Promise<Response> {
  // A path that is not one this app builds never reaches the API. See
  // `lib/proxy-path.ts`: `fetch` resolves `..` in the joined URL, so without
  // this the fixed prefix above confines the proxy to nothing.
  if (!isSafeProxyPath(path)) return new Response(null, { status: 404 });
  const host = req.headers.get('host') ?? '';
  const cookie = req.headers.get('cookie');
  const url = new URL(req.url);

  const upstreamHeaders: Record<string, string> = { 'x-tenant-domain': host };
  if (cookie) upstreamHeaders.cookie = cookie;

  const hasBody = req.method === 'POST' || req.method === 'PATCH';
  if (hasBody) upstreamHeaders['content-type'] = 'application/json';

  // `path` is `undefined`/empty for the bare `GET /api/cart` case (the
  // optional catch-all `[[...path]]` matches zero segments there) — this
  // must resolve to the API's exact `/v1/storefront/cart` (no trailing
  // slash appended), matching `@Get()`'s bare controller route.
  const suffix = path && path.length > 0 ? `/${path.join('/')}` : '';
  const upstreamRes = await fetch(`${API_URL}/v1/storefront/cart${suffix}${url.search}`, {
    method: req.method,
    headers: upstreamHeaders,
    body: hasBody ? await req.text() : undefined,
    cache: 'no-store',
  });

  const bodyText = await upstreamRes.text();
  const res = new Response(bodyText, {
    status: upstreamRes.status,
    headers: { 'content-type': upstreamRes.headers.get('content-type') ?? 'application/json' },
  });

  // `Headers.get('set-cookie')` collapses multiple Set-Cookie headers into
  // one comma-joined string in some fetch implementations, which is not
  // generally parseable back apart (cookie values/attributes can themselves
  // contain commas). `getSetCookie()` (Node 18.14+/undici) returns the
  // original headers as a proper string array instead — used here rather
  // than `.get('set-cookie')`, with each one re-appended individually so a
  // multi-cookie response would round-trip correctly too (this route only
  // ever emits one — the `ventia_cart` cookie on cart creation — but this
  // doesn't assume that).
  const setCookies = upstreamRes.headers.getSetCookie?.() ?? [];
  for (const cookieHeader of setCookies) {
    res.headers.append('set-cookie', cookieHeader);
  }

  return res;
}

// `[[...path]]` (OPTIONAL catch-all): `GET /api/cart` itself (no extra
// segments, for the bare cart read) must match this route too, alongside
// `/api/cart/items`, `/api/cart/items/:id`, etc. — a non-optional
// `[...path]` requires at least one segment and would 404 the bare read.
type RouteParams = { params: Promise<{ path?: string[] }> };

export async function GET(req: Request, { params }: RouteParams): Promise<Response> {
  return proxy(req, (await params).path);
}

export async function POST(req: Request, { params }: RouteParams): Promise<Response> {
  return proxy(req, (await params).path);
}

export async function PATCH(req: Request, { params }: RouteParams): Promise<Response> {
  return proxy(req, (await params).path);
}

export async function DELETE(req: Request, { params }: RouteParams): Promise<Response> {
  return proxy(req, (await params).path);
}
