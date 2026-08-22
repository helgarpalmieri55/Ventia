/**
 * Whether a catch-all route's path segments are safe to append to an upstream
 * URL.
 *
 * ## The hole this closes
 *
 * The four `/api/*` Route Handlers each build their upstream URL by joining
 * `params.path` onto a fixed prefix:
 *
 *     fetch(`${API_URL}/v1/storefront/account/${path.join('/')}`)
 *
 * `fetch` parses that with the WHATWG URL parser, which resolves `..` the way
 * a relative path resolves. So a `params.path` of
 * `['..', '..', '..', 'v1', 'admin', 'tenants']` does not request a weirdly
 * named account endpoint — it requests `/v1/admin/tenants`, with the browser's
 * cookies attached and an `x-tenant-domain` the caller chose. The prefix that
 * looks like it confines the proxy to one module confines nothing.
 *
 * Next normalizes literal `..` out of a URL before routing, so this is not
 * reachable through a plain `/api/account/../../../v1/admin` today. That is a
 * property of the router's current normalization of percent-encoded segments,
 * not of anything in this codebase, and it is re-decided on every framework
 * upgrade by people who are not thinking about this file. The check below does
 * not depend on it.
 *
 * ## The rule
 *
 * Every real segment across these four proxies is an endpoint name
 * (`magic-link`, `password-reset`, `consume`, `me`, `orders`, `quote`) or a
 * UUID. So: one or more of letter, digit, `.`, `_`, `-`, and never `.` or `..`
 * standing alone. Anything else is not a request this app makes, and the
 * handlers answer 404 rather than passing it upstream.
 *
 * ## Why this one is shared when the forwarders are not
 *
 * Those four `proxy()` functions are deliberate copies — see the comment at
 * the top of `app/api/cart/[[...path]]/route.ts`. That decision is about
 * per-module plumbing that drifts on purpose. This is a security check, where
 * four copies means four places for one to be quietly weakened and three to
 * look fine.
 */
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

export function isSafeProxyPath(path: string[] | undefined): boolean {
  if (path === undefined) return true;
  return path.every((segment) => SAFE_SEGMENT.test(segment) && segment !== '.' && segment !== '..');
}
