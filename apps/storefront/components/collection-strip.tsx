import Link from 'next/link';
import { ProductCard } from './product-card';
import { collectionHref, type StorefrontCollection } from '../lib/collections-api';

/**
 * One curated row: a heading and a horizontally scrolling line of product
 * tiles — the "Nuevos" / "Ofertas" strips of docs/design-gap.md §3.
 *
 * ## The tile is `ProductCard`, unchanged
 *
 * Not a strip-specific card. A shopper who sees a garment on the home page
 * and then in a category grid is looking at the same product, and two cards
 * that crop, price or clamp it differently read as two different stores —
 * the exact failure `product-image.tsx` was written to end. So the row owns
 * only the layout around the card: a fixed tile width (the grid's cards get
 * theirs from grid columns; a flex row has none, and without one the tiles
 * would each size to their own name) and the scroll behaviour.
 *
 * ## Scroll, not wrap
 *
 * A wrapping row would push everything below it off a phone screen as soon as
 * a merchant curated more than four products, and the whole point of the
 * design's strips is that several fit above the fold. `snap-x` so a thumb
 * flick lands on a tile rather than between two, and `-mx-4 px-4` so the row
 * bleeds to the edges of a phone (a tile half-cut at the right edge is what
 * tells a shopper there is more to scroll) while the page keeps its gutter.
 *
 * ## Never an empty strip
 *
 * `visibleCollections` already drops collections with nothing to show, and
 * the API drops them before that. This guard is the last of the three, and it
 * is here rather than trusted upstream because a heading over blank space is
 * the one outcome a shopper must never see: it looks like the store is
 * broken, not like the sale ended.
 *
 * ## "Ver todo", and why it is always there
 *
 * The row is capped at twelve tiles (`STRIP_MAX_PRODUCTS`) and a collection
 * may hold up to two hundred, so without a way out of the strip the merchant's
 * thirteenth product is unreachable from the home page. The link is rendered
 * unconditionally rather than only when the cap bit, because this response
 * does not carry a total — the API sends the capped page, not the count — so
 * "are there more?" is a question this component cannot answer, and guessing
 * it wrong hides products. It is also not a wasted click when the strip is
 * complete: the collection page is the only place the merchant's description
 * of the sale is ever shown.
 *
 * `aria-label` names the collection, so a screen-reader user listing the
 * page's links hears "Ver todo en Ofertas" rather than five identical "Ver
 * todo"s with no way to tell them apart.
 */
export function CollectionStrip({ collection }: { collection: StorefrontCollection }) {
  if (collection.products.length === 0) return null;

  const headingId = `coleccion-${collection.slug}`;

  return (
    <section aria-labelledby={headingId}>
      <div className="mb-4 flex items-baseline justify-between gap-4">
        <h2 id={headingId} className="text-xl font-semibold">
          {collection.name}
        </h2>
        <Link
          href={collectionHref(collection.slug)}
          aria-label={`Ver todo en ${collection.name}`}
          className="shrink-0 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          Ver todo
        </Link>
      </div>
      {/* A list, so a screen reader announces "3 elementos" instead of
          reading an undifferentiated run of links. */}
      <ul className="-mx-4 flex snap-x snap-mandatory gap-4 overflow-x-auto px-4 pb-2">
        {collection.products.map((product) => (
          <li key={product.id} className="w-40 shrink-0 snap-start sm:w-48">
            <ProductCard product={product} />
          </li>
        ))}
      </ul>
    </section>
  );
}
