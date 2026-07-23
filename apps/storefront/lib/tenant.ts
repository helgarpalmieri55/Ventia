export interface ResolvedTenant {
  tenantId: string;
  slug: string;
  name: string;
  status: 'draft' | 'live' | 'suspended';
}

export async function fetchTenantForHost(
  host: string | null,
  apiUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ResolvedTenant | null> {
  if (!host) return null;
  const res = await fetchImpl(`${apiUrl}/v1/tenant`, {
    headers: { Host: host },
    cache: 'no-store',
  });
  if (!res.ok) return null;
  return (await res.json()) as ResolvedTenant;
}
