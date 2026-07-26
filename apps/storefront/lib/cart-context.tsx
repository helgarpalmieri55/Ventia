'use client';

import * as React from 'react';
import { addCartItem, fetchCart, removeCartItem, updateCartItem, type Cart } from './cart-api';

export interface CartContextValue {
  cart: Cart | null;
  loading: boolean;
  isOpen: boolean;
  openCart: () => void;
  closeCart: () => void;
  addItem: (productId: string, variantId: string | null, qty: number) => Promise<void>;
  updateItem: (itemId: string, qty: number) => Promise<void>;
  removeItem: (itemId: string) => Promise<void>;
}

const CartContext = React.createContext<CartContextValue | null>(null);

/** Wraps `{children}` in `app/layout.tsx` so the PDP's add-to-cart button and
 * `CartDrawer` (mounted once, also in the layout) share one cart state
 * without prop-drilling — this app's first client-side state, deliberately
 * minimal (no broader client-state library): just the cart itself, a
 * loading flag, and the drawer's open/closed flag. Fetches the cart once on
 * mount; every mutation re-sets `cart` from that mutation's own response
 * (the API always returns the full updated cart) rather than re-fetching
 * separately. */
export function CartProvider({ children }: { children: React.ReactNode }) {
  const [cart, setCart] = React.useState<Cart | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [isOpen, setIsOpen] = React.useState(false);

  // Serializes every mutation below through one promise chain: a shopper can
  // fire a second update (e.g. another qty change) before the first one's
  // request has even reached the server, and two concurrent PATCHes give no
  // guarantee they're processed in the order they were sent — a reviewer of
  // this task reproduced exactly that: a slower request's response arrived
  // second and overwrote a faster, later request's result, in both the
  // displayed cart AND the persisted DB row. Queuing mutations so only one
  // is ever in flight at a time removes the race entirely (nothing left to
  // reorder, client-side or server-side) rather than just picking which
  // response wins client-side, which would still leave the wrong value
  // persisted.
  const mutationQueue = React.useRef<Promise<unknown>>(Promise.resolve());

  const enqueue = React.useCallback(<T,>(run: () => Promise<T>): Promise<T> => {
    const result = mutationQueue.current.then(run, run);
    // Swallow here so one failed mutation doesn't permanently poison the
    // queue for every mutation after it — the actual error still propagates
    // to this call's own caller via the returned (un-caught) `result`.
    mutationQueue.current = result.catch(() => undefined);
    return result;
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    fetchCart()
      .then((c) => {
        if (!cancelled) setCart(c);
      })
      .catch((err) => {
        // A failed initial fetch (e.g. transient upstream error) leaves
        // `cart` null — the drawer/page render their own empty state, same
        // as a genuinely empty cart. Logged, not surfaced, since there's no
        // page-crash concern here (this runs client-side, after the page
        // itself already rendered).
        console.error('[cart] failed to load cart', err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const addItem = React.useCallback(
    (productId: string, variantId: string | null, qty: number) =>
      enqueue(async () => {
        const next = await addCartItem(productId, variantId, qty);
        setCart(next);
      }),
    [enqueue],
  );

  const updateItem = React.useCallback(
    (itemId: string, qty: number) =>
      enqueue(async () => {
        const next = await updateCartItem(itemId, qty);
        setCart(next);
      }),
    [enqueue],
  );

  const removeItem = React.useCallback(
    (itemId: string) =>
      enqueue(async () => {
        const next = await removeCartItem(itemId);
        setCart(next);
      }),
    [enqueue],
  );

  const value = React.useMemo<CartContextValue>(
    () => ({
      cart,
      loading,
      isOpen,
      openCart: () => setIsOpen(true),
      closeCart: () => setIsOpen(false),
      addItem,
      updateItem,
      removeItem,
    }),
    [cart, loading, isOpen, addItem, updateItem, removeItem],
  );

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

/** Throws outside a `CartProvider` (a real bug, not a state to render around)
 * — every page in this app is rendered under `app/layout.tsx`'s
 * `<CartProvider>`, so a component reaching `useCart()` without one means
 * it's mounted somewhere unexpected. */
export function useCart(): CartContextValue {
  const ctx = React.useContext(CartContext);
  if (!ctx) throw new Error('useCart must be used within a CartProvider');
  return ctx;
}
