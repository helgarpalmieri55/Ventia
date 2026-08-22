import { apiFetch } from './api';

/**
 * Client for `/v1/admin/collections` — the Colecciones section, plus the pure
 * logic the page needs.
 *
 * Types are hand-written mirrors of the server's responses, same reason as
 * `customers-api.ts` and `domains-api.ts`: this app cannot import from
 * `services/api/src`. Every shape here was read off
 * `services/api/src/collections/collections.service.ts`:
 *
 *   GET    /v1/admin/collections                     -> CollectionSummary[]
 *   POST   /v1/admin/collections                     -> 201 CollectionDetail
 *   GET    /v1/admin/collections/:id                 -> CollectionDetail
 *   PATCH  /v1/admin/collections/:id                 -> CollectionDetail
 *   DELETE /v1/admin/collections/:id                 -> 204
 *   PUT    /v1/admin/collections/:id/products        -> CollectionDetail  (order + membership)
 *   POST   /v1/admin/collections/:id/products        -> CollectionDetail  (append)
 *   DELETE /v1/admin/collections/:id/products/:pid   -> 204
 *
 * Every error code these routes emit (VALIDATION_FAILED, SLUG_TAKEN,
 * NOT_FOUND) is already in `lib/errors.ts`. That is deliberate on the API
 * side: collections introduce no new error vocabulary, so the merchant never
 * meets a raw code this app has no Spanish for.
 */

/** The page's route. Single source of truth, as `DOMAINS_PATH` is for its. */
export const COLLECTIONS_PATH = '/colecciones';

export type ProductStatus = 'draft' | 'active' | 'archived';

export interface CollectionSummary {
  id: string;
  name: string;
  slug: string;
  descriptionMd: string;
  /** Which strip comes first in the storefront. The merchant's own order. */
  position: number;
  isActive: boolean;
  /** Every member, whatever its status. */
  productCount: number;
  /** The members a shopper can actually reach. See {@link storefrontStatus}. */
  activeProductCount: number;
}

export interface CollectionMember {
  productId: string;
  position: number;
  name: string;
  slug: string;
  /** Archived and draft members are listed here and hidden in the storefront
   * — this field is what lets the page say which is which. */
  status: ProductStatus;
  priceCents: number;
  thumbnailUrl: string | null;
}

export interface CollectionDetail extends CollectionSummary {
  /** In the merchant's order, exactly as the API returned it. Never re-sorted
   * client-side: the server's order IS the storefront's order. */
  products: CollectionMember[];
}

export function listCollections(): Promise<CollectionSummary[]> {
  return apiFetch<CollectionSummary[]>('/v1/admin/collections');
}

export function getCollection(id: string): Promise<CollectionDetail> {
  return apiFetch<CollectionDetail>(`/v1/admin/collections/${id}`);
}

export function createCollection(input: { name: string; slug?: string }): Promise<CollectionDetail> {
  return apiFetch<CollectionDetail>('/v1/admin/collections', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updateCollection(
  id: string,
  input: Partial<{ name: string; slug: string; descriptionMd: string; position: number; isActive: boolean }>,
): Promise<CollectionDetail> {
  return apiFetch<CollectionDetail>(`/v1/admin/collections/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function deleteCollection(id: string): Promise<void> {
  return apiFetch<void>(`/v1/admin/collections/${id}`, { method: 'DELETE' });
}

/** Appends products, leaving the existing arrangement untouched. Safe from a
 * stale tab in a way {@link setCollectionProducts} is not — which is why the
 * picker uses this one. */
export function addCollectionProducts(id: string, productIds: string[]): Promise<CollectionDetail> {
  return apiFetch<CollectionDetail>(`/v1/admin/collections/${id}/products`, {
    method: 'POST',
    body: JSON.stringify({ productIds }),
  });
}

/**
 * Saves the whole order in ONE request.
 *
 * This is the reason the API has a PUT: a merchant who moved three products
 * sends one array, not three PATCHes that can half-apply and leave the live
 * storefront in an order nobody chose.
 */
export function setCollectionProducts(id: string, productIds: string[]): Promise<CollectionDetail> {
  return apiFetch<CollectionDetail>(`/v1/admin/collections/${id}/products`, {
    method: 'PUT',
    body: JSON.stringify({ productIds }),
  });
}

export function removeCollectionProduct(id: string, productId: string): Promise<void> {
  return apiFetch<void>(`/v1/admin/collections/${id}/products/${productId}`, { method: 'DELETE' });
}

// --- pure logic (this app's tests run in vitest's `node` environment — no
// DOM — so anything that can be wrong lives here rather than in the page) ---

/**
 * Moves the item at `index` one place towards the front (`-1`) or the back
 * (`+1`), returning a new array.
 *
 * Out-of-range moves return the array unchanged rather than throwing or
 * wrapping around. The buttons at the ends of the list are disabled, so the
 * only ways to get here are a double-click racing a re-render and a keyboard
 * user on a stale row — neither of which should throw away the merchant's
 * arrangement, and neither of which should teleport the first product to the
 * bottom of the strip.
 */
export function moveBy<T>(items: readonly T[], index: number, delta: -1 | 1): T[] {
  const target = index + delta;
  if (index < 0 || index >= items.length) return [...items];
  if (target < 0 || target >= items.length) return [...items];
  const next = [...items];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

/** Whether the merchant has actually rearranged anything, compared position
 * by position. Guards the "Guardar orden" button: a PUT that rewrites the
 * membership to what it already was is a pointless write, and — because a
 * full replace clobbers whatever a colleague added meanwhile — a genuinely
 * harmful one. */
export function orderChanged(original: readonly CollectionMember[], current: readonly CollectionMember[]): boolean {
  if (original.length !== current.length) return true;
  return current.some((member, index) => member.productId !== original[index].productId);
}

/**
 * What the storefront will do with this collection, in the merchant's own
 * words.
 *
 * This is the one place the admin explains the API's "empty strips are
 * omitted entirely" rule (see
 * `services/api/src/collections/storefront-collections.controller.ts`). A
 * merchant whose "Ofertas" row disappeared the day their sale ended must be
 * able to read WHY here — "8 productos, ninguno disponible" — instead of
 * concluding the store is broken.
 */
export function storefrontStatus(collection: {
  isActive: boolean;
  productCount: number;
  activeProductCount: number;
}): { visible: boolean; label: string } {
  // Checked first, and on purpose: a hidden collection full of archived
  // products is hidden because the merchant hid it. Leading with the
  // product-availability explanation would be blaming the catalog for a
  // decision they made.
  if (!collection.isActive) {
    return { visible: false, label: 'Oculta: no aparece en la tienda' };
  }
  if (collection.productCount === 0) {
    return { visible: false, label: 'Sin productos: no aparece en la tienda' };
  }
  if (collection.activeProductCount === 0) {
    return {
      visible: false,
      label: `${plural(collection.productCount, 'producto', 'productos')}, ninguno disponible: no aparece en la tienda`,
    };
  }
  const hidden = collection.productCount - collection.activeProductCount;
  const visible = plural(collection.activeProductCount, 'producto', 'productos');
  return {
    visible: true,
    label: hidden > 0 ? `Visible con ${visible} (${hidden} sin publicar)` : `Visible con ${visible}`,
  };
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** es-CO label for a member the shopper cannot see, or `null` when there is
 * nothing to warn about. Draft and archived are told apart because the fix is
 * different: one is published from the product page, the other is un-archived
 * or removed from the collection. */
export function memberWarning(status: ProductStatus): string | null {
  if (status === 'archived') return 'Archivado: no se muestra en la tienda';
  if (status === 'draft') return 'Borrador: no se muestra en la tienda';
  return null;
}
