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

/**
 * One collection, as `GET /v1/storefront/collections/:slug` returns it: the
 * strip's shape plus the paragraph the merchant wrote.
 *
 * `descriptionMd` is only on THIS shape, never on a list row — the API sends
 * it only here, and typing the list row without it is what stops a future
 * home-page change from quietly depending on a field that request never
 * carries.
 */
export interface StorefrontCollectionDetail extends StorefrontCollection {
  descriptionMd: string;
}

/**
 * Where a collection lives in this storefront.
 *
 * One function rather than two template strings, because the strip and the
 * page's own breadcrumb both build it and a shop whose "Ver todo" link and
 * whose canonical URL disagree by one character is a 404 nobody can reproduce.
 *
 * `encodeURIComponent` is belt-and-braces: `collectionSlugSchema` in
 * `@ventia/core` already restricts a slug to `[a-z0-9-]`, so there is nothing
 * to escape today. It costs nothing and it means this helper stays correct if
 * that ever loosens.
 */
export function collectionHref(slug: string): string {
  return `/colecciones/${encodeURIComponent(slug)}`;
}

/**
 * Fetches one collection for its own page.
 *
 * `fetchStorefrontOrNull`, so `null` covers two different things — the
 * collection genuinely does not exist (404: a deleted collection, a hidden
 * one, a mistyped URL) and the API is momentarily unreachable — and the page
 * turns both into `notFound()`. That is the same choice
 * `app/categorias/[slug]/page.tsx` makes, and it is right for the same
 * reason: this fetch IS the page, so there is no partial render to protect,
 * and a 404 is a safer wrong answer than a stack trace.
 *
 * Note what it is NOT: the empty collection is not one of these cases. An
 * active collection whose products have all been archived answers 200 with an
 * empty `products`, and the page says so in words — see the API controller.
 */
export async function fetchCollection(
  tenantHost: string,
  slug: string,
  fetchImpl?: typeof fetch,
): Promise<StorefrontCollectionDetail | null> {
  return fetchStorefrontOrNull<StorefrontCollectionDetail>(
    tenantHost,
    `/v1/storefront/collections/${encodeURIComponent(slug)}`,
    fetchImpl,
  );
}
