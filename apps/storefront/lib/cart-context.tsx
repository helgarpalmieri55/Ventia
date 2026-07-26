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

  const addItem = React.useCallback(async (productId: string, variantId: string | null, qty: number) => {
    const next = await addCartItem(productId, variantId, qty);
    setCart(next);
  }, []);

  const updateItem = React.useCallback(async (itemId: string, qty: number) => {
    const next = await updateCartItem(itemId, qty);
    setCart(next);
  }, []);

  const removeItem = React.useCallback(async (itemId: string) => {
    const next = await removeCartItem(itemId);
    setCart(next);
  }, []);

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
