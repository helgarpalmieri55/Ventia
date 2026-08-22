import { headers } from 'next/headers';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { fetchTenantForHost } from '../../../lib/tenant';
import { fetchStorefrontOrNull } from '../../../lib/storefront-api';
import { buildCategoryTree, categoryPath, type StorefrontCategory } from '../../../lib/category-tree';
import { ProductGrid } from '../../../components/product-grid';
import type { ProductCardData } from '../../../components/product-card';

interface StorefrontProductListResult {
  items: ProductCardData[];
  total: number;
  page: number;
  pageSize: number;
}

export default async function CategoryPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const host = (await headers()).get('host');
  const apiUrl = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';
  const tenant = await fetchTenantForHost(host, apiUrl);

  // No "platform landing" concept for a category sub-route (unlike
  // app/page.tsx's unknown-host branch), so an unresolved tenant is a plain
  // 404 here. A suspended tenant never reaches this component at all —
  // middleware.ts already answered with a real 503 upstream of any routing.
  if (!tenant) notFound();

  // `host` is guaranteed non-null here (see app/page.tsx's identical comment).
  const tenantHost = host as string;

  // The categories endpoint has no single-slug lookup, so the full list is
  // fetched and matched by slug here, same as the home page's category
  // tiles — simplest option per the brief rather than adding a new API route.
  // fetchStorefrontOrNull (not fetchStorefront): a transient upstream error
  // degrades to `notFound()` here (safe default — no crash), same as a
  // genuinely nonexistent slug, rather than an uncaught exception.
  const categories = await fetchStorefrontOrNull<StorefrontCategory[]>(tenantHost, '/v1/storefront/categories');
  const category = categories?.find((c) => c.slug === slug);
  if (!category) notFound();

  // `buildCategoryTree`, NOT `buildCategoryNav`: the header prunes categories
  // that sell nothing, and this is the one page where the shopper may well be
  // standing inside one of them (a merchant clicks their own empty category
  // from the admin, or an old link is still indexed). Pruning here would leave
  // the page with no breadcrumb at all.
  const tree = buildCategoryTree(categories ?? []);
  const trail = categoryPath(tree, slug);
  const current = trail.length > 0 ? trail[trail.length - 1] : null;
  // Only children that have something to sell — a subcategory chip leading to
  // an empty grid is a worse answer than no chip.
  const children = current?.children.filter((child) => child.totalProductCount > 0) ?? [];

  const productsResult = await fetchStorefrontOrNull<StorefrontProductListResult>(
    tenantHost,
    `/v1/storefront/products?category=${encodeURIComponent(slug)}&sort=newest`,
  );
  const items = productsResult?.items ?? [];

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-8">
      {/* The way back up. The header's mobile strip only carries top-level
          categories (a phone has no hover to open a submenu with), so for a
          shopper two levels in this trail is the only thing naming where they
          are and the only link to the level above. */}
      <nav aria-label="Ruta de navegación" className="text-sm text-muted-foreground">
        <ol className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <li>
            <Link href="/" className="hover:underline">
              Inicio
            </Link>
          </li>
          {trail.map((node, i) => (
            <li key={node.id} className="flex items-center gap-x-2">
              <span aria-hidden="true">›</span>
              {i === trail.length - 1 ? (
                // The page you are on is not a link to itself.
                <span className="text-foreground" aria-current="page">
                  {node.name}
                </span>
              ) : (
                <Link href={`/categorias/${node.slug}`} className="hover:underline">
                  {node.name}
                </Link>
              )}
            </li>
          ))}
        </ol>
      </nav>

      <h1 className="text-2xl font-semibold">{category.name}</h1>

      {children.length > 0 ? (
        <nav aria-label={`Subcategorías de ${category.name}`}>
          <ul className="flex flex-wrap gap-2">
            {children.map((child) => (
              <li key={child.id}>
                <Link
                  href={`/categorias/${child.slug}`}
                  className="block rounded-full border border-border px-3 py-1.5 text-sm transition-colors hover:bg-muted"
                >
                  {child.name}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}

      {/* `?category=` matches products filed DIRECTLY under this category —
          the API's filter is a plain `EXISTS` on the join table, with no walk
          down the tree (services/api/src/storefront/products.service.ts). So a
          purely organisational parent ("Mujer", whose products all live in
          "Ropa" and "Zapatos") legitimately has nothing of its own, and
          ProductGrid's "No hay productos para mostrar" would be telling the
          shopper the store is empty while pointing at forty products. */}
      {items.length === 0 && children.length > 0 ? (
        <p className="text-sm text-muted-foreground">Elige una subcategoría para ver los productos.</p>
      ) : (
        <ProductGrid products={items} />
      )}
    </main>
  );
}
