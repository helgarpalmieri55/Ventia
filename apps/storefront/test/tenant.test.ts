import { describe, expect, it, vi } from 'vitest';
import { fetchTenantForHost } from '../lib/tenant';

describe('fetchTenantForHost', () => {
  it('returns tenant on 200', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ tenantId: 't', slug: 'demo', name: 'Demo', status: 'live' }), { status: 200 }),
    );
    const t = await fetchTenantForHost('demo.ventia.localhost', 'http://api', fetchImpl);
    expect(t?.name).toBe('Demo');
    expect(fetchImpl).toHaveBeenCalledWith('http://api/v1/tenant', {
      headers: { 'x-tenant-domain': 'demo.ventia.localhost' },
      cache: 'no-store',
    });
  });

  it('returns null on 404 or null host', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{}', { status: 404 }));
    expect(await fetchTenantForHost('x.local', 'http://api', fetchImpl)).toBeNull();
    expect(await fetchTenantForHost(null, 'http://api', fetchImpl)).toBeNull();
  });
});
