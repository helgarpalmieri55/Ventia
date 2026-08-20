import { cache } from 'react';

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
  /** Whether to offer the AI chat widget at all — true only when this store's
   * plan includes AI messages. A display hint, not the enforcement: the hard
   * cap lives server-side in `AgentBudgetService`. Absent on an older API,
   * which the widget treats as "off". */
  agentEnabled?: boolean;
  /** The agent's display name, from the merchant's agent config. Falls back to
   * the widget's own default when unset. */
  agentName?: string;
}

// Wrapped in React's cache() so a layout and a page rendering the same
// request (e.g. app/layout.tsx + app/page.tsx, both calling this with the
// same host/apiUrl and the default fetchImpl) share one in-flight call
// instead of issuing two round trips to /v1/tenant per page view. Scoped to
// the lifetime of a single render pass — safe across requests/tests since
// each gets its own cache instance.
export const fetchTenantForHost = cache(async function fetchTenantForHost(
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
});
