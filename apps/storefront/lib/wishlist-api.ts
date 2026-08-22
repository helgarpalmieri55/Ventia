/**
 * Client-side typed client for a shopper's wishlist — the `/wishlist` half of
 * `/v1/storefront/account/*`, reached through the same same-origin
 * `/api/account/...` proxy as everything in `account-api.ts`.
 *
 * ## Why this is its own module but NOT its own transport
 *
 * The request helpers (`accountJson`, `accountNoContent`) are imported from
 * `account-api.ts` rather than re-implemented. Every route here sits behind
 * the same `ventia_shopper` cookie and answers the same `{error: CODE}`
 * shape, so a second copy of the transport would exist only to drift: the
 * day one of them forgot `credentials: 'include'`, the wishlist would look
 * signed-out to a signed-in shopper for reasons nothing in this file would
 * explain. `AccountApiError` is likewise re-exported rather than subclassed,
 * so a caller handling account errors already handles these.
 *
 * ## The two write routes are 204 and idempotent, and the UI depends on that
 *
 * `POST /wishlist` answers 204 whether or not the product was already saved,
 * and `DELETE /wishlist/:id` answers 204 whether or not it was there. That is
 * what lets the heart be optimistic: the desired state is "saved" or "not
 * saved", it has been reached either way, and there is no 409 for the UI to
 * apologise about when a shopper double-taps.
 */

import { AccountApiError, accountJson, accountNoContent } from './account-api';

export { AccountApiError };

/** One row of `GET /wishlist` — mirrors `WishlistEntry` in
 * `shopper-wishlist.service.ts`. `addedAt` crossed JSON as a string and is
 * deliberately left one (nothing here does date arithmetic). */
export interface WishlistItem {
  productId: string;
  name: string;
  slug: string;
  priceCents: number;
  imageUrl: string | null;
  /**
   * Whether it can still be bought.
   *
   * An archived product stays IN the list and is marked unavailable rather
   * than vanishing — the API is explicit that a list which silently loses
   * entries reads as data loss. The UI's obligation on the other side of that
   * decision is to not link an unavailable row to a PDP that would 404.
   */
  available: boolean;
  addedAt: string;
}

/** Everything the shopper saved, newest first — the API's ordering, kept. */
export async function fetchWishlist(fetchImpl: typeof fetch = fetch): Promise<WishlistItem[]> {
  const body = await accountJson<{ items: WishlistItem[] }>('/wishlist', { method: 'GET' }, fetchImpl);
  return body.items;
}

/**
 * The wishlist for a shopper who may not be signed in: `null` rather than a
 * throw on 401.
 *
 * The heart on a product page renders before anything knows whether there is
 * a session — `useShopper()` is still resolving `/me` — and a 401 there is
 * the ordinary answer for most visitors to a store, not a fault. Every other
 * failure still throws, because a 500 mapped to `null` would render an empty
 * heart at a shopper who HAS saved the product, and their tap would then
 * "save" something already saved and show nothing new.
 */
export async function fetchWishlistOrNull(
  fetchImpl: typeof fetch = fetch,
): Promise<WishlistItem[] | null> {
  try {
    return await fetchWishlist(fetchImpl);
  } catch (err) {
    // Narrowed on the STATUS, not on a code string: the guard answers
    // `SHOPPER_UNAUTHORIZED` today, and a rename of that constant must not
    // silently turn "no session" back into a thrown error on a public page.
    if (err instanceof AccountApiError && err.status === 401) return null;
    throw err;
  }
}

/** Saves a product. Idempotent — 204 whether or not it was already there.
 * Throws `AccountApiError(409, 'WISHLIST_FULL')` at the cap, and
 * `(404, 'PRODUCT_NOT_FOUND')` for a product that is not this store's. */
export async function addToWishlist(productId: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  await accountNoContent(
    '/wishlist',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ productId }) },
    fetchImpl,
  );
}

/** Removes a product. Also idempotent. */
export async function removeFromWishlist(
  productId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  await accountNoContent(
    `/wishlist/${encodeURIComponent(productId)}`,
    { method: 'DELETE' },
    fetchImpl,
  );
}

/** Copy for a wishlist write that failed. `WISHLIST_FULL` is the one failure
 * a shopper can act on, so it says what to do; everything else is a fault and
 * says so rather than blaming the shopper for a server problem. */
export const WISHLIST_FULL_MESSAGE =
  'Tu lista de favoritos está llena. Quita algo antes de guardar otro producto.';
export const WISHLIST_GENERIC_ERROR = 'No pudimos actualizar tus favoritos. Intenta de nuevo.';
/** Shown when the session expired between the page loading and the tap. Not
 * "algo salió mal": the shopper can fix this, and telling them to sign in
 * again is the only thing that will. */
export const WISHLIST_SIGNED_OUT = 'Tu sesión venció. Entra de nuevo para guardar este producto.';

export function wishlistErrorMessage(err: unknown): string {
  if (err instanceof AccountApiError) {
    if (err.code === 'WISHLIST_FULL') return WISHLIST_FULL_MESSAGE;
    if (err.status === 401) return WISHLIST_SIGNED_OUT;
  }
  return WISHLIST_GENERIC_ERROR;
}
