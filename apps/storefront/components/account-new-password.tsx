'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Alert, Button, Card, CardContent, CardHeader, CardTitle, FormField, Input, Spinner } from '@ventia/ui';
import { SHOPPER_PASSWORD_MIN } from '@ventia/core';
import { consumePasswordReset } from '../lib/account-api';
import { linkErrorMessage, validateNewPasswordForm } from '../lib/account-form';
import { useShopper } from '../lib/shopper-context';

/**
 * `/cuenta/nueva-clave` — the landing page for the "cambia tu contraseña"
 * email's `?token=`.
 *
 * ## The token is redeemed on SUBMIT, not on mount
 *
 * Unlike the verification and magic-link pages, there is nothing to do with
 * this token until the shopper has typed a password: `POST
 * /password-reset/consume` takes both at once and spends the token whether or
 * not the new password was what they meant. Redeeming on mount would burn the
 * link the instant the page opened — including on a mail client's link
 * prefetch — and leave the shopper on a form whose token is already dead.
 *
 * Because the link is single-use and spent on success, the form asks for the
 * password twice. See `validateNewPasswordForm` for why that is not
 * ceremony here.
 *
 * ## Succeeding signs them in
 *
 * The API establishes a session on this route and returns the merged cart
 * with it, so this ends at `/cuenta` rather than at a sign-in form asking for
 * the password they just chose.
 */
export function AccountNewPassword({ token }: { token: string | null }) {
  const router = useRouter();
  const { adoptSession } = useShopper();
  const [password, setPassword] = React.useState('');
  const [confirm, setConfirm] = React.useState('');
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [bannerError, setBannerError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  if (token === null) {
    return (
      <main className="mx-auto max-w-md px-4 py-8">
        <h1 className="mb-6 text-2xl font-semibold">Nueva contraseña</h1>
        <Alert variant="error">
          Este enlace está incompleto. Pide uno nuevo desde la pantalla de entrada.
        </Alert>
        <div className="mt-6">
          <Button href="/cuenta/entrar">Ir a entrar</Button>
        </div>
      </main>
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBannerError(null);
    const nextErrors = validateNewPasswordForm({ password, confirm });
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    setSubmitting(true);
    try {
      // `token` is non-null here — the early return above is the only other
      // path out of this component.
      const session = await consumePasswordReset(token as string, password);
      await adoptSession(session);
      // `replace`: the URL still carries a token that is now spent.
      router.replace('/cuenta');
    } catch (err) {
      setBannerError(linkErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="mx-auto max-w-md px-4 py-8">
      <h1 className="mb-2 text-2xl font-semibold">Nueva contraseña</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        Al cambiarla vamos a cerrar la sesión en los otros dispositivos donde hayas entrado.
      </p>

      <Card>
        <CardHeader>
          <CardTitle>Elige tu contraseña</CardTitle>
        </CardHeader>
        <CardContent>
          {bannerError ? (
            <Alert variant="error" className="mb-4">
              {bannerError}
            </Alert>
          ) : null}

          <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-4">
            <FormField label="Contraseña nueva" htmlFor="new-password" error={errors.password}>
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                aria-describedby="new-password-hint"
                autoFocus
              />
            </FormField>
            <p id="new-password-hint" className="-mt-2 text-xs text-muted-foreground">
              Al menos {SHOPPER_PASSWORD_MIN} caracteres.
            </p>

            <FormField label="Repite la contraseña" htmlFor="new-password-confirm" error={errors.confirm}>
              <Input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
              />
            </FormField>

            <Button type="submit" disabled={submitting}>
              {submitting ? (
                <>
                  <Spinner /> Guardando…
                </>
              ) : (
                'Guardar contraseña'
              )}
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
