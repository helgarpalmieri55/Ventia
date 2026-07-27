import { describe, expect, it, vi } from 'vitest';
import { addCartItem, CartApiError, fetchCart, removeCartItem, updateCartItem } from '../lib/cart-api';

const emptyCart = { lines: [], subtotalCents: 0, taxCents: 0 };

describe('fetchCart', () => {
  it('GETs the proxy path with credentials included', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify(emptyCart), { status: 200 }));
    const cart = await fetchCart(fetchImpl);
    expect(cart).toEqual(emptyCart);
    expect(fetchImpl).toHaveBeenCalledWith('/api/cart', {
      method: 'GET',
      credentials: 'include',
    });
  });

  it('throws CartApiError with the status and body on a non-2xx response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{"error":"TENANT_SUSPENDED"}', { status: 503 }));
    await expect(fetchCart(fetchImpl)).rejects.toThrow(CartApiError);
  });
});

describe('addCartItem', () => {
  it('POSTs to /api/cart/items with the right body and credentials', async () => {
    const cart = { lines: [{ id: 'i1', productId: 'p1', variantId: null, qty: 1, name: 'x', priceCents: 100, lineSubtotalCents: 100, lineTaxCents: 0 }], subtotalCents: 100, taxCents: 0 };
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify(cart), { status: 201 }));
    const result = await addCartItem('p1', 'v1', 2, fetchImpl);
    expect(result).toEqual(cart);
    expect(fetchImpl).toHaveBeenCalledWith('/api/cart/items', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ productId: 'p1', variantId: 'v1', qty: 2 }),
      credentials: 'include',
    });
  });

  it('sends variantId null for a no-variant product', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify(emptyCart), { status: 201 }));
    await addCartItem('p1', null, 1, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/cart/items',
      expect.objectContaining({ body: JSON.stringify({ productId: 'p1', variantId: null, qty: 1 }) }),
    );
  });

  it('surfaces a VALIDATION_FAILED 400 as a CartApiError carrying the body', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ error: 'VALIDATION_FAILED' }), { status: 400 }));
    const err = await addCartItem('p1', null, 0, fetchImpl).catch((e) => e);
    expect(err).toBeInstanceOf(CartApiError);
    expect((err as CartApiError).status).toBe(400);
    expect((err as CartApiError).body).toContain('VALIDATION_FAILED');
  });
});

describe('updateCartItem', () => {
  it('PATCHes /api/cart/items/:id with the new qty', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify(emptyCart), { status: 200 }));
    await updateCartItem('item-1', 3, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith('/api/cart/items/item-1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ qty: 3 }),
      credentials: 'include',
    });
  });
});

describe('removeCartItem', () => {
  it('DELETEs /api/cart/items/:id', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify(emptyCart), { status: 200 }));
    await removeCartItem('item-1', fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith('/api/cart/items/item-1', {
      method: 'DELETE',
      credentials: 'include',
    });
  });

  it('encodes the item id in the path', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify(emptyCart), { status: 200 }));
    await removeCartItem('a/b', fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith('/api/cart/items/a%2Fb', expect.anything());
  });
});
