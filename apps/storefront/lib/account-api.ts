/** Client-side typed client for a shopper's own account, called from the
 * browser through the same-origin `/api/account/...` Route Handler proxy
 * (`app/api/account/[[...path]]/route.ts`) — same pattern, and the same
 * dropped `apiUrl`/`tenantHost` params, as `cart-api.ts` and
 * `checkout-api.ts`. See `cart-api.ts`'s header for the full rationale on
 * why the browser never talks to `API_INTERNAL_URL` directly.
 *
 * `fetchImpl` is threaded through everywhere (default `fetch`) so
 * `test/account-api.test.ts` can assert on call shape without a network —
 * this app's vitest runs under Node with no DOM, so the request-shaping
 * decisions in this module are where the testable logic of the whole account
 * feature lives.
 *
 * ## Every call is `credentials: 'include'`, and nothing here reads a cookie
 *
 * The session is `ventia_shopper`, HttpOnly, set by the API and forwarded
 * both ways by the proxy. There is deliberately no `isSignedIn()` helper
 * that inspects `document.cookie`: an HttpOnly cookie is invisible to JS by
 * design, so any such helper would be reading a DIFFERENT (or absent) cookie
 * and confidently reporting the wrong answer. "Am I signed in?" is answered
 * by `fetchMe()` returning a shopper instead of `null`, and by nothing else.
 *
 * ## The API's silence about which addresses exist is part of this contract
 *
 * `register`, `requestMagicLink` and `requestPasswordReset` all resolve the
 * same way whether or not the address has an account — the API answers 202
 * in every case on purpose (see `ShopperController`). None of them returns
 * anything a caller could branch on, and that is not an oversight to be
 * "fixed" by surfacing more detail later: the only place the existence of an
 * account is ever stated is the email itself, which only its owner can read.
 */

/** A cart as the account endpoints return it is structurally the same as
 * `cart-api.ts`'s `Cart` (the API hands back its full `CartDto` on the
 * sign-in routes too), so it is imported from there rather than re-declared
 * — a change to the cart shape must not be able to diverge between the two
 * clients. */
import type { Cart } from './cart-api';

/** What the API is willing to tell the browser about a shopper — exactly
 * `publicIdentity()` in `shopper.controller.ts`. No ids: `accountId` and
 * `customerId` are internal, and the tenant is already implied by the host. */
export interface Shopper {
  email: string;
  name: string | null;
  emailVerified: boolean;
}

/**
 * What every successful sign-in path returns: the shopper AND the cart.
 *
 * The cart is in this response for one specific reason, and callers must use
 * it rather than refetching. `establish()` on the API merges the guest basket
 * the browser was holding into the account's, then re-points `ventia_cart` at
 * the merged one — so this payload IS the post-merge truth. A UI that ignored
 * it and refetched would at best do a redundant round trip and at worst race
 * the cookie it depends on, and the shopper who signs in at the payment step
 * would watch their basket flicker or empty. That is the abandonment this
 * whole flow exists to avoid.
 */
export interface ShopperSession {
  shopper: Shopper;
  cart: Cart;
}

/** One row of `GET /orders`. Mirrors that endpoint's `select` exactly;
 * `status`/`paymentStatus` are left as plain strings rather than unions —
 * see `account-orders.ts` for why the labels fall back instead of throwing on
 * a value this build has not heard of. */
export interface ShopperOrder {
  id: string;
  number: number;
  status: string;
  paymentStatus: string;
  totalCents: number;
  createdAt: string;
}

/** Thrown for any non-2xx from the `/api/account/...` proxy. Carries the
 * API's `error` CODE like `CheckoutApiError` does — the pages branch on
 * `INVALID_CREDENTIALS`, `LINK_INVALID` and `EMAIL_NOT_VERIFIED`, which a
 * raw-body-text error (`CartApiError`'s shape) would force them to
 * string-match. */
export class AccountApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(`account api error ${status}: ${code}`);
  }
}

async function parseErrorAndThrow(res: Response): Promise<never> {
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    body = undefined;
  }
  const code =
    typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string'
      ? ((body as { error: string }).error)
      : 'UNKNOWN';
  throw new AccountApiError(res.status, code);
}

async function request<T>(path: string, init: RequestInit, fetchImpl: typeof fetch): Promise<T> {
  const res = await fetchImpl(`/api/account${path}`, {
    ...init,
    // Always: the session and cart cookies are the entire point of these
    // calls, and a same-origin `fetch` still needs this explicitly.
    credentials: 'include',
  });
  if (!res.ok) return parseErrorAndThrow(res);
  return (await res.json()) as T;
}

function jsonPost(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

/**
 * Asks for an account. Resolves on 202 and tells the caller NOTHING about
 * whether one was created — see this module's header. The UI's job after this
 * resolves is to say "revisa tu correo", the same sentence either way.
 *
 * `name` is omitted entirely when blank rather than sent as `''`: the API's
 * schema has it optional with `min(1)`, so an empty string is a 400 while an
 * absent key is the intended "didn't say".
 */
export async function registerAccount(
  input: { email: string; password: string; name?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const body: Record<string, unknown> = { email: input.email, password: input.password };
  if (input.name !== undefined && input.name !== '') body.name = input.name;
  await request<{ ok: true }>('/register', jsonPost(body), fetchImpl);
}

/** Throws `AccountApiError(401, 'INVALID_CREDENTIALS')` for a wrong password
 * and an unknown address alike — the API answers identically on purpose, and
 * `account-form.ts` maps that one code to one message. */
export async function signIn(
  email: string,
  password: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ShopperSession> {
  return request<ShopperSession>('/sign-in', jsonPost({ email, password }), fetchImpl);
}

export async function requestMagicLink(email: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  await request<{ ok: true }>('/magic-link', jsonPost({ email }), fetchImpl);
}

export async function consumeMagicLink(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ShopperSession> {
  return request<ShopperSession>('/magic-link/consume', jsonPost({ token }), fetchImpl);
}

/** Confirms an address. Deliberately does NOT return a session: the API does
 * not issue one here, because clicking a link in an inbox proves inbox access
 * and may well happen on a different device from the one that registered. */
export async function verifyEmail(token: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  await request<{ ok: true }>('/verify-email', jsonPost({ token }), fetchImpl);
}

export async function requestPasswordReset(email: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  await request<{ ok: true }>('/password-reset', jsonPost({ email }), fetchImpl);
}

/** Sets a new password AND signs the shopper in — the API establishes a
 * session on this route, so the caller gets the merged cart too and must not
 * bounce the shopper back to a sign-in form afterwards. */
export async function consumePasswordReset(
  token: string,
  password: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ShopperSession> {
  return request<ShopperSession>('/password-reset/consume', jsonPost({ token, password }), fetchImpl);
}

/**
 * Ends the session. Never throws for "there was no session": the endpoint
 * answers 204 regardless, and so does this — the desired state is "signed
 * out", and it has been reached either way. A non-2xx (a genuinely broken
 * upstream) still throws, because a UI that cleared its local state on a
 * failed sign-out would show a signed-out header over a live session.
 */
export async function signOut(fetchImpl: typeof fetch = fetch): Promise<void> {
  const res = await fetchImpl('/api/account/sign-out', {
    method: 'POST',
    credentials: 'include',
  });
  // No `res.json()`: a 204 has no body to parse.
  if (!res.ok) return parseErrorAndThrow(res);
}

/**
 * The signed-in shopper, or `null` when there is no session.
 *
 * A 401 is a normal, expected answer here — most visitors to a store are not
 * signed in — so it becomes `null` rather than a thrown error. Every OTHER
 * failure still throws: a 500 mapped to `null` would render a confident
 * "signed out" header at a shopper who is signed in, and they would sign in
 * again, and the second attempt would fail the same silent way.
 */
export async function fetchMe(fetchImpl: typeof fetch = fetch): Promise<Shopper | null> {
  const res = await fetchImpl('/api/account/me', { method: 'GET', credentials: 'include' });
  if (res.status === 401) return null;
  if (!res.ok) return parseErrorAndThrow(res);
  return (await res.json()) as Shopper;
}

/** Renames the shopper. `null` clears the name — the API's schema accepts it
 * explicitly, and a shopper who wants their name off the account should not
 * have to invent one. */
export async function updateMyName(
  name: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<Shopper> {
  return request<Shopper>(
    '/me',
    { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) },
    fetchImpl,
  );
}

/** Throws `AccountApiError(403, 'EMAIL_NOT_VERIFIED')` when the address has
 * not been confirmed — not an error state to hide, but the one the account
 * page renders as "confirma tu correo para ver tus pedidos". */
export async function fetchMyOrders(fetchImpl: typeof fetch = fetch): Promise<ShopperOrder[]> {
  const body = await request<{ orders: ShopperOrder[] }>('/orders', { method: 'GET' }, fetchImpl);
  return body.orders;
}
