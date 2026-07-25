import { ProductCard, type ProductCardData } from './product-card';

/** Responsive grid wrapper for a page of storefront product tiles — 2 columns
 * on small screens up to 4 on large ones, matching the general catalog-grid
 * shape common to storefront category/search/home pages. */
export function ProductGrid({ products }: { products: ProductCardData[] }) {
  if (products.length === 0) {
    return <p className="text-sm text-muted-foreground">No hay productos para mostrar.</p>;
  }

  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
      {products.map((product) => (
        <ProductCard key={product.slug} product={product} />
      ))}
    </div>
  );
}
