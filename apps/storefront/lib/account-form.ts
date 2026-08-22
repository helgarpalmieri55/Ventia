import { SHOPPER_PASSWORD_MAX, SHOPPER_PASSWORD_MIN } from '@ventia/core';
import { AccountApiError } from './account-api';

/**
 * Client-side validation and the user-facing copy for the account screens —
 * the pure half of `/cuenta/*`, kept out of the pages for the same reason
 * `checkout-form.ts` is (this app's vitest runs under Node with no DOM, so
 * anything worth testing has to live in `lib/`).
 *
 * ## The copy in this file is a security control, not decoration
 *
 * The API answers 202 to register, magic-link and password-reset whether or
 * not the address has an account, so that the ONLY place "this address shops
 * here" is ever stated is an email its owner alone can read. That property is
 * worth exactly as much as the sentence the browser shows next to it: a
 * screen that says "ese correo ya existe" or "no encontramos ese correo"
 * hands back, in one line, everything the endpoint spent its design avoiding
 * — and it does it to an attacker enumerating addresses, not to a shopper,
 * who already knows whether they have an account.
 *
 * So every notice below is phrased identically for both branches, and
 * `test/account-form.test.ts` scans them for the giveaway phrasings. If a
 * future change needs new copy here, it goes in `ACCOUNT_NOTICES` and the
 * scan applies to it too.
 *
 * The same rule governs sign-in: `SIGN_IN_FAILED` is one message for a wrong
 * password and an unknown address, because the API returns one code for both.
 */

/** Shown after register / magic-link / password-reset — all three of which
 * are answered 202 regardless. Deliberately conditional ("si el correo está
 * registrado"): it is true either way, and it quietly tells a shopper who
 * mistyped their address why nothing arrived. */
export const MAGIC_LINK_SENT_NOTICE =
  'Si el correo está registrado, te enviamos un enlace para entrar. Revisa tu bandeja de entrada.';

export const PASSWORD_RESET_SENT_NOTICE =
  'Si el correo está registrado, te enviamos un enlace para cambiar tu contraseña. Revisa tu bandeja de entrada.';

/** Register's own notice says nothing about whether an account was created,
 * because it may not have been: an address that already has one gets its
 * OWNER a "ya tienes una cuenta" email instead, and this sentence has to be
 * honest — and identical — in both cases. */
export const REGISTER_SENT_NOTICE =
  'Revisa tu correo: te enviamos un mensaje para continuar. Si no llega en unos minutos, mira en spam.';

/**
 * Shown on `/cuenta` after a signed-in shopper asks for a link to confirm
 * their own address.
 *
 * Phrased directly ("te enviamos") rather than conditionally, and that is not
 * a slip: the ambiguity the other notices preserve exists to stop a stranger
 * learning whether an address has an account here. This one is only ever
 * shown to someone already holding a session for that exact account, so there
 * is nothing left to conceal from them — and "si el correo está registrado"
 * would read as doubt about an account they are currently signed in to.
 */
export const VERIFY_LINK_SENT_NOTICE =
  'Te enviamos un enlace a tu correo. Ábrelo y tu correo queda confirmado.';

/** One message for a wrong password and for an address with no account. The
 * API returns one code (`INVALID_CREDENTIALS`) for both; splitting it here
 * would reintroduce the enumeration the API refuses to allow. */
export const SIGN_IN_FAILED = 'El correo o la contraseña no coinciden.';

export const LINK_INVALID =
  'Este enlace ya no sirve: pudo haber vencido o haberse usado antes. Pide uno nuevo.';

export const GENERIC_ERROR = 'Ocurrió un error. Intenta de nuevo.';

/** Every notice shown after one of the deliberately-ambiguous 202 endpoints.
 * Exported so `test/account-form.test.ts` can assert the whole set stays free
 * of existence-revealing phrasing, instead of a test that only knows about
 * the three that existed when it was written. */
export const ACCOUNT_NOTICES = [
  MAGIC_LINK_SENT_NOTICE,
  PASSWORD_RESET_SENT_NOTICE,
  REGISTER_SENT_NOTICE,
  VERIFY_LINK_SENT_NOTICE,
  SIGN_IN_FAILED,
] as const;

/** Matches the API's `z.string().trim().toLowerCase().email()`. Applied
 * before sending so the address the shopper sees echoed back is the one the
 * server stored — and so `  Ana@Example.COM ` and `ana@example.com` are not
 * two different answers to "did this get a link?". */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Deliberately loose: one `@`, something either side, a dot in the domain, no
 * spaces. This exists to catch the typo the shopper can still fix while
 * looking at the field — the real arbiter is the API's own zod `.email()`,
 * and beyond that whether a message actually arrives. A stricter regex here
 * would only reject valid, unusual addresses on a screen with no recourse.
 */
export function isEmailLike(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(email));
}

function emailError(email: string): string | undefined {
  if (normalizeEmail(email).length === 0) return 'Ingresa tu correo.';
  if (!isEmailLike(email)) return 'Ese correo no parece válido.';
  return undefined;
}

/**
 * The rule for a password being SET (register, reset). Length only, and the
 * bounds come from `@ventia/core` rather than being retyped: the server
 * rejects the same values, and a client rule that drifted from it would
 * either 400 a password this form accepted or refuse one the server would
 * have taken.
 */
function newPasswordError(password: string): string | undefined {
  if (password.length === 0) return 'Elige una contraseña.';
  if (password.length < SHOPPER_PASSWORD_MIN) {
    return `Usa al menos ${SHOPPER_PASSWORD_MIN} caracteres.`;
  }
  if (password.length > SHOPPER_PASSWORD_MAX) {
    return `Usa máximo ${SHOPPER_PASSWORD_MAX} caracteres.`;
  }
  return undefined;
}

export interface SignInFormState {
  email: string;
  password: string;
}

/**
 * Sign-in checks presence and nothing else about the password.
 *
 * No length rule here on purpose, mirroring `shopperSignInSchema`'s own
 * comment: rejecting a short password locally would tell someone their guess
 * was the wrong SHAPE rather than simply wrong, and would lock out any
 * account whose password predates a future raise of the minimum.
 */
export function validateSignInForm(form: SignInFormState): Record<string, string> {
  const errors: Record<string, string> = {};
  const email = emailError(form.email);
  if (email) errors.email = email;
  if (form.password.length === 0) errors.password = 'Ingresa tu contraseña.';
  return errors;
}

export interface RegisterFormState {
  email: string;
  password: string;
  name: string;
}

/** `name` is optional all the way through — the store asks for one at
 * checkout anyway, and an extra required field on a sign-up screen is an
 * extra reason to close the tab. Only its length is checked. */
export function validateRegisterForm(form: RegisterFormState): Record<string, string> {
  const errors: Record<string, string> = {};
  const email = emailError(form.email);
  if (email) errors.email = email;
  const password = newPasswordError(form.password);
  if (password) errors.password = password;
  if (form.name.trim().length > 120) errors.name = 'Usa máximo 120 caracteres.';
  return errors;
}

/** For the two forms whose only field is an address: "envíame un enlace" and
 * "olvidé mi contraseña". */
export function validateEmailOnlyForm(email: string): Record<string, string> {
  const errors: Record<string, string> = {};
  const error = emailError(email);
  if (error) errors.email = error;
  return errors;
}

export interface NewPasswordFormState {
  password: string;
  confirm: string;
}

/**
 * The reset screen asks twice. The confirmation field is not on the API's
 * schema and never reaches it — it exists because this is the one form in the
 * store where a typo is unrecoverable in place: the shopper is holding a
 * single-use link that is spent the moment it succeeds, so a mistyped
 * password locks them out of the account they were in the middle of
 * recovering.
 */
export function validateNewPasswordForm(form: NewPasswordFormState): Record<string, string> {
  const errors: Record<string, string> = {};
  const password = newPasswordError(form.password);
  if (password) errors.password = password;
  // Only when the password itself is otherwise fine: telling someone their
  // two entries differ AND that one is too short is noise, and the second
  // field is the one they will retype anyway.
  else if (form.confirm !== form.password) errors.confirm = 'Las contraseñas no coinciden.';
  return errors;
}

/** Sign-in failure copy. `INVALID_CREDENTIALS` — the only thing the API says
 * about a failed sign-in — becomes the one message; anything else (a 500, an
 * unreachable proxy) is a genuine fault and says so, because telling a
 * shopper their password is wrong when the server is down sends them to
 * reset a password that was fine. */
export function signInErrorMessage(err: unknown): string {
  if (err instanceof AccountApiError && err.code === 'INVALID_CREDENTIALS') return SIGN_IN_FAILED;
  return GENERIC_ERROR;
}

/** Failure copy for consuming a verification / magic / reset token. Same
 * split as above: a spent or expired link is a normal outcome with a way
 * forward, everything else is a fault. */
export function linkErrorMessage(err: unknown): string {
  if (err instanceof AccountApiError && err.code === 'LINK_INVALID') return LINK_INVALID;
  return GENERIC_ERROR;
}

/**
 * Pulls the `?token=` out of what Next hands a page as `searchParams`.
 *
 * Repeated keys (`?token=a&token=b`) arrive as an array — these URLs come
 * from an email client, which is free to mangle them, and this must not
 * crash a public page. First value wins; a blank or missing token is `null`,
 * which the pages render as "this link is incomplete" rather than sending an
 * empty string to the API for a guaranteed 400.
 */
export function tokenFromSearchParams(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}
