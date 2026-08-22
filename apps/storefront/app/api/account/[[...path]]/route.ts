/** Catch-all Route Handler proxying the browser's `/api/account/*` calls to
 * the API's `/v1/storefront/account/*` endpoints
 * (services/api/src/shopper/shopper.controller.ts). Deliberately the same
 * small COPY of `app/api/cart/[[...path]]/route.ts`'s `proxy()` that
 * `app/api/checkout/[[...path]]/route.ts` already is — see that file for why
 * this codebase duplicates a ~40-line forwarder per module instead of
 * factoring one out.
 *
 * The cookie round-trip matters MORE here than on either of those routes,
 * and it is the whole reason this file exists rather than the browser
 * calling the API's public domain directly. `ventia_shopper` is HttpOnly and
 * is set by the API; a `Set-Cookie` from a cross-origin response would be
 * scoped to the API's own domain and would never be sent back on a later
 * request from `{tienda}.ventia.localhost`. The shopper would appear to sign
 * in successfully and then be signed out on the very next page — the exact
 * failure this indirection prevents.
 *
 * Both directions are forwarded because every sign-in path here sets TWO
 * cookies at once (`ventia_shopper` AND a re-pointed `ventia_cart`, since
 * `establish()` merges the guest basket into the account's — see the
 * controller's doc comment). That is why the `getSetCookie()` loop below is
 * not theoretical here the way it is on the cart route: this route really
 * does emit two Set-Cookie headers on one response, and collapsing them into
 * one comma-joined string would lose the shopper their cart, their session,
 * or both.
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

  const suffix = path && path.length > 0 ? `/${path.join('/')}` : '';
  const upstreamRes = await fetch(`${API_URL}/v1/storefront/account${suffix}${url.search}`, {
    method: req.method,
    headers: upstreamHeaders,
    body: hasBody ? await req.text() : undefined,
    cache: 'no-store',
  });

  const bodyText = await upstreamRes.text();
  // 204 (sign-out) must stay bodyless: `new Response('', {status: 204})` is a
  // TypeError in undici, and a 204 carrying a body is malformed anyway.
  const res = new Response(upstreamRes.status === 204 ? null : bodyText, {
    status: upstreamRes.status,
    headers: { 'content-type': upstreamRes.headers.get('content-type') ?? 'application/json' },
  });

  const setCookies = upstreamRes.headers.getSetCookie?.() ?? [];
  for (const cookieHeader of setCookies) {
    res.headers.append('set-cookie', cookieHeader);
  }

  return res;
}

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

/** Needed by `DELETE /addresses/:id` and `DELETE /wishlist/:productId`. A
 * Route Handler only accepts the methods it exports, so without this the
 * browser gets a 405 from Next itself and the request never reaches the API
 * — which is exactly what happened before the account area had screens: the
 * endpoints existed and were tested, and nothing in this app had yet tried
 * to delete anything through the proxy.
 *
 * `hasBody` above is false for DELETE, matching the API: both delete routes
 * take their id from the path and answer 204 with no body, which `proxy()`
 * already handles.
 */
export async function DELETE(req: Request, { params }: RouteParams): Promise<Response> {
  return proxy(req, (await params).path);
}
