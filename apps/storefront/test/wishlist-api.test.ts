import { describe, expect, it, vi } from 'vitest';
import {
  AccountApiError,
  WISHLIST_FULL_MESSAGE,
  WISHLIST_GENERIC_ERROR,
  WISHLIST_SIGNED_OUT,
  addToWishlist,
  fetchWishlist,
  fetchWishlistOrNull,
  removeFromWishlist,
  wishlistErrorMessage,
  type WishlistItem,
} from '../lib/wishlist-api';

// Same shape as `account-api.test.ts`: a mocked `fetchImpl` asserting path,
// method, body and credentials. This app's vitest runs under Node with no
// DOM, so request shaping is where the wishlist's testable logic lives.

const ITEM: WishlistItem = {
  productId: '11111111-1111-4111-8111-111111111111',
  name: 'Camisa de lino',
  slug: 'camisa-de-lino',
  priceCents: 45900,
  imageUrl: 'https://cdn.example.com/1.jpg',
  available: true,
  addedAt: '2026-01-01T00:00:00.000Z',
};

function ok(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));
}

function noContent() {
  return vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
}

function failing(status: number, code: string) {
  return vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: code }), { status }));
}

describe('fetchWishlist', () => {
  it('GETs the wishlist path with credentials and unwraps `items`', async () => {
    const fetchImpl = ok({ items: [ITEM] });
    await expect(fetchWishlist(fetchImpl)).resolves.toEqual([ITEM]);
    expect(fetchImpl).toHaveBeenCalledWith('/api/account/wishlist', {
      method: 'GET',
      credentials: 'include',
    });
  });

  it('preserves the API ordering rather than re-sorting', async () => {
    const older = { ...ITEM, productId: 'p-old', addedAt: '2025-01-01T00:00:00.000Z' };
    const fetchImpl = ok({ items: [ITEM, older] });
    const rows = await fetchWishlist(fetchImpl);
    expect(rows.map((r) => r.productId)).toEqual([ITEM.productId, 'p-old']);
  });

  it('throws an AccountApiError carrying the API error code', async () => {
    const fetchImpl = failing(401, 'SHOPPER_UNAUTHORIZED');
    await expect(fetchWishlist(fetchImpl)).rejects.toBeInstanceOf(AccountApiError);
  });
});

describe('fetchWishlistOrNull', () => {
  it('answers null for a shopper with no session, because that is the normal case', async () => {
    // Most visitors to a store are not signed in; the heart must render for
    // them, not throw on a public product page.
    await expect(fetchWishlistOrNull(failing(401, 'SHOPPER_UNAUTHORIZED'))).resolves.toBeNull();
  });

  it('still throws on a genuine fault rather than pretending nothing is saved', async () => {
    // A 500 mapped to null would show an empty heart to a shopper who HAS
    // saved the product, and their tap would then do nothing visible.
    await expect(fetchWishlistOrNull(failing(500, 'UNKNOWN'))).rejects.toBeInstanceOf(AccountApiError);
  });

  it('returns the items when there is a session', async () => {
    await expect(fetchWishlistOrNull(ok({ items: [ITEM] }))).resolves.toEqual([ITEM]);
  });

  it('distinguishes an empty list from no session', async () => {
    // `[]` means "signed in, saved nothing"; `null` means "not signed in".
    // Collapsing them would make the heart prompt a signed-in shopper to sign
    // in again.
    await expect(fetchWishlistOrNull(ok({ items: [] }))).resolves.toEqual([]);
  });
});

describe('addToWishlist', () => {
  it('POSTs the productId as JSON with credentials included', async () => {
    const fetchImpl = noContent();
    await addToWishlist(ITEM.productId, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith('/api/account/wishlist', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ productId: ITEM.productId }),
      credentials: 'include',
    });
  });

  it('resolves on the 204 without trying to parse a body', async () => {
    // A 204 has no body; calling `res.json()` on one throws a SyntaxError
    // that would surface to the shopper as a failure on an operation that
    // actually succeeded.
    await expect(addToWishlist(ITEM.productId, noContent())).resolves.toBeUndefined();
  });

  it('surfaces WISHLIST_FULL as a code the UI can act on', async () => {
    await expect(addToWishlist(ITEM.productId, failing(409, 'WISHLIST_FULL'))).rejects.toMatchObject({
      status: 409,
      code: 'WISHLIST_FULL',
    });
  });

  it('surfaces PRODUCT_NOT_FOUND for a product that is not this store’s', async () => {
    await expect(addToWishlist(ITEM.productId, failing(404, 'PRODUCT_NOT_FOUND'))).rejects.toMatchObject({
      code: 'PRODUCT_NOT_FOUND',
    });
  });
});

describe('removeFromWishlist', () => {
  it('DELETEs the product path with credentials included', async () => {
    const fetchImpl = noContent();
    await removeFromWishlist(ITEM.productId, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith(`/api/account/wishlist/${ITEM.productId}`, {
      method: 'DELETE',
      credentials: 'include',
    });
  });

  it('encodes the id into the path rather than interpolating it raw', async () => {
    const fetchImpl = noContent();
    await removeFromWishlist('a/../b', fetchImpl);
    // The proxy's own `isSafeProxyPath` would refuse the decoded form; this
    // makes sure a stray id cannot climb out of the wishlist prefix here
    // either.
    expect(fetchImpl.mock.calls[0][0]).toBe('/api/account/wishlist/a%2F..%2Fb');
  });

  it('resolves on the 204 whether or not the item was there', async () => {
    await expect(removeFromWishlist(ITEM.productId, noContent())).resolves.toBeUndefined();
  });
});

describe('wishlistErrorMessage', () => {
  it('tells the shopper what to do about a full list', () => {
    expect(wishlistErrorMessage(new AccountApiError(409, 'WISHLIST_FULL'))).toBe(WISHLIST_FULL_MESSAGE);
  });

  it('tells a shopper whose session expired to sign in again, not that something broke', () => {
    expect(wishlistErrorMessage(new AccountApiError(401, 'SHOPPER_UNAUTHORIZED'))).toBe(WISHLIST_SIGNED_OUT);
  });

  it('falls back to a generic message for a fault the shopper cannot act on', () => {
    expect(wishlistErrorMessage(new AccountApiError(500, 'UNKNOWN'))).toBe(WISHLIST_GENERIC_ERROR);
    expect(wishlistErrorMessage(new Error('network down'))).toBe(WISHLIST_GENERIC_ERROR);
  });

  it('never blames the shopper for a server fault', () => {
    // The generic copy must not read as "you did something wrong" — it is
    // shown for 500s, and a shopper retrying a broken server should not be
    // told their list is full.
    expect(WISHLIST_GENERIC_ERROR).not.toContain('llena');
  });
});
