import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The sitemap, which had no test at all until collections needed adding to it.
 *
 * The failure this guards against is specifically silent: a section that stops
 * being listed does not throw, does not fail a build and does not show up on
 * any page a person looks at. It shows up as those URLs quietly not being
 * indexed, months later, on a store whose owner has no way to tell.
 *
 * `next/headers` and global `fetch` are stubbed; everything else is the real
 * module, so the URL shapes asserted below are the ones a crawler would get.
 */

const HOST = 'tienda.ventia.localhost';

const headersMock = vi.fn();
vi.mock('next/headers', () => ({ headers: () => headersMock() }));

function hdrs(map: Record<string, string>) {
  return { get: (key: string) => map[key.toLowerCase()] ?? null };
}

let upstream: ReturnType<typeof vi.fn>;

/** Routes one stubbed fetch by path, so a test says what each endpoint answers
 * rather than depending on call order. */
function route(handlers: { tenant?: unknown; categories?: unknown; collections?: unknown; products?: unknown[] }) {
  return vi.fn(async (url: string) => {
    const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (url.includes('/v1/tenant')) {
      return handlers.tenant === null ? new Response('', { status: 404 }) : ok(handlers.tenant ?? { id: 't1' });
    }
    if (url.includes('/v1/storefront/categories')) return ok(handlers.categories ?? []);
    if (url.includes('/v1/storefront/collections')) return ok(handlers.collections ?? []);
    if (url.includes('/v1/storefront/products')) {
      // One page, always short, so the paginating loop terminates.
      return ok({ items: handlers.products ?? [], total: 0, page: 1, pageSize: 60 });
    }
    throw new Error(`unstubbed fetch: ${url}`);
  });
}

async function loadSitemap() {
  vi.resetModules();
  return (await import('../app/sitemap')).default;
}

beforeEach(() => {
  headersMock.mockReturnValue(hdrs({ host: HOST, 'x-forwarded-proto': 'https' }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('sitemap', () => {
  it('lists every collection that has a page', async () => {
    upstream = route({ collections: [{ slug: 'rebajas' }, { slug: 'navidad' }] });
    vi.stubGlobal('fetch', upstream);

    const urls = (await (await loadSitemap())()).map((entry) => entry.url);

    expect(urls).toContain(`https://${HOST}/colecciones/rebajas`);
    expect(urls).toContain(`https://${HOST}/colecciones/navidad`);
  });

  it('still lists categories, products and the static pages alongside them', async () => {
    // The regression that matters is a section going missing, so every section
    // is asserted together rather than each in isolation.
    upstream = route({
      categories: [{ slug: 'camisas' }],
      collections: [{ slug: 'rebajas' }],
      products: [{ slug: 'camisa-blanca' }],
    });
    vi.stubGlobal('fetch', upstream);

    const urls = (await (await loadSitemap())()).map((entry) => entry.url);

    expect(urls).toContain(`https://${HOST}/`);
    expect(urls).toContain(`https://${HOST}/categorias/camisas`);
    expect(urls).toContain(`https://${HOST}/colecciones/rebajas`);
    expect(urls).toContain(`https://${HOST}/productos/camisa-blanca`);
  });

  it('omits the collections section rather than failing when that endpoint is down', async () => {
    // `fetchStorefrontOrNull` turns an upstream 5xx into null. A store with a
    // broken collections endpoint should still get its products indexed.
    upstream = vi.fn(async (url: string) => {
      if (url.includes('/v1/storefront/collections')) return new Response('', { status: 500 });
      if (url.includes('/v1/tenant')) return new Response(JSON.stringify({ id: 't1' }), { status: 200 });
      if (url.includes('/v1/storefront/categories')) return new Response('[]', { status: 200 });
      return new Response(JSON.stringify({ items: [{ slug: 'camisa' }], total: 1, page: 1, pageSize: 60 }), {
        status: 200,
      });
    });
    vi.stubGlobal('fetch', upstream);

    const urls = (await (await loadSitemap())()).map((entry) => entry.url);

    expect(urls).toContain(`https://${HOST}/productos/camisa`);
    expect(urls.some((url) => url.includes('/colecciones/'))).toBe(false);
  });

  it('returns nothing at all for a host with no tenant', async () => {
    upstream = route({ tenant: null, collections: [{ slug: 'rebajas' }] });
    vi.stubGlobal('fetch', upstream);

    expect(await (await loadSitemap())()).toEqual([]);
  });
});
