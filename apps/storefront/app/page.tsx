import { headers } from 'next/headers';
import Link from 'next/link';
import { fetchTenantForHost } from '../lib/tenant';
import { fetchStorefrontOrNull } from '../lib/storefront-api';
import { formatProductCount } from '../lib/format';
import { buildCategoryNav, type StorefrontCategory } from '../lib/category-tree';
import { fetchCollections, visibleCollections } from '../lib/collections-api';
import { CollectionStrip } from '../components/collection-strip';
import { ProductGrid } from '../components/product-grid';
import type { ProductCardData } from '../components/product-card';

/** Shape of `GET /v1/storefront/products`' response envelope (see
 * services/api/src/storefront/products.service.ts#StorefrontProductListResult).
 * `items` is a superset of `ProductCardData`, so it's usable by `ProductGrid`
 * without mapping. */
interface StorefrontProductListResult {
  items: ProductCardData[];
  total: number;
  page: number;
  pageSize: number;
}

export default async function Home() {
  const host = (await headers()).get('host');
  const apiUrl = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';
  const tenant = await fetchTenantForHost(host, apiUrl);

  if (!tenant) {
    return (
      <main>
        <h1>Ventia</h1>
        <p>Tu tienda con vendedor de IA. Próximamente.</p>
      </main>
    );
  }

  // The suspended-tenant branch that used to live here (an es-CO "no
  // disponible" message rendered at HTTP 200) is gone: `middleware.ts` now
  // short-circuits suspended tenants with a real HTTP 503 before this page
  // component ever runs, so this component only ever sees an unknown host or
  // a resolvable (live) tenant.

  // `host` is guaranteed non-null here: `fetchTenantForHost` only ever
  // resolves a tenant for a non-null host, and `tenant` is truthy at this
  // point.
  const tenantHost = host as string;
  // fetchStorefrontOrNull (not fetchStorefront): a transient upstream error
  // here (e.g. a suspend-race with middleware.ts's own tenant check) should
  // degrade this section to empty, not crash the whole page render.
  const [categories, collections, productsResult] = await Promise.all([
    fetchStorefrontOrNull<StorefrontCategory[]>(tenantHost, '/v1/storefront/categories'),
    fetchCollections(tenantHost),
    fetchStorefrontOrNull<StorefrontProductListResult>(tenantHost, '/v1/storefront/products?sort=newest&pageSize=8'),
  ]);
  const newest = productsResult?.items ?? [];
  // Empty strips are dropped here as well as server-side — see
  // `visibleCollections` for why the rule is enforced at both ends.
  const strips = visibleCollections(collections);
  // Top level only. The endpoint returns the store's whole category set as a
  // flat list, so before this every subcategory was rendered as its own
  // top-level tile — "Mujer", "Ropa", "Vestidos" side by side as if they were
  // peers, which is exactly the shape a shopper cannot read.
  const topLevel = buildCategoryNav(categories ?? []);

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-10 px-4 py-8">
      <section>
        <h1 className="text-3xl font-semibold">{tenant.name}</h1>
        <p className="text-muted-foreground">Bienvenido a la tienda de {tenant.name}.</p>
      </section>

      {topLevel.length > 0 ? (
        <section>
          <h2 className="mb-4 text-xl font-semibold">Categorías</h2>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {topLevel.map((category) => (
              <Link
                key={category.id}
                href={`/categorias/${category.slug}`}
                className="rounded-lg border border-border p-4 transition hover:shadow-md"
              >
                <p className="font-medium">{category.name}</p>
                {/* `totalProductCount`, not `productCount`: a parent that only
                    organises its children holds no products of its own and
                    used to advertise itself as "0 productos" while sitting on
                    the whole women's catalog. */}
                <p className="text-sm text-muted-foreground">{formatProductCount(category.totalProductCount)}</p>
                {category.children.length > 0 ? (
                  // Names, not links: the tile is already one big <a>, and an
                  // anchor inside an anchor is invalid DOM that browsers
                  // silently un-nest. They are here to say what is inside —
                  // the header's menu is where you click one.
                  <p className="mt-1 truncate text-xs text-muted-foreground">
                    {category.children.map((child) => child.name).join(' · ')}
                  </p>
                ) : null}
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      {/* The merchant's own curation sits above "Novedades", which is the
          system's automatic row: when a merchant has taken the trouble to
          arrange a shop window, that window is what a shopper should meet
          first. Below the category map, though — that is the store's
          navigation, and a shopper who arrived looking for a department
          should not have to scroll past a sale to find it. */}
      {strips.map((collection) => (
        <CollectionStrip key={collection.id} collection={collection} />
      ))}

      <section>
        <h2 className="mb-4 text-xl font-semibold">Novedades</h2>
        <ProductGrid products={newest} />
      </section>
    </main>
  );
}
