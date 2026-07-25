import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { fetchTenantForHost } from '../../../lib/tenant';
import { fetchStorefront } from '../../../lib/storefront-api';
import { ProductGrid } from '../../../components/product-grid';
import { Price } from '../../../components/price';
import { Badge, Button, Select } from '@ventia/ui';

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

const VARIANT_OPTION_KEYS = ['option1', 'option2', 'option3'] as const;

/** Distinct, non-null values a given option position (0-based, matching
 * `options[position]`'s label) takes across `variants`, in first-seen order.
 * Purely decorative input for the per-option <Select> below — this task
 * wires no client state, so the derivation only needs to produce the list of
 * choices to display, not track a selection. Kept local to this page file
 * rather than a new `lib/` helper module, per the brief's "no new pure
 * helpers — composition only". */
function distinctVariantOptionValues(
  variants: StorefrontProductDetail['variants'],
  position: number,
): string[] {
  const key = VARIANT_OPTION_KEYS[position];
  const values: string[] = [];
  for (const variant of variants) {
    const value = variant[key];
    if (value && !values.includes(value)) values.push(value);
  }
  return values;
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

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-8 px-4 py-8">
      <div className="grid gap-8 md:grid-cols-2">
        <div className="flex flex-col gap-2">
          {product.images.length > 0 ? (
            product.images.map((image, i) => (
              // Plain <img>, not next/image: storefront has no remote-image
              // domain config yet, matching product-card.tsx's established
              // convention.
              <img
                key={i}
                src={image.url}
                alt={image.alt ?? product.name}
                className="aspect-square w-full rounded-md bg-muted object-cover"
              />
            ))
          ) : (
            // Simple muted placeholder box — no placeholder SVG asset exists
            // in this codebase yet, out of scope for this task.
            <div className="aspect-square w-full rounded-md bg-muted" />
          )}
        </div>

        <div className="flex flex-col gap-4">
          <h1 className="text-2xl font-semibold">{product.name}</h1>
          <Price cents={product.priceCents} compareAtCents={product.compareAtCents} />

          <div>
            <Badge variant={product.inStock ? 'default' : 'secondary'}>
              {product.inStock ? 'En stock' : 'Agotado'}
            </Badge>
          </div>

          {product.options.length > 0 ? (
            <div className="flex flex-col gap-3">
              {product.options.map((optionName, i) => (
                <label key={optionName} className="flex flex-col gap-1 text-sm">
                  <span className="font-medium">{optionName}</span>
                  {/* Plain server-rendered <select>, no onChange/client state:
                      purely informational for this task — "Agregar al
                      carrito" stays disabled regardless of selection. A
                      later task (P2b) wires real variant-aware add-to-cart. */}
                  <Select defaultValue="">
                    <option value="" disabled>
                      Selecciona {optionName.toLowerCase()}
                    </option>
                    {distinctVariantOptionValues(product.variants, i).map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </Select>
                </label>
              ))}
            </div>
          ) : null}

          <div>
            <Button disabled title="Disponible próximamente">
              Agregar al carrito
            </Button>
          </div>

          {/* No markdown renderer exists in this codebase yet — rendering
              descriptionMd as plain text (whitespace-pre-wrap so at least
              line breaks survive) rather than adding one, out of scope for
              this task. */}
          <div className="whitespace-pre-wrap text-sm text-muted-foreground">{product.descriptionMd}</div>
        </div>
      </div>

      {product.related.length > 0 ? (
        <section>
          <h2 className="mb-4 text-xl font-semibold">También te puede interesar</h2>
          <ProductGrid products={product.related} />
        </section>
      ) : null}
    </main>
  );
}
