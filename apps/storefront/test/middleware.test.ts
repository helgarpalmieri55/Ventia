import { describe, expect, it, vi, afterEach } from 'vitest';
import { middleware } from '../middleware';
import { NextRequest } from 'next/server';

/**
 * Cross-phase regression (final P2 review): `GET /v1/tenant` used to answer
 * a suspended tenant with a plain 200 body (`{status: 'suspended', ...}`),
 * which this middleware alone knew to translate into a real 503 — the API
 * itself only started returning a genuine 503 for `suspended` after this
 * review's fix to tenant.controller.ts. This test pins the middleware's half
 * of that fix: it must key off the upstream 503 status code directly, not a
 * 200-body `status` field (which the API no longer sends this way at all).
 */
describe('storefront middleware', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns a real 503 page when the API answers /v1/tenant with 503', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('{"error":"TENANT_SUSPENDED"}', { status: 503 })),
    );
    const req = new NextRequest('http://suspended.ventia.localhost/', {
      headers: { host: 'suspended.ventia.localhost' },
    });
    const res = await middleware(req);
    expect(res.status).toBe(503);
    const body = await res.text();
    expect(body).toContain('no disponible');
  });

  it('falls through (next()) for a live tenant (200)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ tenantId: 't', slug: 'demo', name: 'Demo', status: 'live' }), {
          status: 200,
        }),
      ),
    );
    const req = new NextRequest('http://demo.ventia.localhost/', {
      headers: { host: 'demo.ventia.localhost' },
    });
    const res = await middleware(req);
    // NextResponse.next() carries this internal marker header rather than a
    // distinguishing status code (it's always 200) — this is the standard
    // way to assert "the middleware let the request through" in Next.js.
    expect(res.headers.get('x-middleware-next')).toBe('1');
  });

  it('falls through (next()) for an unresolved host (404)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 404 })));
    const req = new NextRequest('http://unknown.ventia.localhost/', {
      headers: { host: 'unknown.ventia.localhost' },
    });
    const res = await middleware(req);
    expect(res.headers.get('x-middleware-next')).toBe('1');
  });
});
