'use client';

import * as React from 'react';
import { Alert, Button, Spinner } from '@ventia/ui';
import { verifyEmail } from '../lib/account-api';
import { linkErrorMessage } from '../lib/account-form';
import { useShopper } from '../lib/shopper-context';

/**
 * `/cuenta/verificar` — redeems the `?token=` from the "confirma tu correo"
 * email and says what happened.
 *
 * ## It does not sign anyone in, and does not pretend to
 *
 * `POST /verify-email` returns no session on purpose: the click may well
 * happen on a phone while the account was created on a laptop, and a
 * verification link is proof of inbox access rather than an intent to start a
 * session on whatever device opened it. So the success state offers a way in,
 * it does not assume one.
 *
 * If a session DOES already exist in this browser, the cached identity is now
 * stale — `emailVerified` just flipped server-side — so this refreshes it.
 * Without that, a shopper who verifies in the same browser goes back to
 * `/cuenta` and is still told to confirm their address.
 */
export function AccountVerify({ token }: { token: string | null }) {
  const { shopper, refresh } = useShopper();
  const [state, setState] = React.useState<'working' | 'done' | 'failed'>(
    token === null ? 'failed' : 'working',
  );
  const [error, setError] = React.useState<string | null>(
    // A link that arrived without a token at all never reaches the API: an
    // empty token is a guaranteed 400, and the shopper is better served by
    // the same "pide uno nuevo" they would get anyway, immediately.
    token === null ? 'Este enlace está incompleto. Pide uno nuevo desde tu cuenta.' : null,
  );

  // Same single-use reasoning as the magic link (`account-sign-in.tsx`):
  // StrictMode's double-invoked effect would spend the token twice and paint
  // a failure over a verification that succeeded.
  const redeemed = React.useRef(false);

  React.useEffect(() => {
    if (token === null || redeemed.current) return;
    redeemed.current = true;
    let cancelled = false;
    verifyEmail(token)
      .then(async () => {
        // Best-effort: the address IS verified whether or not this browser's
        // cached identity can be refreshed, so a failure here must not turn a
        // successful verification into an error screen.
        await refresh().catch((err) => console.error('[account] refresh after verify failed', err));
        if (!cancelled) setState('done');
      })
      .catch((err) => {
        if (cancelled) return;
        setError(linkErrorMessage(err));
        setState('failed');
      });
    return () => {
      cancelled = true;
    };
  }, [token, refresh]);

  return (
    <main className="mx-auto max-w-md px-4 py-8">
      <h1 className="mb-6 text-2xl font-semibold">Confirmar correo</h1>

      {state === 'working' ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner /> Confirmando tu correo…
        </p>
      ) : state === 'done' ? (
        <>
          <Alert variant="success">Listo, tu correo quedó confirmado.</Alert>
          <div className="mt-6">
            {/* Where this points depends on whether this browser already has
                a session: sending a signed-in shopper to a sign-in form is
                a dead end they have to guess their way out of. */}
            <Button href={shopper ? '/cuenta' : '/cuenta/entrar'}>
              {shopper ? 'Ir a mi cuenta' : 'Entrar a mi cuenta'}
            </Button>
          </div>
        </>
      ) : (
        <>
          <Alert variant="error">{error}</Alert>
          <p className="mt-6 text-sm text-muted-foreground">
            Entra a tu cuenta y pide un enlace nuevo desde ahí.
          </p>
          <div className="mt-4">
            <Button href="/cuenta/entrar">Entrar</Button>
          </div>
        </>
      )}
    </main>
  );
}
