'use client';

import * as React from 'react';
import { addCartItem, fetchCart, removeCartItem, updateCartItem, type Cart } from './cart-api';
import { createMutationQueue } from './mutation-queue';

export interface CartContextValue {
  cart: Cart | null;
  loading: boolean;
  isOpen: boolean;
  openCart: () => void;
  closeCart: () => void;
  addItem: (productId: string, variantId: string | null, qty: number) => Promise<void>;
  updateItem: (itemId: string, qty: number) => Promise<void>;
  removeItem: (itemId: string) => Promise<void>;
  /** Resets the LOCAL cart state only — no API call. Call this right after a
   * successful `submitCheckout()`: the checkout endpoint already deletes the
   * server-side `Cart` row (and clears the `ventia_cart` cookie) as part of a
   * successful checkout, so there's nothing left to ask the server for. This
   * just makes the client's own state (drawer badge count, `/carrito` page)
   * match that reality immediately, without waiting on/triggering a refetch. */
  clearCart: () => void;
  /**
   * Replaces the local cart with one the SERVER just handed back outside the
   * mutations above — specifically the `cart` in a sign-in response
   * (`lib/account-api.ts`'s `ShopperSession`).
   *
   * Deliberately not a `refreshCart()` call at those call sites. Signing in
   * merges the guest basket into the account's and re-points `ventia_cart` at
   * the result, and the sign-in response already IS that merged cart; a blind
   * refetch would spend a round trip to learn what it was just told, and race
   * the cookie it depends on while doing it. A shopper who signs in on the
   * checkout page and watches their basket flicker or empty has been handed a
   * reason to abandon at the last screen — which is the entire thing the
   * merge exists to prevent.
   *
   * Goes through the same queue as the mutations so a qty change that was
   * already in flight when the shopper signed in cannot land afterwards and
   * overwrite the merged cart with the pre-merge one.
   */
  adoptCart: (cart: Cart) => Promise<void>;
  /** Re-reads the cart from the server. Needed when the cart changed WITHOUT
   * going through one of the mutations above — which happens exactly once, on
   * adopting an agent-built cart (`/carrito?c=…`), where the server swaps
   * which cart the `ventia_cart` cookie points at and this client's copy is
   * suddenly the wrong cart entirely. Goes through the same mutation queue so
   * it cannot interleave with an in-flight qty change. */
  refreshCart: () => Promise<void>;
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

  // Serializes every mutation below so only one is ever in flight at a time:
  // a shopper can fire a second update (e.g. another qty change) before the
  // first one's request has even reached the server, and two concurrent
  // PATCHes give no guarantee they're processed in the order they were sent
  // — a reviewer of this task reproduced exactly that, a slower request's
  // response arriving second and overwriting a faster, later request's
  // result in both the displayed cart AND the persisted DB row. See
  // lib/mutation-queue.ts for the queue itself and why it's a separate,
  // directly-testable module rather than inlined here.
  const enqueue = React.useMemo(() => createMutationQueue(), []);

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

  const clearCart = React.useCallback(() => {
    setCart({ lines: [], subtotalCents: 0, taxCents: 0 });
  }, []);

  const adoptCart = React.useCallback(
    (next: Cart) =>
      enqueue(async () => {
        setCart(next);
      }),
    [enqueue],
  );

  const refreshCart = React.useCallback(
    () =>
      enqueue(async () => {
        setCart(await fetchCart());
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
      clearCart,
      adoptCart,
      refreshCart,
    }),
    [cart, loading, isOpen, addItem, updateItem, removeItem, clearCart, adoptCart, refreshCart],
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
