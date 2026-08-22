import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The `/api/reviews/:slug` proxy is the only way the reviews pager can reach
 * the API at all — `API_INTERNAL_URL` is an internal hostname the browser
 * cannot resolve — so it is tested directly, the same way
 * `account-proxy-route.test.ts` and `revalidate-route.test.ts` test theirs:
 * import the handler, stub global `fetch`.
 *
 * `API_INTERNAL_URL` is read at module scope, so the module is imported
 * dynamically AFTER the env var is set.
 */
const API_URL = 'http://api.internal:4000';

async function loadRoute() {
  process.env.API_INTERNAL_URL = API_URL;
  vi.resetModules();
  return import('../app/api/reviews/[slug]/route');
}

let upstream: ReturnType<typeof vi.fn>;

beforeEach(() => {
  upstream = vi.fn();
  vi.stubGlobal('fetch', upstream);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GET /api/reviews/:slug', () => {
  it('forwards the slug, the query and the browser Host as x-tenant-domain', async () => {
    upstream.mockResolvedValue(
      new Response(JSON.stringify({ summary: { average: 5, count: 12, distribution: {} }, reviews: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const { GET } = await loadRoute();

    const req = new Request('http://tienda.ventia.localhost/api/reviews/camiseta?page=2&pageSize=10', {
      headers: { host: 'tienda.ventia.localhost' },
    });
    const res = await GET(req, { params: Promise.resolve({ slug: 'camiseta' }) });

    expect(res.status).toBe(200);
    const [url, init] = upstream.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${API_URL}/v1/storefront/products/camiseta/reviews?page=2&pageSize=10`);
    // The tenant is resolved by host: this route is hit by the browser, so its
    // own Host header IS the store's subdomain.
    expect((init.headers as Record<string, string>)['x-tenant-domain']).toBe('tienda.ventia.localhost');
    expect(await res.json()).toMatchObject({ summary: { count: 12 } });
  });

  it('sends no cookie upstream — a published review is not a shopper secret', async () => {
    upstream.mockResolvedValue(new Response('{}', { status: 200 }));
    const { GET } = await loadRoute();

    const req = new Request('http://t.localhost/api/reviews/camiseta', {
      headers: { host: 't.localhost', cookie: 'ventia_shopper=sess-1' },
    });
    await GET(req, { params: Promise.resolve({ slug: 'camiseta' }) });

    const [, init] = upstream.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).cookie).toBeUndefined();
  });

  it('never forwards a dot segment — the one thing escaping cannot make inert', async () => {
    // `${API_URL}/v1/storefront/products/../reviews` is resolved by the URL
    // parser as `/v1/storefront/reviews`, escaping the prefix that is supposed
    // to pin this proxy to one endpoint.
    const { GET } = await loadRoute();

    for (const slug of ['..', '.']) {
      const req = new Request('http://t.localhost/api/reviews/x', { headers: { host: 't.localhost' } });
      expect((await GET(req, { params: Promise.resolve({ slug }) })).status).toBe(404);
    }
    // The refusal happens before the fetch — nothing reached the API at all.
    expect(upstream).not.toHaveBeenCalled();
  });

  it('escapes a separator into one harmless segment instead of refusing the request', async () => {
    // A product slug is merchant-controlled (`z.string().min(1).max(60)` in
    // catalog-schemas.ts), so this must not borrow the stricter
    // `isSafeProxyPath` rule the catch-all proxies use: that would 404 a real
    // product's reviews to prevent something escaping already prevents.
    upstream.mockResolvedValue(new Response('{}', { status: 200 }));
    const { GET } = await loadRoute();

    const req = new Request('http://t.localhost/api/reviews/x', { headers: { host: 't.localhost' } });
    await GET(req, { params: Promise.resolve({ slug: '../admin/tenants' }) });

    // One segment, not three: the API is asked about a product with an absurd
    // name and answers 404 itself.
    expect((upstream.mock.calls[0] as [string])[0]).toBe(
      `${API_URL}/v1/storefront/products/..%2Fadmin%2Ftenants/reviews`,
    );
  });

  it('still serves a product whose merchant typed an accented slug', async () => {
    upstream.mockResolvedValue(new Response('{}', { status: 200 }));
    const { GET } = await loadRoute();

    const req = new Request('http://t.localhost/api/reviews/x', { headers: { host: 't.localhost' } });
    const res = await GET(req, { params: Promise.resolve({ slug: 'café-de-origen' }) });

    expect(res.status).toBe(200);
    expect((upstream.mock.calls[0] as [string])[0]).toBe(
      `${API_URL}/v1/storefront/products/caf%C3%A9-de-origen/reviews`,
    );
  });

  it('lets an ordinary product slug straight through', async () => {
    upstream.mockResolvedValue(new Response('{}', { status: 200 }));
    const { GET } = await loadRoute();

    const req = new Request('http://t.localhost/api/reviews/x', { headers: { host: 't.localhost' } });
    const res = await GET(req, { params: Promise.resolve({ slug: 'camiseta-blanca' }) });

    expect(res.status).toBe(200);
    expect((upstream.mock.calls[0] as [string])[0]).toBe(
      `${API_URL}/v1/storefront/products/camiseta-blanca/reviews`,
    );
  });

  it('passes an upstream 404 through rather than inventing an empty page of reviews', async () => {
    // The pager has to tell "we could not get more" apart from "there are no
    // more" — a 200 with `{reviews: []}` invented here would silently end the
    // list at whatever the shopper had already seen.
    upstream.mockResolvedValue(
      new Response(JSON.stringify({ error: 'PRODUCT_NOT_FOUND' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const { GET } = await loadRoute();

    const req = new Request('http://t.localhost/api/reviews/no-existe', { headers: { host: 't.localhost' } });
    const res = await GET(req, { params: Promise.resolve({ slug: 'no-existe' }) });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'PRODUCT_NOT_FOUND' });
  });

  it('forwards a bare request with no query at all', async () => {
    upstream.mockResolvedValue(new Response('{}', { status: 200 }));
    const { GET } = await loadRoute();

    const req = new Request('http://t.localhost/api/reviews/camiseta', { headers: { host: 't.localhost' } });
    await GET(req, { params: Promise.resolve({ slug: 'camiseta' }) });

    expect((upstream.mock.calls[0] as [string])[0]).toBe(`${API_URL}/v1/storefront/products/camiseta/reviews`);
  });
});
