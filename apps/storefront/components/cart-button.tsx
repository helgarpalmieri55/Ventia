'use client';

import { useCart } from '../lib/cart-context';

/**
 * The header's cart trigger. Split out of `CartDrawer` when the storefront
 * gained a header: the trigger used to be a `fixed right-4 top-4` circle
 * floating over the page because there was nowhere to put it, and a floating
 * circle plus a sticky header is two things fighting for the same corner.
 *
 * Still a client component (it reads live cart state), but a small one — the
 * drawer itself stays mounted once in the root layout next to `CartProvider`,
 * so this is the only extra thing the header adds to the bundle.
 */
export function CartButton() {
  const { cart, openCart } = useCart();
  const itemCount = cart?.lines.reduce((sum, line) => sum + line.qty, 0) ?? 0;

  return (
    <button
      type="button"
      onClick={openCart}
      // The count is in the label, not only in the badge: a shopper using a
      // screen reader otherwise hears "Ver carrito" with no idea whether
      // anything is in it.
      aria-label={itemCount > 0 ? `Ver carrito (${itemCount})` : 'Ver carrito'}
      className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-border text-foreground transition-colors hover:bg-muted"
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        className="h-5 w-5"
      >
        <path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z" />
        <path d="M3 6h18" />
        <path d="M16 10a4 4 0 0 1-8 0" />
      </svg>
      {itemCount > 0 ? (
        <span
          aria-hidden="true"
          className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1 text-xs font-medium text-primary-foreground"
        >
          {itemCount}
        </span>
      ) : null}
    </button>
  );
}
