/** Thrown by {@link fetchStorefront} for any non-2xx, non-404 response (e.g.
 * 503 for a suspended tenant) — the calling page decides how to render that,
 * distinct from a 404 (which resolves to `null`, meaning "doesn't exist"). */
export class StorefrontApiError extends Error {
  constructor(public readonly status: number) {
    super(`storefront api error ${status}`);
  }
}

/** Fetches a public `/v1/storefront/*` (or `/v1/tenant`) path from the API,
 * scoped to `tenantHost` via the same `x-tenant-domain` header
 * `lib/tenant.ts#fetchTenantForHost` already uses (Node's fetch/undici
 * ignores a caller-set Host header, so the tenant subdomain has to travel as
 * an explicit header instead). Returns `null` on 404 (content genuinely
 * doesn't exist — e.g. a policy page the merchant hasn't written), and
 * throws {@link StorefrontApiError} for any other non-2xx status so the
 * caller can distinguish "not found" from "temporarily broken". Always
 * `cache: 'no-store'`: page-level revalidation/ISR tagging (wired in later
 * tasks) is the caching layer, not this client. */
export async function fetchStorefront<T>(
  tenantHost: string,
  path: string,
  fetchImpl: typeof fetch = fetch,
): Promise<T | null> {
  const apiUrl = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';
  const res = await fetchImpl(`${apiUrl}${path}`, {
    headers: { 'x-tenant-domain': tenantHost },
    cache: 'no-store',
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new StorefrontApiError(res.status);
  return (await res.json()) as T;
}
