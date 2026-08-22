'use client';

import * as React from 'react';
import Link from 'next/link';
import { Alert, Button, Card, CardContent, CardHeader, CardTitle, FormField, Input, Spinner } from '@ventia/ui';
import { SHOPPER_PASSWORD_MIN } from '@ventia/core';
import { registerAccount } from '../lib/account-api';
import {
  REGISTER_SENT_NOTICE,
  normalizeEmail,
  validateRegisterForm,
  type RegisterFormState,
} from '../lib/account-form';

const EMPTY: RegisterFormState = { email: '', password: '', name: '' };

/**
 * `/cuenta/registrarse`.
 *
 * ## What this screen must not do
 *
 * It cannot tell the shopper whether the address was already taken, because
 * the API does not tell it: `POST /register` answers 202 either way, and an
 * address that already has an account gets its OWNER a "ya tienes una cuenta"
 * email instead of creating anything. So there is exactly one outcome to
 * render — "revisa tu correo" — and no error branch for a taken address,
 * because no such error exists to branch on.
 *
 * ## No session comes back
 *
 * Registration deliberately does not sign anyone in; the account is not
 * usable until the address is confirmed from the inbox. The success panel
 * therefore points at the email, not at `/cuenta`.
 */
export function AccountRegister() {
  const [form, setForm] = React.useState<RegisterFormState>(EMPTY);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [bannerError, setBannerError] = React.useState<string | null>(null);
  const [sent, setSent] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);

  function setField<K extends keyof RegisterFormState>(key: K, value: RegisterFormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBannerError(null);
    const nextErrors = validateRegisterForm(form);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    setSubmitting(true);
    try {
      await registerAccount({
        email: normalizeEmail(form.email),
        password: form.password,
        // Trimmed and dropped when blank — the API's schema has `name`
        // optional with a `min(1)`, so `''` would be a 400 while an absent
        // key is the intended "prefer not to say".
        name: form.name.trim(),
      });
      setSent(true);
    } catch (err) {
      // Nothing reaching here is about the address: a 202 is returned for
      // every one of them. This is a transport or server fault.
      console.error('[account] register failed', err);
      setBannerError('No pudimos crear la cuenta en este momento. Intenta de nuevo.');
    } finally {
      setSubmitting(false);
    }
  }

  if (sent) {
    return (
      <main className="mx-auto max-w-md px-4 py-8">
        <h1 className="mb-6 text-2xl font-semibold">Crear cuenta</h1>
        <Alert variant="success">{REGISTER_SENT_NOTICE}</Alert>
        <p className="mt-6 text-sm text-muted-foreground">
          ¿Ya confirmaste tu correo?{' '}
          <Link href="/cuenta/entrar" className="underline">
            Entra a tu cuenta
          </Link>
          .
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-md px-4 py-8">
      <h1 className="mb-2 text-2xl font-semibold">Crear cuenta</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        Con una cuenta guardas tus datos y ves tus pedidos. No es obligatoria: también puedes comprar
        como invitado.
      </p>

      <Card>
        <CardHeader>
          <CardTitle>Tus datos</CardTitle>
        </CardHeader>
        <CardContent>
          {bannerError ? (
            <Alert variant="error" className="mb-4">
              {bannerError}
            </Alert>
          ) : null}

          <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-4">
            <FormField label="Correo electrónico" htmlFor="register-email" error={errors.email}>
              <Input
                type="email"
                value={form.email}
                onChange={(e) => setField('email', e.target.value)}
                autoComplete="email"
                autoFocus
              />
            </FormField>

            <FormField label="Nombre (opcional)" htmlFor="register-name" error={errors.name}>
              <Input
                value={form.name}
                onChange={(e) => setField('name', e.target.value)}
                autoComplete="name"
              />
            </FormField>

            <FormField label="Contraseña" htmlFor="register-password" error={errors.password}>
              <Input
                type="password"
                value={form.password}
                onChange={(e) => setField('password', e.target.value)}
                autoComplete="new-password"
                aria-describedby="register-password-hint"
              />
            </FormField>
            {/* The rule is stated before the shopper types, not after they get
                it wrong. Length is the ONLY rule — see the note on
                `SHOPPER_PASSWORD_MIN` in packages/core for why there is no
                "una mayúscula y un símbolo" requirement to explain here. */}
            <p id="register-password-hint" className="-mt-2 text-xs text-muted-foreground">
              Al menos {SHOPPER_PASSWORD_MIN} caracteres.
            </p>

            <Button type="submit" disabled={submitting}>
              {submitting ? (
                <>
                  <Spinner /> Creando cuenta…
                </>
              ) : (
                'Crear cuenta'
              )}
            </Button>
          </form>

          <p className="mt-4 text-sm text-muted-foreground">
            ¿Ya tienes cuenta?{' '}
            <Link href="/cuenta/entrar" className="underline">
              Entra acá
            </Link>
            .
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
