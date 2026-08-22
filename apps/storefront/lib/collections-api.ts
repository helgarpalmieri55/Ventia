import { fetchStorefrontOrNull } from './storefront-api';
import type { ProductCardData } from '../components/product-card';

/**
 * `GET /v1/storefront/collections` — the merchant's curated rows ("Nuevos",
 * "Ofertas": docs/design-gap.md §3), and the pure rules the home page applies
 * to them.
 *
 * As with `category-tree.ts`, everything here that can be *wrong* is a pure
 * function over the API's rows: this app has no DOM test runner (vitest runs
 * in `node` — see vitest.config.ts), so `collection-strip.tsx` cannot be
 * tested, while "which strips are worth drawing, and how many tiles each one
 * gets" can be. See test/collections-api.test.ts.
 */

/** One product tile in a strip. A superset of {@link ProductCardData}, so the
 * existing `ProductCard` renders it with no mapping — the same trick
 * `app/page.tsx` already relies on for `GET /v1/storefront/products`. There is
 * one product card in this store and this is not a second one. */
export interface StorefrontCollectionProduct extends ProductCardData {
  id: string;
  inStock: boolean;
}

/** A row of `GET /v1/storefront/collections`. No `descriptionMd`: the API
 * deliberately does not send one, because a strip is a heading and a row of
 * tiles and there is nowhere to put a paragraph. */
export interface StorefrontCollection {
  id: string;
  name: string;
  slug: string;
  /** In the merchant's order, already filtered to buyable products and
   * capped by the API. */
  products: StorefrontCollectionProduct[];
}

/**
 * The most tiles one strip renders.
 *
 * The API already caps its own response, so this is a second, independent
 * bound rather than the enforcement — deliberately so. A strip is a
 * horizontally scrolling row and every tile is an image request; if a future
 * caller (or an older deployed API answering a newer storefront) ever returns
 * an uncapped collection, the failure should be a shorter row, not a home
 * page that opens two hundred connections on a phone.
 */
export const STRIP_MAX_PRODUCTS = 12;

/**
 * The strips actually worth drawing, in the merchant's order.
 *
 * Drops any collection with no products, which is the storefront half of a
 * rule the API already applies (`storefront-collections.controller.ts` omits
 * empty collections, having first hidden archived and draft products). Both
 * ends enforce it because the consequence is a shopper-visible defect and the
 * two ends fail differently: the API protects the payload, this protects the
 * render. A heading like "Ofertas" floating over blank space reads as a
 * broken page, and the two ways to produce one — a collection created and not
 * filled yet, and one whose whole contents were archived when the sale ended
 * — are both ordinary days in a small store.
 *
 * Accepts `null` because that is what `fetchStorefrontOrNull` returns when
 * the API is unreachable: a home page missing its curated rows is a
 * degradation, not a crash.
 */
export function visibleCollections(rows: StorefrontCollection[] | null): StorefrontCollection[] {
  if (!rows) return [];
  return rows
    .filter((collection) => collection.products.length > 0)
    .map((collection) =>
      // Only rebuilt when the cap actually bites, so the common case keeps
      // the object identity the API handed us.
      collection.products.length <= STRIP_MAX_PRODUCTS
        ? collection
        : { ...collection, products: collection.products.slice(0, STRIP_MAX_PRODUCTS) },
    );
}

/** Fetches the store's active collections. `fetchStorefrontOrNull`, not
 * `fetchStorefront`: a transient upstream error must cost the home page its
 * curated rows, not the whole render — the same choice the categories and
 * products fetches on that page already make. */
export async function fetchCollections(
  tenantHost: string,
  fetchImpl?: typeof fetch,
): Promise<StorefrontCollection[] | null> {
  return fetchStorefrontOrNull<StorefrontCollection[]>(tenantHost, '/v1/storefront/collections', fetchImpl);
}
