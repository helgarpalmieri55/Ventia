import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { fetchTenantForHost } from '../../../lib/tenant';
import { jsonLdScript } from '../../../lib/json-ld';
import { fetchStorefront, fetchStorefrontOrNull } from '../../../lib/storefront-api';
import { ProductGrid } from '../../../components/product-grid';
import { Price } from '../../../components/price';
import { AddToCart } from '../../../components/add-to-cart';
import { ProductImage } from '../../../components/product-image';
import { ProductReviews } from '../../../components/product-reviews';
import { WishlistHeart } from '../../../components/wishlist-heart';
import { StarRating } from '../../../components/star-rating';
import { fetchProductReviews, formatAverage, reviewCountLabel } from '../../../lib/reviews-api';
import { Badge } from '@ventia/ui';

/** Shape of `GET /v1/storefront/products/:slug`'s response (see
 * services/api/src/storefront/products.service.ts#StorefrontProductDetail) —
 * kept local like `ProductCardData`/the other storefront pages' DTOs (no
 * shared package between the API and this app). `variants[].stock` is
 * carried through structurally but deliberately never rendered below: the
 * spec's storefront-never-leaks-inventory posture means `inStock` is the only
 * stock signal a shopper ever sees. */
interface StorefrontProductDetail {
  id: string;
  name: string;
  slug: string;
  descriptionMd: string;
  priceCents: number;
  compareAtCents: number | null;
  taxRate: string;
  inStock: boolean;
  options: string[];
  images: Array<{ url: string; alt: string | null }>;
  variants: Array<{
    id: string;
    option1: string | null;
    option2: string | null;
    option3: string | null;
    priceCents: number | null;
    stock: number;
  }>;
  related: Array<{
    id: string;
    name: string;
    slug: string;
    priceCents: number;
    compareAtCents: number | null;
    thumbnailUrl: string | null;
    inStock: boolean;
  }>;
}

/** Truncates `text` to at most `maxLength` characters, breaking at the last
 * whitespace before the cutoff when possible so the description doesn't end
 * mid-word — a trivial inline transform, not promoted to a `lib/` helper. */
function truncate(text: string, maxLength: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) return trimmed;
  const cut = trimmed.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

// Re-resolves tenant + product from `params`/`headers()` independently of the
// page component below — Next.js request-memoizes identical `fetch()` calls
// within one request and `fetchTenantForHost` is already `cache()`-wrapped,
// so this is idiomatic duplication, not a real extra round trip.
export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const host = (await headers()).get('host');
  const apiUrl = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';
  const tenant = await fetchTenantForHost(host, apiUrl);
  if (!tenant || !host) return {};

  // fetchStorefrontOrNull (not fetchStorefront): metadata generation must
  // never crash the page — a transient upstream error here should just fall
  // back to minimal metadata, while the page component's own plain
  // fetchStorefront call still surfaces the error / notFound() as usual.
  const product = await fetchStorefrontOrNull<StorefrontProductDetail>(
    host,
    `/v1/storefront/products/${encodeURIComponent(slug)}`,
  );
  if (!product) return {};

  const description = truncate(product.descriptionMd, 160);
  const images = product.images.length > 0 ? product.images.map((image) => ({ url: image.url })) : undefined;

  return {
    title: product.name,
    description,
    openGraph: {
      title: product.name,
      description,
      images,
    },
  };
}

export default async function ProductPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const host = (await headers()).get('host');
  const apiUrl = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';
  const tenant = await fetchTenantForHost(host, apiUrl);

  // No "platform landing" concept for a product sub-route (unlike
  // app/page.tsx's unknown-host branch), same as categorias/[slug]/page.tsx —
  // an unresolved tenant is a plain 404 here. A suspended tenant never
  // reaches this component at all — middleware.ts already answered with a
  // real 503 upstream of any routing.
  if (!tenant) notFound();

  // `host` is guaranteed non-null here (see categorias/[slug]/page.tsx's
  // identical comment).
  const tenantHost = host as string;

  // Plain fetchStorefront (not the OrNull variant): this fetch's result
  // directly decides notFound() below, so a real upstream error should
  // surface as a real error here, not silently render "not found" the same
  // way a genuinely nonexistent/draft/archived slug does.
  const product = await fetchStorefront<StorefrontProductDetail>(
    tenantHost,
    `/v1/storefront/products/${encodeURIComponent(slug)}`,
  );
  if (!product) notFound();

  // Reviews are fetched AFTER the product rather than alongside it because
  // they are addressed by the same slug and are meaningless if it does not
  // resolve — and because this call cannot fail the page (see
  // `fetchProductReviews`), so it has nothing to add to the notFound()
  // decision above.
  const reviews = await fetchProductReviews(tenantHost, slug);
  const summary = reviews?.summary ?? null;

  // schema.org Product structured data. `price` is a plain decimal string in
  // pesos (the currency's major unit) per schema.org's Offer.price
  // convention — NOT `formatCOP`'s display formatting (`"$ 45.900"`) — derived
  // directly from priceCents with the same `Math.round(cents / 100)`
  // convention formatCOP itself uses internally.
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: product.name,
    image: product.images.map((image) => image.url),
    description: product.descriptionMd,
    offers: {
      '@type': 'Offer',
      priceCurrency: 'COP',
      price: String(Math.round(product.priceCents / 100)),
      availability: product.inStock ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
    },
    // Only when there is something to aggregate. `aggregateRating` with a
    // count of 0 is invalid structured data, and Google's own rule is that the
    // rating must match what a visitor SEES on the page — which is the second
    // reason the API's average counts published reviews only. A number here
    // that included hidden ones would be a claim the page itself contradicts.
    ...(summary && summary.average !== null && summary.count > 0
      ? {
          aggregateRating: {
            '@type': 'AggregateRating',
            ratingValue: String(summary.average),
            reviewCount: summary.count,
          },
        }
      : {}),
  };

  return (
    <>
      {/* Standard/only way to emit JSON-LD in the App Router. `jsonLdScript`
          and not bare `JSON.stringify`: the name and the description below are
          text a merchant typed — or that arrived in a CSV from a supplier —
          and `JSON.stringify` does not escape `<`, so a `</script>` in either
          would close this tag and turn the rest into markup. See
          lib/json-ld.ts. */}
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(jsonLd) }} />
      <main className="mx-auto flex max-w-6xl flex-col gap-8 px-4 py-8">
        <div className="grid gap-8 md:grid-cols-2">
          {/* On a phone this is a swipeable strip, on md+ the vertical stack
              it always was. The stack is what pushed the price, the size
              picker and "Agregar al carrito" below four full-width photos on
              mobile — the one screen where almost all of this store's traffic
              lands, and the one place a shopper decides to buy. Scroll-snap
              plus a slide narrower than the viewport (the next photo peeks in
              at the edge) does that with no JavaScript at all, so it costs
              the tenant nothing in bundle size. */}
          <div className="-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 md:mx-0 md:flex-col md:overflow-visible md:px-0">
            {product.images.length > 0 ? (
              product.images.map((image, i) => (
                <ProductImage
                  key={i}
                  src={image.url}
                  // The merchant's own alt text when they wrote one; the
                  // product name is the honest fallback, not a decorative
                  // empty alt — on a PDP the photo IS the content.
                  alt={image.alt ?? product.name}
                  // The first photo is the largest thing above the fold on
                  // every product page: lazy-loading it would mean the
                  // shopper waits for the layout to settle before the browser
                  // even asks for it.
                  loading={i === 0 ? 'eager' : 'lazy'}
                  className="w-[88%] shrink-0 snap-center rounded-md md:w-full"
                />
              ))
            ) : (
              <ProductImage src={null} alt={product.name} className="w-full shrink-0 rounded-md" />
            )}
          </div>

          <div className="flex flex-col gap-4">
            <h1 className="text-2xl font-semibold">{product.name}</h1>

            {/* Above the price, and a link rather than a static badge: this is
                the one summary a shopper looks for before reading anything
                else, and the reviews it summarizes are at the bottom of a long
                page on a phone. Rendered only when there IS a rating — an
                empty star row next to a new product looks like a bad one. */}
            {summary && summary.average !== null ? (
              <a href="#resenas" className="flex w-fit items-center gap-2 text-sm">
                <StarRating average={summary.average} size="sm" />
                <span className="font-medium">{formatAverage(summary.average)}</span>
                <span className="text-muted-foreground underline underline-offset-4">
                  {reviewCountLabel(summary.count)}
                </span>
              </a>
            ) : null}

            <Price cents={product.priceCents} compareAtCents={product.compareAtCents} />

            <div>
              <Badge variant={product.inStock ? 'default' : 'secondary'}>
                {product.inStock ? 'En stock' : 'Agotado'}
              </Badge>
            </div>

            {/* Variant selection + "Agregar al carrito" is the one client
                island on this otherwise fully server-rendered PDP (see
                components/add-to-cart.tsx) — P2b wires this up for real;
                P2a left it permanently disabled specifically for this task
                to complete. */}
            <AddToCart
              productId={product.id}
              options={product.options}
              variants={product.variants}
              inStock={product.inStock}
            />

            {/* Below "Agregar al carrito", not beside it: saving for later is
                the secondary action on this page and must not compete with
                the one that makes the sale. Its own client island rather than
                a prop on AddToCart — it needs the SESSION, which that
                component has no reason to know about, and it stays useful for
                a product that is out of stock (which is precisely when a
                shopper wants to be reminded of it later). */}
            <WishlistHeart productId={product.id} productName={product.name} />

            {/* No markdown renderer exists in this codebase yet — rendering
                descriptionMd as plain text (whitespace-pre-wrap so at least
                line breaks survive) rather than adding one, out of scope for
                this task. */}
            <div className="whitespace-pre-wrap text-sm text-muted-foreground">{product.descriptionMd}</div>
          </div>
        </div>

        <ProductReviews productId={product.id} data={reviews} />

        {product.related.length > 0 ? (
          <section>
            <h2 className="mb-4 text-xl font-semibold">También te puede interesar</h2>
            <ProductGrid products={product.related} />
          </section>
        ) : null}
      </main>
    </>
  );
}
