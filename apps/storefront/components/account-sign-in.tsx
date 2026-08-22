'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Alert, Card, CardContent, CardHeader, CardTitle, Spinner } from '@ventia/ui';
import { consumeMagicLink } from '../lib/account-api';
import { linkErrorMessage } from '../lib/account-form';
import { useShopper } from '../lib/shopper-context';
import { SignInForm } from './sign-in-form';

/**
 * `/cuenta/entrar` — the sign-in screen, and also the landing spot for the
 * `?token=` in the "tu enlace para entrar" and "ya tienes una cuenta" emails
 * (`services/api/src/mailer/shopper-emails.ts` builds both against this
 * path). One page for both because they are the same intent: the shopper is
 * trying to get in, with or without a password in hand.
 */
export function AccountSignIn({ token }: { token: string | null }) {
  const router = useRouter();
  const { adoptSession } = useShopper();
  const [consuming, setConsuming] = React.useState(token !== null);
  const [linkError, setLinkError] = React.useState<string | null>(null);

  // A magic link is single-use and spent the moment it is redeemed, so this
  // effect must run exactly once per token. React's StrictMode double-invokes
  // effects in development; without this guard the second invocation would
  // redeem an already-spent token and paint "este enlace ya no sirve" over a
  // sign-in that had just succeeded.
  const redeemed = React.useRef(false);

  React.useEffect(() => {
    if (token === null || redeemed.current) return;
    redeemed.current = true;
    let cancelled = false;
    consumeMagicLink(token)
      .then(async (session) => {
        await adoptSession(session);
        if (cancelled) return;
        // `replace`, not `push`: the token is now spent, so leaving the URL
        // that carries it in the back stack means a back button that lands on
        // a guaranteed "este enlace ya no sirve".
        router.replace('/cuenta');
      })
      .catch((err) => {
        if (cancelled) return;
        setLinkError(linkErrorMessage(err));
        setConsuming(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token, adoptSession, router]);

  if (consuming) {
    return (
      <main className="mx-auto max-w-md px-4 py-8">
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner /> Entrando…
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-md px-4 py-8">
      <h1 className="mb-6 text-2xl font-semibold">Entrar</h1>

      {/* Shown above the form, not instead of it: a dead link should leave the
          shopper one field away from getting in, not at a dead end. */}
      {linkError ? (
        <Alert variant="error" className="mb-6">
          {linkError}
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Tu cuenta</CardTitle>
        </CardHeader>
        <CardContent>
          <SignInForm autoFocusEmail onSignedIn={() => router.replace('/cuenta')}>
            <p className="text-sm text-muted-foreground">
              ¿No tienes cuenta?{' '}
              <Link href="/cuenta/registrarse" className="underline">
                Créala acá
              </Link>
              .
            </p>
          </SignInForm>
        </CardContent>
      </Card>

      {/* Guest checkout is not a fallback here, it is the default path — this
          line exists so nobody reads a sign-in screen as a wall in front of
          the store. */}
      <p className="mt-6 text-sm text-muted-foreground">
        No necesitas cuenta para comprar: puedes pagar como invitado cuando quieras.
      </p>
    </main>
  );
}
