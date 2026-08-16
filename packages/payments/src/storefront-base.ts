/** Shared VALIDATION of the per-tenant storefront base URL that the two
 * adapters with a first-party browser return route — `wompi.ts` (its
 * `/pago/wompi-retorno/{orderNumber}` return-capture page) and `epayco.ts`
 * (its `/pago/epayco` widget bridge page and `/pago/epayco-retorno/{orderNumber}`
 * response page) — build their redirect URLs on top of.
 *
 * ## What changed here, and why the old warning is gone rather than reworded
 *
 * This module used to RESOLVE that base URL, from one global env var
 * (`PAYMENTS_STOREFRONT_BASE_URL`, defaulting to `http://localhost:3000`),
 * under a long doc comment stating that doing so was "a real, load-bearing,
 * multi-tenant-wrong limitation": with two or more tenants on Wompi or
 * ePayco, every tenant's shopper was redirected to whichever single
 * storefront that one variable named.
 *
 * That is fixed, so the warning is deleted rather than softened — it would
 * now be a stale description of a problem that no longer exists.
 * `OrderForPayment.storefrontBaseUrl` (packages/payments/src/index.ts) carries
 * the REAL, per-tenant public base URL of the storefront the order was placed
 * on, resolved per HTTP request in
 * `services/api/src/checkout/checkout.service.ts` from the tenant domain that
 * `services/api/src/tenants/domain-resolver.ts` already matched against the
 * `TenantDomain` table for that request. Two tenants therefore get two
 * different redirect bases, by construction.
 *
 * ## Why `PAYMENTS_STOREFRONT_BASE_URL` was removed outright, with no
 * ## dev/local fallback left behind
 *
 * A "dev only" fallback would have kept exactly the property that made the
 * original bug invisible: a call site that fails to supply a per-tenant value
 * silently gets a plausible-looking global one, and nothing anywhere reports
 * that the redirect is wrong. It would also mean the dev loop exercises a
 * DIFFERENT code path from production — which is how a redirect nobody
 * noticed shipped in the first place.
 *
 * It is also unnecessary. Dev resolves per-tenant domains through the very
 * same machinery production does: Caddy serves `http://*.ventia.localhost`
 * (docker/Caddyfile), the seeded tenants own real `TenantDomain` rows
 * (`demo-moda.ventia.localhost`, `demo-tech.ventia.localhost`), and the
 * storefront's `/api/checkout/*` proxy forwards its own `Host` as
 * `x-tenant-domain`. A request that resolves no tenant never reaches checkout
 * at all (`PublicTenantGuard` 404s first), so there is no real code path where
 * a base URL is genuinely unavailable — only call sites that forgot, which is
 * precisely what should fail loudly.
 *
 * The env var is correspondingly gone from `.env.example`. A leftover value in
 * someone's local `.env` is now simply ignored — nothing reads it.
 */

/** Validates a caller-supplied storefront base URL and returns it normalized
 * (no trailing slash), or THROWS.
 *
 * Throwing rather than degrading is the whole point: every failure mode here
 * — an empty string, a relative path, a `javascript:` URL, a base with a query
 * string that would swallow the gateway's appended `?id=`/`?ref_payco=` — ends
 * with a shopper sent somewhere wrong. `createCheckoutSession` failing loudly
 * is recoverable (the API returns an error and no shopper is redirected
 * anywhere); a quietly malformed redirect is not.
 *
 * Rules, and why each one:
 *  - **Non-empty string.** Guards the one case TypeScript cannot: a value read
 *    from JSON/`process.env`/a stale Redis cache that typed as `string` but is
 *    `''` or `undefined` at runtime.
 *  - **Parses as an absolute URL with an `http:`/`https:` scheme.** Rejects
 *    relative paths (`/pago`), scheme-relative (`//evil.example`), and every
 *    non-navigational scheme (`javascript:`, `data:`, `file:`).
 *  - **No query string and no fragment.** Both adapters append a PATH to this
 *    value, and both gateways then append their own query param to the result;
 *    a base carrying `?`/`#` produces a URL where the order number lands
 *    inside a query value (the exact ambiguity `wompi.ts`'s path-segment shape
 *    exists to avoid).
 *  - **No userinfo (`user:pass@`).** Never legitimate for a storefront origin
 *    and a classic URL-spoofing shape.
 *
 * A path IS allowed (e.g. a storefront mounted under `https://x.example/co`),
 * since that is a real deployment shape and appending to it is unambiguous.
 * The trailing slash is stripped so callers can concatenate `/pago/...`
 * without producing a double slash.
 *
 * `provider` only shapes the error message, so a thrown error names which
 * adapter rejected the value.
 */
export function requireStorefrontBaseUrl(value: string | undefined | null, provider: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(
      `${provider}: OrderForPayment.storefrontBaseUrl is required — it must be the tenant's own public storefront base URL (e.g. https://tienda.example.com)`,
    );
  }
  const raw = value.trim();

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(
      `${provider}: OrderForPayment.storefrontBaseUrl must be an absolute http(s) URL, got ${JSON.stringify(raw)}`,
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `${provider}: OrderForPayment.storefrontBaseUrl must use http: or https:, got ${JSON.stringify(parsed.protocol)}`,
    );
  }
  if (parsed.search.length > 0 || parsed.hash.length > 0) {
    throw new Error(
      `${provider}: OrderForPayment.storefrontBaseUrl must not carry a query string or fragment, got ${JSON.stringify(raw)}`,
    );
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw new Error(
      `${provider}: OrderForPayment.storefrontBaseUrl must not carry userinfo credentials`,
    );
  }

  // `URL` normalizes a bare origin's pathname to `'/'`; strip that (and any
  // real trailing slash) so callers concatenate `/pago/...` cleanly.
  const normalized = `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '');
  return normalized;
}
