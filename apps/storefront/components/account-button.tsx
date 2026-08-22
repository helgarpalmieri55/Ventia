'use client';

import Link from 'next/link';
import { useShopper } from '../lib/shopper-context';

/**
 * The header's way into an account: `/cuenta` when there is a session,
 * `/cuenta/entrar` when there is not.
 *
 * ## Why it renders an empty slot while the session resolves
 *
 * The session cookie is HttpOnly, so the only way to know who is signed in is
 * to ask the API (`ShopperProvider`), which means the first paint genuinely
 * does not know. Guessing "Entrar" and swapping it for the shopper's name a
 * moment later reads as a session that broke and recovered — and worse, a
 * shopper who taps during that window lands on a sign-in form while already
 * signed in. The placeholder keeps the header's width stable so nothing
 * shifts sideways when the answer arrives.
 *
 * The name is not shown, only "Mi cuenta". A person's name across the top of
 * a shared or shop-counter phone is a small privacy leak with no upside, and
 * it would resize the header depending on how long their name is.
 */
export function AccountButton() {
  const { shopper, loading } = useShopper();

  if (loading) return <span aria-hidden="true" className="h-10 w-10 shrink-0" />;

  const signedIn = shopper !== null;

  return (
    <Link
      href={signedIn ? '/cuenta' : '/cuenta/entrar'}
      aria-label={signedIn ? 'Mi cuenta' : 'Entrar a mi cuenta'}
      title={signedIn ? 'Mi cuenta' : 'Entrar'}
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
        <circle cx="12" cy="8" r="4" />
        <path d="M4 21a8 8 0 0 1 16 0" />
      </svg>
      {/* A filled dot, not a tick or a second icon: it only has to answer
          "does this store know me right now?" at a glance. */}
      {signedIn ? (
        <span
          aria-hidden="true"
          className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border border-background bg-primary"
        />
      ) : null}
    </Link>
  );
}
