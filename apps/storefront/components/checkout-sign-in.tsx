'use client';

import * as React from 'react';
import { Button, Card, CardContent } from '@ventia/ui';
import { useShopper } from '../lib/shopper-context';
import { SignInForm } from './sign-in-form';

/**
 * The sign-in offer at the top of the checkout page.
 *
 * ## Why signing in here has to work, and has to be free
 *
 * A shopper who reaches the payment step and only then remembers they have an
 * account has two bad options if this is missing: buy as a guest and lose the
 * account's history, or leave the checkout to sign in elsewhere and come back
 * to whatever is left of their basket. The API's every sign-in path merges the
 * guest cart into the account's and returns the merged result precisely so
 * this third option exists — and `SignInForm` applies that returned cart
 * through `ShopperProvider.adoptSession`, so the basket does not blink.
 *
 * ## An offer, never a step
 *
 * Collapsed by default, below nothing and in front of nothing: the checkout
 * form underneath is fully usable without ever opening this, and guest
 * checkout remains the default path through the store. It does not autofocus,
 * does not open itself, and closes back down after a successful sign-in
 * instead of navigating anywhere — a shopper half-way through a delivery
 * address must not be moved off the page.
 *
 * It takes no callback: `SignInForm` already applies the session and the
 * merged cart globally through `ShopperProvider`, and the checkout page fills
 * its own contact fields from `useShopper()` — so there is no per-call-site
 * wiring left for a caller to get wrong or forget.
 */
export function CheckoutSignIn() {
  const { shopper, loading } = useShopper();
  const [open, setOpen] = React.useState(false);

  // Nothing at all while the session resolves. A "¿ya tienes cuenta?" prompt
  // that appears and then vanishes once `/me` answers would shift the whole
  // checkout form down and then back up under someone's finger.
  if (loading) return null;

  if (shopper) {
    return (
      <p className="mb-6 text-sm text-muted-foreground">
        Entraste como <span className="font-medium text-foreground">{shopper.email}</span>.
      </p>
    );
  }

  return (
    <Card className="mb-6">
      <CardContent className="flex flex-col gap-4 pt-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm">
            ¿Ya tienes cuenta? Entra y usamos tus datos guardados. Tu carrito no se pierde.
          </p>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => setOpen((prev) => !prev)}
            aria-expanded={open}
            aria-controls="checkout-sign-in-panel"
          >
            {open ? 'Cerrar' : 'Entrar'}
          </Button>
        </div>

        {open ? (
          <div id="checkout-sign-in-panel">
            <SignInForm onSignedIn={() => setOpen(false)} />
          </div>
        ) : null}

        <p className="text-xs text-muted-foreground">
          También puedes seguir sin cuenta: llena los datos de abajo y listo.
        </p>
      </CardContent>
    </Card>
  );
}
