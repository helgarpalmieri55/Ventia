export interface ResolvedTenant {
  tenantId: string;
  slug: string;
  name: string;
  status: 'draft' | 'live' | 'suspended';
  // Whatever `GET /v1/tenant` returns for the tenant's saved theme JSON (see
  // `services/api/src/tenants/tenant.controller.ts`) — `null` for a draft
  // tenant that hasn't saved branding yet. Left as `unknown` rather than
  // `TenantTheme | null` (lib/theme.ts) so this module stays independent of
  // theme.ts; callers narrow it themselves, e.g.
  // `buildThemeVars(tenant?.theme as TenantTheme | null ?? null)` in
  // app/layout.tsx.
  theme: unknown;
}

export async function fetchTenantForHost(
  host: string | null,
  apiUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ResolvedTenant | null> {
  if (!host) return null;
  const res = await fetchImpl(`${apiUrl}/v1/tenant`, {
    // Node's fetch (undici) ignores a caller-set Host header, so the tenant
    // subdomain is forwarded via this internal header instead; the API
    // middleware prefers it and falls back to Host for direct requests.
    headers: { 'x-tenant-domain': host },
    cache: 'no-store',
  });
  if (!res.ok) return null;
  return (await res.json()) as ResolvedTenant;
}
