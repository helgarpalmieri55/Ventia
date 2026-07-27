import Link from 'next/link';
import { Card, CardContent } from '@ventia/ui';
import { Price } from './price';

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
      <Card className="h-full overflow-hidden transition hover:shadow-md">
        <div className="aspect-square w-full bg-muted">
          {product.thumbnailUrl ? (
            // Plain <img>, not next/image: storefront has no remote-image
            // domain config yet (thumbnails come from whatever host the
            // merchant uploaded to), and this matches the admin app's
            // existing convention (see productos/page.tsx, images-manager.tsx).
            <img src={product.thumbnailUrl} alt={product.name} className="h-full w-full object-cover" />
          ) : null}
        </div>
        <CardContent className="flex flex-col gap-1 p-4">
          <p className="truncate text-sm font-medium">{product.name}</p>
          <Price cents={product.priceCents} compareAtCents={product.compareAtCents} />
        </CardContent>
      </Card>
    </Link>
  );
}
