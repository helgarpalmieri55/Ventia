import { createHmac, timingSafeEqual } from 'node:crypto';
import { IMPERSONATION_TTL_MS } from '@ventia/core';

/**
 * The impersonation grant: a signed, self-expiring token in its own cookie.
 *
 * See docs/superpowers/specs/2026-08-19-impersonation-design.md §1–§2. The
 * two decisions this file implements, and why they are not negotiable:
 *
 * 1. **The operator's session is never replaced.** No `Session` row is minted
 *    for the merchant. This token does not authenticate anybody — it is a
 *    *scope*, meaningless without the operator's own live session presented
 *    alongside it. That is what keeps `writeAudit` recording the operator on
 *    every action taken inside the store, instead of misattributing it to the
 *    merchant.
 *
 * 2. **It expires by construction.** Past `exp` the token does not verify, so
 *    no code path can forget to check the deadline — verification is the only
 *    way to read the payload at all. A column on `Session` would have made
 *    expiry a comparison somebody has to remember to write, and a bug that
 *    failed to clear it would leave an operator silently inside a merchant's
 *    store on their next login a week later.
 *
 * The `op` claim is the third leg and it is enforced in
 * `session-context.ts#getSessionContext`, not here: this module can say "this
 * token is intact and unexpired", but only the caller holds the live session
 * to compare `op` against. Without that comparison a leaked token is a bearer
 * credential for someone else's store, which is exactly what this design
 * exists to avoid.
 */

/** The cookie the grant travels in. Distinct from the session cookie, so
 * clearing it ends the impersonation and touches nothing else. */
export const IMPERSONATION_COOKIE = 'ventia_impersonation';

/** Exactly the payload the design names — three claims, no more.
 *
 * Short keys because they are signed and re-signed on every issue and this is
 * a cookie; `exp` is epoch MILLISECONDS (not JWT's seconds) so it compares
 * directly against `Date.now()` with no unit conversion anywhere. */
export interface ImpersonationGrant {
  /** The operator's own `User.id`. Compared against the live session. */
  op: string;
  /** The tenant the grant is for. */
  ten: string;
  /** Epoch ms. Issued + 30 min, never extended. */
  exp: number;
}

export type GrantVerification =
  | { ok: true; grant: ImpersonationGrant }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' };

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function sign(payloadB64: string, secret: string): string {
  return b64url(createHmac('sha256', secret).update(payloadB64).digest());
}

/**
 * `<base64url(json)>.<base64url(hmac-sha256)>`.
 *
 * Hand-rolled rather than a JWT library because the payload is three fields
 * and the verification rules are this file — a JWT would add an `alg` header
 * whose whole history is implementations trusting it, and nothing else about
 * JWT is wanted here.
 */
export function signImpersonationGrant(grant: ImpersonationGrant, secret: string): string {
  const payload = b64url(Buffer.from(JSON.stringify(grant), 'utf8'));
  return `${payload}.${sign(payload, secret)}`;
}

/** Issues a grant expiring exactly `IMPERSONATION_TTL_MS` from `now`. The
 * deadline is computed HERE, from the server's clock, and is never read from
 * a request — a caller-supplied expiry is a caller-supplied 30 minutes. */
export function issueImpersonationGrant(
  operatorId: string,
  tenantId: string,
  secret: string,
  now: number = Date.now(),
): { token: string; grant: ImpersonationGrant } {
  const grant: ImpersonationGrant = { op: operatorId, ten: tenantId, exp: now + IMPERSONATION_TTL_MS };
  return { token: signImpersonationGrant(grant, secret), grant };
}

/**
 * Verifies signature THEN expiry, and reports which failed.
 *
 * The distinction is for the caller's error message only — both are refusals,
 * and neither leaks anything a holder of the token did not already have. An
 * expired grant is reported as such so an operator whose thirty minutes ran
 * out is told that, rather than being handed a generic "invalid" that reads
 * like a bug.
 */
export function verifyImpersonationGrant(
  token: string,
  secret: string,
  now: number = Date.now(),
): GrantVerification {
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return { ok: false, reason: 'malformed' };
  const payloadB64 = token.slice(0, dot);
  const providedSig = token.slice(dot + 1);

  const expectedSig = sign(payloadB64, secret);
  const provided = Buffer.from(providedSig, 'base64url');
  const expected = Buffer.from(expectedSig, 'base64url');
  // Length check first: `timingSafeEqual` THROWS on a length mismatch rather
  // than returning false, so an attacker truncating the signature would turn
  // a refusal into a 500.
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return { ok: false, reason: 'bad_signature' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  const g = parsed as Partial<ImpersonationGrant> | null;
  if (
    !g ||
    typeof g.op !== 'string' ||
    typeof g.ten !== 'string' ||
    typeof g.exp !== 'number' ||
    !Number.isFinite(g.exp)
  ) {
    return { ok: false, reason: 'malformed' };
  }

  // `>=`, not `>`: a token whose deadline is exactly now has run out.
  if (now >= g.exp) return { ok: false, reason: 'expired' };

  return { ok: true, grant: { op: g.op, ten: g.ten, exp: g.exp } };
}

/**
 * Reads the grant out of a raw `Cookie:` header.
 *
 * Deliberately NOT `req.cookies` (cookie-parser): `getSessionContext` is
 * handed a `Headers` object built from `req.headers.cookie`, the same one
 * better-auth reads its session from, and both guards that call it construct
 * it the same way. Parsing the one header keeps the grant and the session
 * being read from the identical source of truth, so there is no arrangement
 * of middleware in which they can disagree about what the browser sent.
 */
export function readImpersonationCookie(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== IMPERSONATION_COOKIE) continue;
    const value = part.slice(eq + 1).trim();
    return value.length > 0 ? decodeURIComponent(value) : null;
  }
  return null;
}

/**
 * The signing secret — `AUTH_SECRET`, better-auth's own trust root, with the
 * same fallback `admin.module.ts` uses for its auth instance.
 *
 * Read per call rather than captured at import time so a test that sets the
 * env before building the app graph sees its own value, matching how
 * `platformAdminAllowlist()` treats `PLATFORM_ADMIN_EMAILS`.
 */
export function authSecret(): string {
  return process.env.AUTH_SECRET ?? 'dev-secret-change-me';
}

/**
 * Cookie attributes, matching what `test/session-cookie.test.ts` pins for the
 * session cookie and for the same reasons (design §2):
 *
 * - `httpOnly` — a stored XSS on the admin origin must not be able to read a
 *   live grant out of `document.cookie`.
 * - `sameSite: 'lax'` — `/v1/admin/*` has no CSRF token and no origin check;
 *   the cookie attribute is the entire defence. `Lax` on the GRANT matters
 *   independently of the session cookie: a cross-site request that could
 *   carry the grant but not the session is useless (the `op` binding fails),
 *   but one that carried both would be a cross-site write inside a
 *   merchant's store.
 * - `path: '/'` — the grant has to reach `/v1/admin/*` and `/v1/platform/*`
 *   alike, and a narrower path would silently drop it on one of them.
 * - `secure` — mirrors better-auth's own rule (`useSecureCookies` defaults to
 *   `baseURL.startsWith('https://')`) rather than sniffing `NODE_ENV`, which
 *   this repo does not set anywhere. Same input, same answer, so the grant
 *   cookie and the session cookie can never disagree about whether this
 *   deployment is on TLS.
 */
export function impersonationCookieOptions(maxAgeMs?: number) {
  const baseUrl = process.env.API_URL ?? 'http://api.ventia.localhost';
  return {
    httpOnly: true as const,
    sameSite: 'lax' as const,
    path: '/' as const,
    secure: baseUrl.startsWith('https://'),
    ...(maxAgeMs !== undefined ? { maxAge: maxAgeMs } : {}),
  };
}
