import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The `/api/account/*` proxy is where the shopper's HttpOnly session cookie
 * actually round-trips, so it gets tested directly (same approach as
 * `revalidate-route.test.ts`: import the handler, stub global `fetch`).
 *
 * `API_INTERNAL_URL` is read at module scope, so the module is imported
 * dynamically AFTER the env var is set.
 */
const API_URL = 'http://api.internal:4000';

async function loadRoute() {
  process.env.API_INTERNAL_URL = API_URL;
  vi.resetModules();
  return import('../app/api/account/[[...path]]/route');
}

let upstream: ReturnType<typeof vi.fn>;

beforeEach(() => {
  upstream = vi.fn();
  vi.stubGlobal('fetch', upstream);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('POST /api/account/*', () => {
  it('forwards the path, the body and the browser Host as x-tenant-domain', async () => {
    upstream.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 202 }));
    const { POST } = await loadRoute();

    const req = new Request('http://tienda.ventia.localhost/api/account/magic-link', {
      method: 'POST',
      headers: { host: 'tienda.ventia.localhost', cookie: 'ventia_cart=cart-1' },
      body: JSON.stringify({ email: 'ana@example.com' }),
    });
    const res = await POST(req, { params: Promise.resolve({ path: ['magic-link'] }) });

    expect(res.status).toBe(202);
    const [url, init] = upstream.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${API_URL}/v1/storefront/account/magic-link`);
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ email: 'ana@example.com' }));
    // The tenant is resolved by host: this route is hit by the browser, so
    // its own Host header IS the store's subdomain.
    expect((init.headers as Record<string, string>)['x-tenant-domain']).toBe('tienda.ventia.localhost');
    // The guest cart cookie has to reach the API or the sign-in merge has
    // nothing to merge.
    expect((init.headers as Record<string, string>).cookie).toBe('ventia_cart=cart-1');
  });

  it('joins a nested path (magic-link/consume) rather than dropping a segment', async () => {
    upstream.mockResolvedValue(new Response('{}', { status: 200 }));
    const { POST } = await loadRoute();
    const req = new Request('http://t.localhost/api/account/magic-link/consume', {
      method: 'POST',
      headers: { host: 't.localhost' },
      body: '{"token":"abc"}',
    });
    await POST(req, { params: Promise.resolve({ path: ['magic-link', 'consume'] }) });
    expect((upstream.mock.calls[0] as [string])[0]).toBe(
      `${API_URL}/v1/storefront/account/magic-link/consume`,
    );
  });

  it('forwards BOTH Set-Cookie headers a sign-in returns, separately', async () => {
    // A sign-in sets `ventia_shopper` AND re-points `ventia_cart` at the
    // merged cart. `Headers.get('set-cookie')` would collapse the two into
    // one comma-joined string that cannot be parsed back apart — losing the
    // shopper their session, their cart, or both.
    const headers = new Headers({ 'content-type': 'application/json' });
    headers.append('set-cookie', 'ventia_shopper=sess-1; HttpOnly; Path=/');
    headers.append('set-cookie', 'ventia_cart=cart-9; HttpOnly; Path=/');
    upstream.mockResolvedValue(new Response('{"shopper":{},"cart":{}}', { status: 200, headers }));

    const { POST } = await loadRoute();
    const req = new Request('http://t.localhost/api/account/sign-in', {
      method: 'POST',
      headers: { host: 't.localhost' },
      body: '{}',
    });
    const res = await POST(req, { params: Promise.resolve({ path: ['sign-in'] }) });

    expect(res.headers.getSetCookie()).toEqual([
      'ventia_shopper=sess-1; HttpOnly; Path=/',
      'ventia_cart=cart-9; HttpOnly; Path=/',
    ]);
  });

  it('passes a 204 sign-out through without a body', async () => {
    // `new Response('', {status: 204})` throws in undici, so a proxy that
    // forwarded the (empty) body text verbatim would 500 every sign-out.
    upstream.mockResolvedValue(new Response(null, { status: 204 }));
    const { POST } = await loadRoute();
    const req = new Request('http://t.localhost/api/account/sign-out', {
      method: 'POST',
      headers: { host: 't.localhost' },
    });
    const res = await POST(req, { params: Promise.resolve({ path: ['sign-out'] }) });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
  });

  it('sends no cookie header at all when the browser had none', async () => {
    upstream.mockResolvedValue(new Response('{}', { status: 200 }));
    const { POST } = await loadRoute();
    const req = new Request('http://t.localhost/api/account/register', {
      method: 'POST',
      headers: { host: 't.localhost' },
      body: '{}',
    });
    await POST(req, { params: Promise.resolve({ path: ['register'] }) });
    expect((upstream.mock.calls[0][1] as RequestInit).headers).not.toHaveProperty('cookie');
  });
});

describe('GET /api/account/*', () => {
  it('forwards the session cookie and keeps a 401 a 401', async () => {
    // `/me` answering 401 is how the storefront learns nobody is signed in;
    // a proxy that swallowed the status would make every visitor look signed
    // in until the next call failed.
    upstream.mockResolvedValue(new Response(JSON.stringify({ error: 'SHOPPER_UNAUTHORIZED' }), { status: 401 }));
    const { GET } = await loadRoute();
    const req = new Request('http://t.localhost/api/account/me', {
      headers: { host: 't.localhost', cookie: 'ventia_shopper=sess-1' },
    });
    const res = await GET(req, { params: Promise.resolve({ path: ['me'] }) });

    expect(res.status).toBe(401);
    const init = upstream.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).cookie).toBe('ventia_shopper=sess-1');
    // No content-type on a bodyless GET.
    expect(init.headers).not.toHaveProperty('content-type');
  });
});

describe('PATCH /api/account/me', () => {
  it('forwards the method and body', async () => {
    upstream.mockResolvedValue(new Response('{}', { status: 200 }));
    const { PATCH } = await loadRoute();
    const req = new Request('http://t.localhost/api/account/me', {
      method: 'PATCH',
      headers: { host: 't.localhost' },
      body: '{"name":"Ana"}',
    });
    await PATCH(req, { params: Promise.resolve({ path: ['me'] }) });
    const init = upstream.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('PATCH');
    expect(init.body).toBe('{"name":"Ana"}');
  });
});
