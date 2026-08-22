/** Catch-all Route Handler proxying the browser's `/api/checkout/*` calls to
 * the API's `/v1/storefront/checkout/*` endpoints
 * (services/api/src/checkout/checkout.controller.ts). A small, deliberate
 * COPY of `app/api/cart/[[...path]]/route.ts`'s `proxy()` function with a
 * different upstream base path, rather than a shared abstraction between the
 * two — this is the established convention in this codebase for small
 * per-module logic (see e.g. `TAX_RATE_FROM_DB`/`TAX_RATE_TO_DB` duplicated
 * across cart.service.ts, checkout.service.ts, storefront/products.service.ts
 * and csv-import.service.ts rather than shared). Factoring a ~40-line
 * function out into a shared helper isn't worth touching Task 7's
 * already-reviewed, working cart proxy for.
 *
 * Same two reasons this proxy exists at all (see the cart proxy's doc comment
 * for the full version): `API_INTERNAL_URL` is unreachable from the browser,
 * and cookies need to round-trip through the storefront's own origin. Even
 * though `POST /v1/storefront/checkout` doesn't itself SET the
 * `ventia_cart` cookie (it clears it on success), the incoming cookie must
 * still be forwarded upstream — `CartCookieGuard` on the checkout controller
 * needs it to resolve which guest's cart to check out.
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

  // `path` is `undefined`/empty for the bare `POST /api/checkout` case (the
  // checkout submit itself) — this must resolve to the API's exact
  // `/v1/storefront/checkout` (no trailing slash), matching `@Post()`'s bare
  // controller route. The non-empty cases are `/api/checkout/shipping-quote`
  // (`GET`), `/api/checkout/confirmacion/:orderNumber` (`GET`) and
  // `/api/checkout/:orderNumber/provider-ref-hint` (`PATCH`, P3c Task 2).
  const suffix = path && path.length > 0 ? `/${path.join('/')}` : '';
  const upstreamRes = await fetch(`${API_URL}/v1/storefront/checkout${suffix}${url.search}`, {
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

  // See the cart proxy's doc comment for why `getSetCookie()` is used over
  // `.get('set-cookie')` — same reasoning applies here even though this
  // route's only current Set-Cookie is `res.clearCookie(...)`'s own
  // Set-Cookie-with-expiry on successful checkout, not a fresh cookie value.
  const setCookies = upstreamRes.headers.getSetCookie?.() ?? [];
  for (const cookieHeader of setCookies) {
    res.headers.append('set-cookie', cookieHeader);
  }

  return res;
}

// `[[...path]]` (OPTIONAL catch-all): `POST /api/checkout` itself (the bare
// checkout submit, no extra segments) must match this route too, alongside
// `/api/checkout/shipping-quote`.
type RouteParams = { params: Promise<{ path?: string[] }> };

export async function GET(req: Request, { params }: RouteParams): Promise<Response> {
  return proxy(req, (await params).path);
}

export async function POST(req: Request, { params }: RouteParams): Promise<Response> {
  return proxy(req, (await params).path);
}

// Added for P3c Task 2's provider-ref-hint endpoint
// (`PATCH /api/checkout/:orderNumber/provider-ref-hint`). The cart proxy
// already exported PATCH; `proxy()` above already handled the method and its
// body generically (`hasBody` covers POST and PATCH), so this is purely the
// missing export, not new forwarding logic.
export async function PATCH(req: Request, { params }: RouteParams): Promise<Response> {
  return proxy(req, (await params).path);
}
