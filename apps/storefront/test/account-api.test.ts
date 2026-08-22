import { describe, expect, it, vi } from 'vitest';
import {
  AccountApiError,
  consumeMagicLink,
  consumePasswordReset,
  fetchMe,
  fetchMyOrders,
  registerAccount,
  requestMagicLink,
  requestPasswordReset,
  signIn,
  signOut,
  updateMyName,
  verifyEmail,
} from '../lib/account-api';

// Same shape as `cart-api.test.ts` / `checkout-api.test.ts`: a mocked
// `fetchImpl` asserting the proxy path, method, body and credentials. This
// app runs vitest under Node with no DOM, so the request-shaping decisions in
// `account-api.ts` are where the account feature's testable logic lives.

const SHOPPER = { email: 'ana@example.com', name: 'Ana', emailVerified: true };
const CART = { lines: [], subtotalCents: 0, taxCents: 0 };

function ok(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));
}

describe('registerAccount', () => {
  it('POSTs email, password and name to the register path with credentials included', async () => {
    const fetchImpl = ok({ ok: true }, 202);
    await registerAccount({ email: 'ana@example.com', password: 'contrasena1', name: 'Ana' }, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith('/api/account/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'ana@example.com', password: 'contrasena1', name: 'Ana' }),
      credentials: 'include',
    });
  });

  it('omits `name` entirely when it is blank rather than sending an empty string', async () => {
    // The API's schema is `z.string().trim().min(1).optional()`: `''` is a
    // 400, an absent key is the intended "didn't say". A shopper who leaves
    // the optional name field alone must not get a validation error.
    const fetchImpl = ok({ ok: true }, 202);
    await registerAccount({ email: 'ana@example.com', password: 'contrasena1', name: '' }, fetchImpl);
    const body = JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string) as Record<
      string,
      unknown
    >;
    expect(Object.keys(body)).not.toContain('name');
  });

  it('resolves on the 202 the API answers for every address, taken or not', async () => {
    // There is nothing to assert about WHICH case occurred, and that is the
    // point: if this function ever starts returning something a caller could
    // branch on, the storefront gains the ability to leak which addresses
    // shop here.
    const fetchImpl = ok({ ok: true }, 202);
    await expect(
      registerAccount({ email: 'taken@example.com', password: 'contrasena1' }, fetchImpl),
    ).resolves.toBeUndefined();
  });
});

describe('signIn', () => {
  it('POSTs the credentials and returns both the shopper and the merged cart', async () => {
    const cart = { lines: [{ id: 'l1', productId: 'p1', variantId: null, qty: 2, name: 'Camisa', priceCents: 5000, lineSubtotalCents: 10000, lineTaxCents: 1900 }], subtotalCents: 10000, taxCents: 1900 };
    const fetchImpl = ok({ shopper: SHOPPER, cart });
    const session = await signIn('ana@example.com', 'contrasena1', fetchImpl);
    expect(session.shopper).toEqual(SHOPPER);
    // The cart in the response IS the post-merge truth — the caller must use
    // it rather than refetching. If this ever stops being returned, the
    // checkout sign-in silently starts dropping baskets.
    expect(session.cart).toEqual(cart);
    expect(fetchImpl).toHaveBeenCalledWith('/api/account/sign-in', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'ana@example.com', password: 'contrasena1' }),
      credentials: 'include',
    });
  });

  it('throws AccountApiError(401, INVALID_CREDENTIALS) — the one answer for a wrong password and an unknown address alike', async () => {
    const fetchImpl = ok({ error: 'INVALID_CREDENTIALS' }, 401);
    const err = await signIn('ana@example.com', 'nope', fetchImpl).catch((e) => e);
    expect(err).toBeInstanceOf(AccountApiError);
    expect((err as AccountApiError).status).toBe(401);
    expect((err as AccountApiError).code).toBe('INVALID_CREDENTIALS');
  });

  it('falls back to code UNKNOWN for an unparseable error body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('<html>502</html>', { status: 502 }));
    const err = await signIn('ana@example.com', 'x', fetchImpl).catch((e) => e);
    expect((err as AccountApiError).code).toBe('UNKNOWN');
    expect((err as AccountApiError).status).toBe(502);
  });
});

describe('link requests', () => {
  it('POSTs the address to the magic-link path', async () => {
    const fetchImpl = ok({ ok: true }, 202);
    await requestMagicLink('ana@example.com', fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith('/api/account/magic-link', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'ana@example.com' }),
      credentials: 'include',
    });
  });

  it('POSTs the address to the password-reset path', async () => {
    const fetchImpl = ok({ ok: true }, 202);
    await requestPasswordReset('ana@example.com', fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith('/api/account/password-reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'ana@example.com' }),
      credentials: 'include',
    });
  });

  it('resolves identically for an address with no account (the API answers 202 either way)', async () => {
    // A fresh mock per call: a `Response` body can only be read once.
    await expect(requestMagicLink('nobody@example.com', ok({ ok: true }, 202))).resolves.toBeUndefined();
    await expect(
      requestPasswordReset('nobody@example.com', ok({ ok: true }, 202)),
    ).resolves.toBeUndefined();
  });
});

describe('token consumption', () => {
  it('POSTs the token to magic-link/consume and returns the session', async () => {
    const fetchImpl = ok({ shopper: SHOPPER, cart: CART });
    const session = await consumeMagicLink('tok-1', fetchImpl);
    expect(session.shopper).toEqual(SHOPPER);
    expect(fetchImpl).toHaveBeenCalledWith('/api/account/magic-link/consume', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'tok-1' }),
      credentials: 'include',
    });
  });

  it('surfaces a spent or expired magic link as LINK_INVALID', async () => {
    const fetchImpl = ok({ error: 'LINK_INVALID' }, 400);
    const err = await consumeMagicLink('spent', fetchImpl).catch((e) => e);
    expect((err as AccountApiError).code).toBe('LINK_INVALID');
    expect((err as AccountApiError).status).toBe(400);
  });

  it('POSTs the token to verify-email and returns nothing (verification issues no session)', async () => {
    const fetchImpl = ok({ ok: true });
    await expect(verifyEmail('tok-2', fetchImpl)).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledWith('/api/account/verify-email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'tok-2' }),
      credentials: 'include',
    });
  });

  it('POSTs both the token and the new password to password-reset/consume, and gets a session back', async () => {
    const fetchImpl = ok({ shopper: SHOPPER, cart: CART });
    const session = await consumePasswordReset('tok-3', 'contrasena-nueva', fetchImpl);
    expect(session.cart).toEqual(CART);
    expect(fetchImpl).toHaveBeenCalledWith('/api/account/password-reset/consume', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'tok-3', password: 'contrasena-nueva' }),
      credentials: 'include',
    });
  });
});

describe('signOut', () => {
  it('POSTs sign-out and does not try to parse the 204s empty body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    await expect(signOut(fetchImpl)).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledWith('/api/account/sign-out', {
      method: 'POST',
      credentials: 'include',
    });
  });

  it('throws on a genuinely failed sign-out rather than reporting success', async () => {
    // A UI that cleared its local state on a failed sign-out would show a
    // signed-out header over a session that is still live.
    const fetchImpl = ok({ error: 'BOOM' }, 500);
    const err = await signOut(fetchImpl).catch((e) => e);
    expect(err).toBeInstanceOf(AccountApiError);
    expect((err as AccountApiError).status).toBe(500);
  });
});

describe('fetchMe', () => {
  it('GETs /me with credentials and returns the shopper', async () => {
    const fetchImpl = ok(SHOPPER);
    await expect(fetchMe(fetchImpl)).resolves.toEqual(SHOPPER);
    expect(fetchImpl).toHaveBeenCalledWith('/api/account/me', {
      method: 'GET',
      credentials: 'include',
    });
  });

  it('maps a 401 to null — "not signed in" is the normal case, not a failure', async () => {
    const fetchImpl = ok({ error: 'SHOPPER_UNAUTHORIZED' }, 401);
    await expect(fetchMe(fetchImpl)).resolves.toBeNull();
  });

  it('still throws on a 500 rather than reporting "signed out"', async () => {
    // Mapping every failure to null would render a confident signed-out
    // header at a shopper who is signed in, and their next sign-in attempt
    // would fail the same silent way.
    const fetchImpl = ok({ error: 'BOOM' }, 500);
    const err = await fetchMe(fetchImpl).catch((e) => e);
    expect(err).toBeInstanceOf(AccountApiError);
    expect((err as AccountApiError).status).toBe(500);
  });
});

describe('updateMyName', () => {
  it('PATCHes /me with the new name', async () => {
    const fetchImpl = ok({ ...SHOPPER, name: 'Ana María' });
    const updated = await updateMyName('Ana María', fetchImpl);
    expect(updated.name).toBe('Ana María');
    expect(fetchImpl).toHaveBeenCalledWith('/api/account/me', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Ana María' }),
      credentials: 'include',
    });
  });

  it('sends null to clear the name (the API rejects an empty string)', async () => {
    const fetchImpl = ok({ ...SHOPPER, name: null });
    await updateMyName(null, fetchImpl);
    expect((fetchImpl.mock.calls[0][1] as RequestInit).body).toBe(JSON.stringify({ name: null }));
  });
});

describe('fetchMyOrders', () => {
  it('GETs /orders and unwraps the envelope', async () => {
    const orders = [
      {
        id: 'o1',
        number: 1042,
        status: 'SHIPPED',
        paymentStatus: 'PAID',
        totalCents: 4590000,
        createdAt: '2026-03-04T02:30:00.000Z',
      },
    ];
    const fetchImpl = ok({ orders });
    await expect(fetchMyOrders(fetchImpl)).resolves.toEqual(orders);
    expect(fetchImpl).toHaveBeenCalledWith('/api/account/orders', {
      method: 'GET',
      credentials: 'include',
    });
  });

  it('surfaces the 403 for an unconfirmed address as EMAIL_NOT_VERIFIED', async () => {
    const fetchImpl = ok({ error: 'EMAIL_NOT_VERIFIED' }, 403);
    const err = await fetchMyOrders(fetchImpl).catch((e) => e);
    expect((err as AccountApiError).code).toBe('EMAIL_NOT_VERIFIED');
    expect((err as AccountApiError).status).toBe(403);
  });
});
