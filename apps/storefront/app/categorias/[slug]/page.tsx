import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { fetchTenantForHost } from '../../../lib/tenant';
import { fetchStorefrontOrNull } from '../../../lib/storefront-api';
import { ProductGrid } from '../../../components/product-grid';
import type { ProductCardData } from '../../../components/product-card';

/** Same local shape as app/page.tsx's copy — see that file's comment for why
 * it isn't shared. */
interface StorefrontCategory {
  id: string;
  name: string;
  slug: string;
  productCount: number;
}

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

  const productsResult = await fetchStorefrontOrNull<StorefrontProductListResult>(
    tenantHost,
    `/v1/storefront/products?category=${encodeURIComponent(slug)}&sort=newest`,
  );

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-8">
      <h1 className="text-2xl font-semibold">{category.name}</h1>
      <ProductGrid products={productsResult?.items ?? []} />
    </main>
  );
}
