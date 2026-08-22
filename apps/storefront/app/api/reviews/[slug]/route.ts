/** Same-origin proxy for the browser's `GET /api/reviews/:slug` calls to the
 * API's `GET /v1/storefront/products/:slug/reviews`
 * (services/api/src/reviews/storefront-reviews.controller.ts). It exists for
 * the first of the two reasons `app/api/cart/[[...path]]/route.ts` lists —
 * `API_INTERNAL_URL` is an internal-network hostname the browser cannot reach,
 * so this Route Handler (server-side, same origin as the browser) forwards to
 * it instead.
 *
 * Only the first reason. There is no cookie in either direction and none is
 * forwarded: published reviews are readable by someone who has never signed
 * in, which is the whole point of them — the person reading reviews is exactly
 * the person who has not bought anything yet. Sending the shopper's session
 * along would buy nothing and would widen what an upstream bug could act on.
 * That makes this the shape of `app/api/orders/track/route.ts` (a plain,
 * cookie-free GET forwarder) rather than the account proxy's.
 *
 * Why a browser call exists at all for a list the product page already renders
 * server-side: page 1 is in the HTML, and only page 2 onward comes from here —
 * see `components/review-pager.tsx`.
 *
 * `url.search` is forwarded verbatim rather than rebuilt from named params.
 * The API validates `page` and `pageSize` itself (400 for a nonsense page, a
 * hard cap on `pageSize`), and a second, partial copy of that validation here
 * would be a second thing to keep in step with it.
 *
 * ## The dot segments, and why NOT `isSafeProxyPath`
 *
 * `encodeURIComponent` closes the traversal that `lib/proxy-path.ts` was
 * written for, but not quite all of it. It escapes every character that could
 * introduce a segment boundary — `/`, `\`, `?`, `#` — so `../admin` becomes
 * the single harmless segment `..%2Fadmin`. What it leaves alone is a slug
 * that is EXACTLY `.` or `..`: those survive verbatim, and
 * `${API_URL}/v1/storefront/products/../reviews` is resolved by the WHATWG URL
 * parser as `/v1/storefront/reviews`. So the prefix that looks like it pins
 * this proxy to one endpoint would not pin it. Hence the check below.
 *
 * That check is deliberately NOT `isSafeProxyPath`, and the difference is the
 * data, not the danger. That helper guards segments this APP builds — endpoint
 * names and UUIDs — so restricting them to `[A-Za-z0-9._-]` refuses nothing
 * real. This segment is a product slug, which is merchant-controlled and only
 * `z.string().min(1).max(60)` in `catalog-schemas.ts`: `slugify()` yields
 * `[a-z0-9-]`, but a merchant who types their own slug may legitimately have
 * `café`. Borrowing the stricter rule here would 404 a real product's reviews
 * — the pager would answer "no pudimos cargar más" forever on that one
 * product — to prevent nothing that `encodeURIComponent` has not already
 * prevented. So this rejects exactly the two values that are actually
 * dangerous and escapes the rest.
 */

/** A slug that the URL parser would read as a directory hop rather than a
 * name. Everything else is made inert by `encodeURIComponent` below. */
function isDotSegment(slug: string): boolean {
  return slug === '.' || slug === '..';
}

const API_URL = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';

type RouteParams = { params: Promise<{ slug: string }> };

export async function GET(req: Request, { params }: RouteParams): Promise<Response> {
  const { slug } = await params;
  // Never forwarded: a dot segment is the one thing `encodeURIComponent`
  // cannot make inert. Bodyless 404, matching the four proxies beside this
  // one — and the right answer anyway, since no product is named `..`.
  if (isDotSegment(slug)) return new Response(null, { status: 404 });

  const host = req.headers.get('host') ?? '';
  const url = new URL(req.url);

  const upstreamRes = await fetch(
    `${API_URL}/v1/storefront/products/${encodeURIComponent(slug)}/reviews${url.search}`,
    {
      method: 'GET',
      // The tenant is resolved by host: this route is hit by the browser, so
      // its own Host header IS the store's subdomain (same as every other
      // proxy in this directory).
      headers: { 'x-tenant-domain': host },
      cache: 'no-store',
    },
  );

  const bodyText = await upstreamRes.text();
  return new Response(bodyText, {
    status: upstreamRes.status,
    headers: { 'content-type': upstreamRes.headers.get('content-type') ?? 'application/json' },
  });
}
