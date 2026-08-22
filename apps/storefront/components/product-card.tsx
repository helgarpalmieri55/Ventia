import Link from 'next/link';
import { Card, CardContent } from '@ventia/ui';
import { Price } from './price';
import { ProductImage } from './product-image';

/** The subset of `StorefrontProductSummary`
 * (`services/api/src/storefront/products.service.ts`) a product tile needs —
 * kept as a local, minimal shape rather than importing the API's DTO type
 * (no shared package between the API and the storefront app), so any page
 * rendering a `GET /v1/storefront/products` item satisfies this structurally
 * without extra mapping. */
export interface ProductCardData {
  slug: string;
  name: string;
  priceCents: number;
  compareAtCents?: number | null;
  thumbnailUrl?: string | null;
}

export function ProductCard({ product }: { product: ProductCardData }) {
  return (
    <Link href={`/productos/${product.slug}`} className="block">
      <Card className="flex h-full flex-col overflow-hidden transition hover:shadow-md">
        {/* `shrink-0` so the photo keeps its ratio in a tile that the grid has
            stretched to match a taller neighbour, and no rounding of its own:
            the Card already rounds and clips these corners, and a second
            radius would cut two notches into the middle of the tile. `alt=""`
            because the name is printed directly underneath — the link would
            otherwise be announced twice. */}
        <ProductImage src={product.thumbnailUrl} alt="" className="shrink-0" />
        <CardContent className="flex flex-col gap-1 p-3 sm:p-4">
          {/* Two lines rather than `truncate`: at two columns on a phone a
              single truncated line cuts most product names mid-word. */}
          <p className="line-clamp-2 text-sm font-medium">{product.name}</p>
          <Price cents={product.priceCents} compareAtCents={product.compareAtCents} />
        </CardContent>
      </Card>
    </Link>
  );
}
