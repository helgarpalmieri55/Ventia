import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { fetchTenantForHost } from '../../lib/tenant';
import { fetchStorefrontOrNull } from '../../lib/storefront-api';
import { ProductGrid } from '../../components/product-grid';
import type { ProductCardData } from '../../components/product-card';
import { Button, Input } from '@ventia/ui';

/** Shape of `GET /v1/storefront/products`' response envelope (see
 * services/api/src/storefront/products.service.ts#StorefrontProductListResult),
 * same local copy as app/page.tsx and categorias/[slug]/page.tsx. */
interface StorefrontProductListResult {
  items: ProductCardData[];
  total: number;
  page: number;
  pageSize: number;
}

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[] }>;
}) {
  const { q } = await searchParams;
  // Next.js parses a repeated query key (`?q=a&q=b`) as a string array, not
  // just a string — the rendered form only ever emits one `q`, but this is a
  // public, unauthenticated route, so a hand-crafted/bot-generated URL with a
  // repeated key must not crash. Only the first value is used.
  const rawQ = Array.isArray(q) ? q[0] : q;
  const host = (await headers()).get('host');
  const apiUrl = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';
  const tenant = await fetchTenantForHost(host, apiUrl);

  // Same reasoning as categorias/[slug]/page.tsx and productos/[slug]/page.tsx:
  // no "platform landing" concept exists for /buscar either, so an unresolved
  // tenant is a plain 404 here too — for consistency with those sibling
  // sub-routes rather than inventing a third unresolved-tenant behavior just
  // for search.
  if (!tenant) notFound();

  // `host` is guaranteed non-null here (see categorias/[slug]/page.tsx's
  // identical comment).
  const tenantHost = host as string;
  const query = rawQ?.trim();

  // fetchStorefrontOrNull (not fetchStorefront): a transient upstream error
  // here should degrade this section to the empty-results state, not crash
  // the whole page — same posture as the related-products/category-listing
  // fetches elsewhere in this app.
  const result = query
    ? await fetchStorefrontOrNull<StorefrontProductListResult>(
        tenantHost,
        `/v1/storefront/products?search=${encodeURIComponent(query)}&sort=relevance`,
      )
    : null;

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-8">
      <h1 className="text-2xl font-semibold">Buscar productos</h1>

      {/* Plain GET form — no client component/JS needed, it navigates to
          /buscar?q=... on submit like any ordinary HTML form. */}
      <form action="/buscar" method="get" className="flex max-w-md gap-2">
        <Input type="text" name="q" defaultValue={rawQ} placeholder="¿Qué estás buscando?" aria-label="Buscar productos" />
        <Button type="submit">Buscar</Button>
      </form>

      {query ? (
        result && result.items.length > 0 ? (
          <ProductGrid products={result.items} />
        ) : (
          <p className="text-sm text-muted-foreground">No encontramos productos para «{query}».</p>
        )
      ) : null}
    </main>
  );
}
