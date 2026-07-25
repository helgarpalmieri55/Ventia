import { headers } from 'next/headers';
import Link from 'next/link';
import { fetchTenantForHost } from '../lib/tenant';
import { fetchStorefront } from '../lib/storefront-api';
import { ProductGrid } from '../components/product-grid';
import type { ProductCardData } from '../components/product-card';

/** Shape of a `GET /v1/storefront/categories` item (see
 * services/api/src/storefront/categories.controller.ts) — kept local like
 * `ProductCardData` rather than shared, matching this app's no-shared-DTO
 * convention with the API. */
interface StorefrontCategory {
  id: string;
  name: string;
  slug: string;
  productCount: number;
}

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
  const [categories, productsResult] = await Promise.all([
    fetchStorefront<StorefrontCategory[]>(tenantHost, '/v1/storefront/categories'),
    fetchStorefront<StorefrontProductListResult>(tenantHost, '/v1/storefront/products?sort=newest&pageSize=8'),
  ]);
  const newest = productsResult?.items ?? [];

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-10 px-4 py-8">
      <section>
        <h1 className="text-3xl font-semibold">{tenant.name}</h1>
        <p className="text-muted-foreground">Bienvenido a la tienda de {tenant.name}.</p>
      </section>

      {categories && categories.length > 0 ? (
        <section>
          <h2 className="mb-4 text-xl font-semibold">Categorías</h2>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {categories.map((category) => (
              <Link
                key={category.id}
                href={`/categorias/${category.slug}`}
                className="rounded-lg border p-4 transition hover:shadow-md"
              >
                <p className="font-medium">{category.name}</p>
                <p className="text-sm text-muted-foreground">{category.productCount} productos</p>
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      <section>
        <h2 className="mb-4 text-xl font-semibold">Novedades</h2>
        <ProductGrid products={newest} />
      </section>
    </main>
  );
}
