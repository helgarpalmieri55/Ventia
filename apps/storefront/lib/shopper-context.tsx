'use client';

import * as React from 'react';
import { fetchMe, signOut as signOutRequest, type Shopper, type ShopperSession } from './account-api';
import { useCart } from './cart-context';

export interface ShopperContextValue {
  /** `null` means "not signed in", which is the normal state for most
   * visitors — an account is an offer here, never a gate. */
  shopper: Shopper | null;
  /** True until the first `/me` answers. The header renders nothing at all
   * while this is true rather than guessing: flashing "Entrar" at a shopper
   * who IS signed in, then swapping it for their name, looks like the session
   * broke and came back. */
  loading: boolean;
  /**
   * Records a session the API just established, from ANY of the four paths
   * that establish one (password sign-in, magic link, password reset, and the
   * checkout page's inline form).
   *
   * Takes the whole `ShopperSession` — shopper AND cart — rather than just
   * the shopper, so the merged cart the server returned is applied here, in
   * one place, instead of at four call sites where one of them would
   * eventually forget and refetch. See `cart-context.tsx`'s `adoptCart`.
   */
  adoptSession: (session: ShopperSession) => Promise<void>;
  /** Replaces the local copy after a profile edit. */
  setShopper: (shopper: Shopper) => void;
  /** Re-reads `/me`. Needed when the account changed somewhere this client
   * could not see it happen — confirming an address on `/cuenta/verificar`,
   * which flips `emailVerified` server-side without touching this state. */
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

const ShopperContext = React.createContext<ShopperContextValue | null>(null);

/**
 * Who is signed in, for the whole storefront.
 *
 * ## Why this asks the server instead of reading a cookie
 *
 * `ventia_shopper` is HttpOnly — invisible to JavaScript by design, so that
 * an XSS on a product page cannot walk off with a session. There is
 * therefore no client-side way to know whether one exists except to ask, so
 * this fetches `/me` once on mount, exactly as `CartProvider` fetches the
 * cart. A 401 is not an error here; it is the answer "no session", and it is
 * the answer for most visitors.
 *
 * ## Mounted INSIDE `CartProvider`
 *
 * Not a stylistic ordering: `adoptSession` hands the sign-in response's cart
 * to `useCart().adoptCart`, so the cart context has to already exist above
 * it. `app/layout.tsx` nests them that way and the `useCart()` call below
 * throws loudly if that is ever reversed.
 */
export function ShopperProvider({ children }: { children: React.ReactNode }) {
  const { adoptCart } = useCart();
  const [shopper, setShopperState] = React.useState<Shopper | null>(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    let cancelled = false;
    fetchMe()
      .then((me) => {
        if (!cancelled) setShopperState(me);
      })
      .catch((err) => {
        // Only a genuine fault reaches here — `fetchMe` already maps 401 to
        // `null`. Leaves `shopper` null, i.e. the store renders exactly as it
        // does for a guest, which is a complete and usable storefront.
        console.error('[account] failed to resolve session', err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const adoptSession = React.useCallback(
    async (session: ShopperSession) => {
      setShopperState(session.shopper);
      await adoptCart(session.cart);
    },
    [adoptCart],
  );

  const refresh = React.useCallback(async () => {
    setShopperState(await fetchMe());
  }, []);

  const signOut = React.useCallback(async () => {
    await signOutRequest();
    setShopperState(null);
    // The cart is deliberately left alone. The API clears `ventia_shopper`
    // and nothing else, so the basket in the browser survives sign-out — and
    // it should: someone signing out of a shared phone mid-purchase has not
    // asked to throw away what they were buying. Clearing it here would also
    // put this client's state at odds with the cookie that is still set.
  }, []);

  const value = React.useMemo<ShopperContextValue>(
    () => ({ shopper, loading, adoptSession, setShopper: setShopperState, refresh, signOut }),
    [shopper, loading, adoptSession, refresh, signOut],
  );

  return <ShopperContext.Provider value={value}>{children}</ShopperContext.Provider>;
}

/** Throws outside a `ShopperProvider` — every page renders under
 * `app/layout.tsx`'s, so reaching this without one is a mounting bug, not a
 * state to render around. */
export function useShopper(): ShopperContextValue {
  const ctx = React.useContext(ShopperContext);
  if (!ctx) throw new Error('useShopper must be used within a ShopperProvider');
  return ctx;
}
