'use client';

import * as React from 'react';
import { Alert, Button, FormField, Input, Spinner } from '@ventia/ui';
import {
  requestMagicLink,
  requestPasswordReset,
  signIn,
  type ShopperSession,
} from '../lib/account-api';
import {
  MAGIC_LINK_SENT_NOTICE,
  PASSWORD_RESET_SENT_NOTICE,
  signInErrorMessage,
  validateEmailOnlyForm,
  validateSignInForm,
  normalizeEmail,
} from '../lib/account-form';
import { useShopper } from '../lib/shopper-context';

/**
 * The store's one sign-in form, rendered both on `/cuenta/entrar` and inline
 * on the checkout page.
 *
 * One component for both because the checkout case is the one with a real
 * requirement attached — a shopper who remembers mid-payment that they have
 * an account must be able to sign in WITHOUT losing their basket — and a
 * second, checkout-only copy of this form is exactly how that requirement
 * gets quietly dropped later. `useShopper().adoptSession` applies the merged
 * cart the API returns, so every caller gets that behaviour whether or not it
 * knows to ask for it.
 *
 * ## Three ways in, one field
 *
 * Password, emailed sign-in link, and password reset all key off the same
 * address input. The link buttons exist because a shopper who bought once as
 * a guest six months ago almost certainly does not remember a password, and
 * making them invent a new one is a longer road than a link.
 *
 * ## The notices never say whether the address has an account
 *
 * Both link requests are answered 202 by the API regardless, and the copy in
 * `account-form.ts` is phrased to match. Nothing in this component may branch
 * on, or hint at, which case occurred — it does not know, and must not appear
 * to. See `account-form.ts`'s header.
 */
export interface SignInFormProps {
  /**
   * Runs after a session has been established and the merged cart applied.
   * Used for what differs between the two hosts: `/cuenta/entrar` navigates
   * to the account area, the checkout page just collapses the panel and keeps
   * the shopper where they were — the one thing checkout must never do is
   * navigate away from a half-filled form.
   */
  onSignedIn?: (session: ShopperSession) => void;
  /** Rendered under the buttons — the "crea una cuenta" link on
   * `/cuenta/entrar`, nothing at checkout (where an account offer competes
   * with the purchase). */
  children?: React.ReactNode;
  /** Autofocus the address field. On `/cuenta/entrar` the form IS the page;
   * at checkout it appears mid-form, where stealing focus would yank the page
   * out from under someone typing their address. */
  autoFocusEmail?: boolean;
}

/**
 * Field ids are prefixed because this form is mounted on the checkout page,
 * whose own contact section already uses `id="email"`. Two elements with the
 * same id make `<label for>` point at whichever the browser finds first — the
 * shopper taps "Correo" over the sign-in box and the checkout field focuses.
 */
const EMAIL_ID = 'signin-email';
const PASSWORD_ID = 'signin-password';

export function SignInForm({ onSignedIn, children, autoFocusEmail = false }: SignInFormProps) {
  const { adoptSession } = useShopper();
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [bannerError, setBannerError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  // One flag for all three actions: they share the address field, so allowing
  // a link request while a sign-in is in flight would let a shopper fire both
  // and then wonder which of the two outcomes they are looking at.
  const [busy, setBusy] = React.useState(false);

  function reset() {
    setBannerError(null);
    setNotice(null);
  }

  async function handleSignIn(e: React.FormEvent) {
    e.preventDefault();
    reset();
    const nextErrors = validateSignInForm({ email, password });
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    setBusy(true);
    try {
      const session = await signIn(normalizeEmail(email), password);
      await adoptSession(session);
      onSignedIn?.(session);
    } catch (err) {
      setBannerError(signInErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  /** Shared by both link requests: identical validation, identical "we sent
   * something if there was somewhere to send it" outcome, different endpoint
   * and sentence. Note there is no `catch` branch that reports a different
   * message per outcome — there is only one outcome. */
  async function requestLink(send: (address: string) => Promise<void>, sentNotice: string) {
    reset();
    const nextErrors = validateEmailOnlyForm(email);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    setBusy(true);
    try {
      await send(normalizeEmail(email));
      setNotice(sentNotice);
    } catch (err) {
      // A transport failure is the ONLY thing that can land here (the
      // endpoint answers 202 for every address), so it is safe — and
      // necessary — to say the request itself did not go through.
      console.error('[account] link request failed', err);
      setBannerError('No pudimos enviar el correo. Intenta de nuevo.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void handleSignIn(e)} className="flex flex-col gap-4">
      {bannerError ? <Alert variant="error">{bannerError}</Alert> : null}
      {notice ? <Alert variant="success">{notice}</Alert> : null}

      <FormField label="Correo electrónico" htmlFor={EMAIL_ID} error={errors.email}>
        <Input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
          autoFocus={autoFocusEmail}
        />
      </FormField>

      <FormField label="Contraseña" htmlFor={PASSWORD_ID} error={errors.password}>
        <Input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
        />
      </FormField>

      <Button type="submit" disabled={busy}>
        {busy ? (
          <>
            <Spinner /> Entrando…
          </>
        ) : (
          'Entrar'
        )}
      </Button>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => void requestLink(requestMagicLink, MAGIC_LINK_SENT_NOTICE)}
        >
          Envíame un enlace
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => void requestLink(requestPasswordReset, PASSWORD_RESET_SENT_NOTICE)}
        >
          Olvidé mi contraseña
        </Button>
      </div>

      {children}
    </form>
  );
}
