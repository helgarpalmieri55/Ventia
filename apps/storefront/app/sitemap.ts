import type { MetadataRoute } from 'next';
import { headers } from 'next/headers';
import { fetchTenantForHost } from '../lib/tenant';
import { fetchStorefrontOrNull } from '../lib/storefront-api';

/** Shape of a `GET /v1/storefront/categories` item — same local copy as
 * app/page.tsx/categorias/[slug]/page.tsx. Only `slug` is used here. */
interface StorefrontCategory {
  slug: string;
}

/** Shape of a `GET /v1/storefront/collections` item — only `slug` is used
 * here. That endpoint already drops collections with no buyable products, and
 * that is exactly the set this file wants: an emptied collection still has a
 * page (it says the promotion ended — see the controller), but submitting it
 * to a search engine would be asking for a result that shows nothing for sale.
 */
interface StorefrontCollectionSummary {
  slug: string;
}

/** Shape of a `GET /v1/storefront/products` item — only `slug` is used here,
 * unlike the fuller `ProductCardData` this app's other pages read. */
interface StorefrontProductSummary {
  slug: string;
}

interface StorefrontProductListResult {
  items: StorefrontProductSummary[];
  total: number;
  page: number;
  pageSize: number;
}

// Matches services/api/src/storefront/products.service.ts's MAX_PAGE_SIZE —
// requesting the largest allowed page keeps the number of round trips to a
// minimum for tenants with many products.
const PAGE_SIZE = 60;

// Hard ceiling on how many pages this loop will walk, purely as a safety net
// against looping forever if the API ever misbehaves (e.g. always returns
// exactly PAGE_SIZE items). 500 pages * 60 items/page = 30,000 products,
// comfortably above any realistic tenant catalog size for this stage of the
// product.
const MAX_PAGES = 500;

const STATIC_PATHS = ['/', '/buscar', '/envios', '/cambios-y-devoluciones', '/privacidad', '/contacto'];

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const hdrs = await headers();
  const host = hdrs.get('host');
  const apiUrl = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';
  const tenant = await fetchTenantForHost(host, apiUrl);

  // No tenant resolved for this host (unknown host, or a suspended/draft
  // tenant that never reaches this far) — nothing tenant-specific to list.
  // Returning an empty sitemap rather than crashing.
  if (!tenant) return [];

  // `host` is guaranteed non-null here (see categorias/[slug]/page.tsx's
  // identical comment: fetchTenantForHost only ever resolves for a non-null
  // host).
  const tenantHost = host as string;

  // Caddy's reverse_proxy sets this header in dev (see docker/Caddyfile);
  // default to 'https' for safety in any non-dev/non-Caddy context.
  const protocol = hdrs.get('x-forwarded-proto') ?? 'https';
  const origin = `${protocol}://${tenantHost}`;

  const staticEntries: MetadataRoute.Sitemap = STATIC_PATHS.map((path) => ({
    url: `${origin}${path}`,
  }));

  // Paginate through every active product page-by-page until a page comes
  // back with fewer than PAGE_SIZE items — a real tenant can have more
  // products than fit on a single page, so a single unpaginated fetch would
  // silently omit the rest of the catalog.
  const productSlugs: string[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const result = await fetchStorefrontOrNull<StorefrontProductListResult>(
      tenantHost,
      `/v1/storefront/products?pageSize=${PAGE_SIZE}&page=${page}`,
    );
    if (!result || result.items.length === 0) break;
    productSlugs.push(...result.items.map((p) => p.slug));
    if (result.items.length < PAGE_SIZE) break;
  }

  const categories = (await fetchStorefrontOrNull<StorefrontCategory[]>(tenantHost, '/v1/storefront/categories')) ?? [];

  const collections =
    (await fetchStorefrontOrNull<StorefrontCollectionSummary[]>(tenantHost, '/v1/storefront/collections')) ?? [];

  const productEntries: MetadataRoute.Sitemap = productSlugs.map((slug) => ({
    url: `${origin}/productos/${slug}`,
  }));

  const categoryEntries: MetadataRoute.Sitemap = categories.map((category) => ({
    url: `${origin}/categorias/${category.slug}`,
  }));

  const collectionEntries: MetadataRoute.Sitemap = collections.map((collection) => ({
    url: `${origin}/colecciones/${collection.slug}`,
  }));

  return [...staticEntries, ...categoryEntries, ...collectionEntries, ...productEntries];
}
