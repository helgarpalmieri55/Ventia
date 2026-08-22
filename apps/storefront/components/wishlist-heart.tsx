'use client';

import * as React from 'react';
import Link from 'next/link';
import { Spinner } from '@ventia/ui';
import { useShopper } from '../lib/shopper-context';
import {
  addToWishlist,
  fetchWishlistOrNull,
  removeFromWishlist,
  wishlistErrorMessage,
} from '../lib/wishlist-api';

export interface WishlistHeartProps {
  productId: string;
  /** Only for the accessible name — "Guardar Camisa de lino en favoritos"
   * says what the control does; a bare "Guardar" on a page with an "Agregar
   * al carrito" next to it does not. */
  productName: string;
}

/**
 * The heart on a product page.
 *
 * ## Three states, and the signed-out one is the interesting one
 *
 * A guest gets a heart that WORKS — it is not disabled and it does not
 * silently do nothing. Tapping it opens a one-line prompt with a link to
 * sign in. A disabled control would be the worst of the options available:
 * the shopper cannot tell whether the store has no wishlist, whether the page
 * is broken, or whether they need an account, and nothing on screen tells
 * them. Silently no-op'ing is worse still — they would believe the product
 * was saved and find an empty list later.
 *
 * ## Nothing renders until `/me` has answered
 *
 * Same rule the header follows: flashing an empty heart at a shopper who
 * saved this product, then filling it in, looks like their save was lost.
 * While the session is resolving this renders a spinner in the heart's place,
 * so the layout does not jump either.
 *
 * ## Membership comes from the list, because there is no `has` endpoint
 *
 * `ShopperWishlistService.has` exists but no route reaches it, so the only
 * way to know whether THIS product is saved is `GET /wishlist`. That is a
 * list capped at 200 rows of small objects, fetched once per PDP for
 * signed-in shoppers only — cheap enough that adding an endpoint was not
 * worth it, and honest about what the API actually offers.
 */
export function WishlistHeart({ productId, productName }: WishlistHeartProps) {
  const { shopper, loading: sessionLoading } = useShopper();

  const [saved, setSaved] = React.useState<boolean | null>(null);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [promptSignIn, setPromptSignIn] = React.useState(false);

  React.useEffect(() => {
    if (sessionLoading) return;
    if (!shopper) {
      // A guest has no wishlist to be in. Set explicitly rather than left
      // `null` so the heart renders (empty, and tappable) instead of
      // spinning forever.
      setSaved(false);
      return;
    }
    let cancelled = false;
    fetchWishlistOrNull()
      .then((items) => {
        if (cancelled) return;
        // `null` is "no session after all" — the cookie expired between the
        // `/me` this component trusted and this request. Renders as not
        // saved, which is true.
        setSaved(items === null ? false : items.some((i) => i.productId === productId));
      })
      .catch((err) => {
        if (cancelled) return;
        // Leaves `saved` null: the heart stays in its resolving state rather
        // than claiming "not saved", because a shopper who taps an
        // incorrectly-empty heart on a product they already saved gets no
        // feedback at all (the API's add is idempotent and answers 204).
        console.error('[wishlist] failed to resolve state for product', err);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionLoading, shopper, productId]);

  async function toggle() {
    if (!shopper) {
      setPromptSignIn(true);
      return;
    }
    if (saved === null) return;

    const next = !saved;
    setError(null);
    setPending(true);
    // Optimistic, and reverted on failure. Both writes are idempotent 204s,
    // so the only way to be wrong here is a transport failure — and the heart
    // going back to where it was, with a message, is exactly right then.
    setSaved(next);
    try {
      if (next) await addToWishlist(productId);
      else await removeFromWishlist(productId);
    } catch (err) {
      console.error('[wishlist] failed to toggle', err);
      setSaved(!next);
      setError(wishlistErrorMessage(err));
    } finally {
      setPending(false);
    }
  }

  if (sessionLoading || saved === null) {
    return (
      <div className="flex h-10 w-fit items-center gap-2 text-sm text-muted-foreground" aria-hidden>
        <Spinner />
      </div>
    );
  }

  const label = saved
    ? `Quitar ${productName} de favoritos`
    : `Guardar ${productName} en favoritos`;

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={() => void toggle()}
        disabled={pending}
        // `aria-pressed` rather than a label that only changes: this is a
        // toggle, and a screen reader should be able to hear its STATE
        // without re-reading the name. For a guest it is honestly `false` —
        // nothing is saved, and tapping opens the prompt.
        aria-pressed={saved}
        aria-label={label}
        title={label}
        className="inline-flex h-10 w-fit items-center gap-2 rounded-md border border-border px-3 text-sm font-medium transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-50"
      >
        <HeartIcon filled={saved} />
        {saved ? 'Guardado' : 'Guardar'}
      </button>

      {promptSignIn && !shopper ? (
        <p className="text-sm text-muted-foreground">
          Entra a tu cuenta para guardar productos en favoritos.{' '}
          <Link href="/cuenta/entrar" className="underline underline-offset-4">
            Entrar
          </Link>
        </p>
      ) : null}

      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}

/** Inline SVG rather than an icon dependency — this app has none, and one
 * path is not a reason to add one. `fill`/`stroke` follow the state so the
 * difference is visible without relying on colour alone. */
function HeartIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      aria-hidden="true"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1L12 21l7.7-7.6 1.1-1a5.5 5.5 0 0 0 0-7.8z" />
    </svg>
  );
}
