import { describe, expect, it } from 'vitest';
import {
  STRIP_MAX_PRODUCTS,
  collectionHref,
  fetchCollection,
  fetchCollections,
  visibleCollections,
  type StorefrontCollection,
} from '../lib/collections-api';

function product(slug: string) {
  return { id: slug, slug, name: slug.toUpperCase(), priceCents: 1000, thumbnailUrl: null, inStock: true };
}

function collection(slug: string, productCount: number): StorefrontCollection {
  return {
    id: slug,
    slug,
    name: slug.toUpperCase(),
    products: Array.from({ length: productCount }, (_, i) => product(`${slug}-${i}`)),
  };
}

describe('STRIP_MAX_PRODUCTS', () => {
  it('matches the cap the API applies, so this bound never truncates a strip the shop meant to show', () => {
    // `STRIP_PRODUCT_LIMIT` in
    // services/api/src/collections/storefront-collections.controller.ts, pinned
    // there by its own test. This one is the independent second bound (see
    // the constant's doc comment): it exists to survive an API that stops
    // capping, and a value BELOW the API's would silently drop tiles the
    // merchant curated and the server already sent.
    expect(STRIP_MAX_PRODUCTS).toBe(12);
  });
});

describe('visibleCollections', () => {
  it('keeps the API order — the merchant arranged the strips, not this function', () => {
    const rows = [collection('ofertas', 2), collection('nuevos', 1)];
    expect(visibleCollections(rows).map((c) => c.slug)).toEqual(['ofertas', 'nuevos']);
  });

  it('drops a collection with nothing to show, rather than rendering an empty strip', () => {
    const rows = [collection('nuevos', 2), collection('vacia', 0), collection('temporada-pasada', 0)];
    expect(visibleCollections(rows).map((c) => c.slug)).toEqual(['nuevos']);
  });

  it('degrades to no strips when the API could not be reached', () => {
    expect(visibleCollections(null)).toEqual([]);
  });

  it('caps a strip even if the API sends more than it promised', () => {
    const rows = [collection('nuevos', STRIP_MAX_PRODUCTS + 5)];
    const [strip] = visibleCollections(rows);
    expect(strip.products).toHaveLength(STRIP_MAX_PRODUCTS);
    // The cap takes the FIRST tiles: the merchant's order means the ones they
    // put at the front are the ones that matter.
    expect(strip.products[0].slug).toBe('nuevos-0');
    expect(strip.products.at(-1)?.slug).toBe(`nuevos-${STRIP_MAX_PRODUCTS - 1}`);
  });

  it('leaves a strip exactly at the cap untouched', () => {
    const rows = [collection('nuevos', STRIP_MAX_PRODUCTS)];
    const [strip] = visibleCollections(rows);
    expect(strip.products).toHaveLength(STRIP_MAX_PRODUCTS);
    // Same object: nothing was rebuilt for a row that already fits.
    expect(strip).toBe(rows[0]);
  });

  it('does not mutate the rows it was given', () => {
    const rows = [collection('nuevos', STRIP_MAX_PRODUCTS + 1)];
    visibleCollections(rows);
    expect(rows[0].products).toHaveLength(STRIP_MAX_PRODUCTS + 1);
  });
});

describe('fetchCollections', () => {
  it('asks the storefront endpoint, scoped to the tenant host', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, status: 200, json: async () => [collection('nuevos', 1)] } as unknown as Response;
    }) as unknown as typeof fetch;

    const rows = await fetchCollections('tienda.ventia.co', fetchImpl);
    expect(rows?.[0].slug).toBe('nuevos');
    expect(calls[0].url).toContain('/v1/storefront/collections');
    expect((calls[0].init?.headers as Record<string, string>)['x-tenant-domain']).toBe('tienda.ventia.co');
  });

  it('resolves to null instead of throwing when the store is momentarily broken', async () => {
    const fetchImpl = (async () =>
      ({ ok: false, status: 503, json: async () => ({}) }) as unknown as Response) as unknown as typeof fetch;
    await expect(fetchCollections('tienda.ventia.co', fetchImpl)).resolves.toBeNull();
  });
});

describe('collectionHref', () => {
  it('points at the collection page the strip links to and the page renders', () => {
    expect(collectionHref('ofertas')).toBe('/colecciones/ofertas');
  });

  it('escapes a slug rather than emitting a URL with a raw separator in it', () => {
    // `collectionSlugSchema` makes this unreachable today. It is asserted so
    // that loosening the schema cannot silently start producing broken links.
    expect(collectionHref('ropa/verano')).toBe('/colecciones/ropa%2Fverano');
  });
});

describe('fetchCollection', () => {
  it('asks for the one collection by slug, scoped to the tenant host', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        json: async () => ({ ...collection('ofertas', 2), descriptionMd: 'Hasta agotar existencias' }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const found = await fetchCollection('tienda.ventia.co', 'ofertas', fetchImpl);
    expect(found?.slug).toBe('ofertas');
    // The field the LIST endpoint deliberately withholds: this is the request
    // that carries it, and the page is the only thing that renders it.
    expect(found?.descriptionMd).toBe('Hasta agotar existencias');
    expect(calls[0].url).toContain('/v1/storefront/collections/ofertas');
    expect((calls[0].init?.headers as Record<string, string>)['x-tenant-domain']).toBe('tienda.ventia.co');
  });

  it('escapes the slug it was given instead of pasting it into the path', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch;

    await fetchCollection('tienda.ventia.co', 'ropa/verano', fetchImpl);
    expect(calls[0]).toContain('/v1/storefront/collections/ropa%2Fverano');
  });

  it('resolves to null for a collection that is not there, so the page can 404', async () => {
    const fetchImpl = (async () =>
      ({ ok: false, status: 404, json: async () => ({ error: 'COLLECTION_NOT_FOUND' }) }) as unknown as Response) as unknown as typeof fetch;
    await expect(fetchCollection('tienda.ventia.co', 'no-existe', fetchImpl)).resolves.toBeNull();
  });

  it('resolves to null — not a thrown error — when the store is momentarily broken', async () => {
    const fetchImpl = (async () =>
      ({ ok: false, status: 503, json: async () => ({}) }) as unknown as Response) as unknown as typeof fetch;
    await expect(fetchCollection('tienda.ventia.co', 'ofertas', fetchImpl)).resolves.toBeNull();
  });

  it('keeps an emptied collection as a real answer rather than a missing one', async () => {
    // The API answers 200 with no products for an active collection whose
    // members were all archived, and the page says so in words. If this ever
    // became a 404 the merchant's own broadcast link would tell shoppers they
    // mistyped it.
    const fetchImpl = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ ...collection('temporada-pasada', 0), descriptionMd: '' }),
      }) as unknown as Response) as unknown as typeof fetch;

    const found = await fetchCollection('tienda.ventia.co', 'temporada-pasada', fetchImpl);
    expect(found).not.toBeNull();
    expect(found?.products).toEqual([]);
  });
});
