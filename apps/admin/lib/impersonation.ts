/**
 * Operator impersonation, merchant-side (docs/superpowers/specs/
 * 2026-08-19-impersonation-design.md §5).
 *
 * This module is the merchant admin's ENTIRE knowledge of impersonation: the
 * assumed wire shape, the adapter that reads it, and the pure clock logic the
 * banner renders. Everything else — `lib/session.ts`, the `(app)` layout, the
 * banner component — goes through what is exported here.
 *
 * ============================================================================
 * THE WIRE SHAPE — assumed while writing, since CONFIRMED
 * ============================================================================
 *
 * This module was written against an assumed shape while `GET /v1/admin/me`
 * still returned `{ userId, email, tenantId, role, emailVerified }` and
 * nothing about impersonation. The API has since landed it
 * (`services/api/src/auth/session-context.ts`, `packages/core/src/
 * impersonation-schemas.ts`) and the assumption held field-for-field on
 * everything read below — `tenantId`, `tenantName`, `operatorEmail`, and
 * `expiresAt` as an ISO-8601 string. The API's `ImpersonationContext` also
 * carries `operatorId`, which this banner has no use for and does not read.
 *
 * The isolation stays regardless: this file remains the ONLY place in the
 * merchant admin that names a field of that payload, so the next change to it
 * is an edit to `readImpersonationContext` and to nothing else.
 *
 * The shape:
 *
 * ```jsonc
 * // GET /v1/admin/me, while impersonating
 * {
 *   "userId": "…", "email": "…", "tenantId": "…", "role": "owner", "emailVerified": true,
 *   "impersonation": {
 *     "tenantId":      "tnt_123",                   // the store being acted inside
 *     "tenantName":    "Moda Bogotá",               // its display name
 *     "operatorEmail": "ana@ventia.co",             // the Ventia employee, per §1
 *     "expiresAt":     "2026-08-19T15:30:00.000Z"   // ISO-8601 instant = the token's `exp`
 *   }
 * }
 * ```
 *
 * The API sends `impersonation: null` — present, explicitly null — when
 * nobody is impersonating; an absent key is read the same way here, so this
 * app is correct under either. That absence is the ONLY signal treated as
 * "not impersonating".
 *
 * The token payload itself is `{ op, ten, exp }` with `exp` an epoch (§2), but
 * `expiresAt` on the wire is the ISO rendering of it. Were that ever to change
 * to a bare number, `parseExpiresAt` returns `null` and the banner still
 * renders — with "Tiempo restante desconocido" instead of a countdown. That is
 * the deliberate direction of failure (see below); the fix is one function.
 *
 * ============================================================================
 * WHICH WAY THIS FAILS
 * ============================================================================
 *
 * A banner that hides itself is the failure mode the spec's AC exists to
 * prevent ("an operator forgets they are impersonating … and changes
 * something real"). So the adapter is deliberately NOT symmetric:
 *
 *  - Server says nothing about impersonation -> `null`. No banner. The server
 *    is the source of truth (§5) and its silence means "not impersonating".
 *  - Server says impersonation is happening, but a field inside is missing or
 *    the wrong type -> a context with `null` in that slot, and the banner
 *    renders anyway with degraded copy. A malformed payload must not be able
 *    to make the warning disappear.
 */

/** How the banner reads the server's answer. Every field is nullable because
 * a partially-readable payload must still produce a visible banner. */
export interface ImpersonationContext {
  /** The store being acted inside. `null` disables the exit call (see
   * {@link impersonationExitPath}) but never the banner. */
  tenantId: string | null;
  /** Display name of that store — the "names the store" half of §5. */
  storeName: string | null;
  /** The Ventia employee behind the merchant's face, per §1: the audit trail
   * records the operator, and so does this banner. */
  operatorEmail: string | null;
  /** ISO-8601 instant at which the grant stops verifying. A hard ceiling, not
   * a sliding window (§2), which is what makes counting down to it honest. */
  expiresAt: string | null;
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * THE adapter. The single point of contact between this app and the assumed
 * shape documented above — change it here, change it everywhere.
 *
 * Returns `null` for "the server did not report an impersonation context",
 * which is the only condition under which the banner is absent.
 */
export function readImpersonationContext(body: unknown): ImpersonationContext | null {
  if (typeof body !== 'object' || body === null) return null;
  const raw = (body as { impersonation?: unknown }).impersonation;
  // Absent, null, or `false` — all readings of "not impersonating". A
  // non-object truthy value (a bare string, say) is a shape this app cannot
  // read at all, and it is treated as impersonation-with-nothing-known rather
  // than as absence, because guessing "absent" there would hide the banner.
  if (raw === undefined || raw === null || raw === false) return null;
  if (typeof raw !== 'object') {
    return { tenantId: null, storeName: null, operatorEmail: null, expiresAt: null };
  }
  const source = raw as Record<string, unknown>;
  return {
    tenantId: readString(source, 'tenantId'),
    storeName: readString(source, 'tenantName'),
    operatorEmail: readString(source, 'operatorEmail'),
    expiresAt: readString(source, 'expiresAt'),
  };
}

// ---- the clock ------------------------------------------------------

/** Parses {@link ImpersonationContext.expiresAt}. `null` for absent or
 * unparseable — including the epoch-number case flagged above. */
export function parseExpiresAt(expiresAt: string | null): number | null {
  if (expiresAt === null) return null;
  const ms = Date.parse(expiresAt);
  return Number.isNaN(ms) ? null : ms;
}

/** Milliseconds left, floored at 0. `null` when the deadline is unknown —
 * which is NOT the same as zero and must not be rendered as "expired". */
export function remainingMs(expiresAt: string | null, now: Date | number = Date.now()): number | null {
  const deadline = parseExpiresAt(expiresAt);
  if (deadline === null) return null;
  const current = typeof now === 'number' ? now : now.getTime();
  return Math.max(0, deadline - current);
}

/**
 * Under five minutes is `critical`.
 *
 * The threshold is doing real work, not decoration. §5: "an operator who can
 * see four minutes left does not start a long task." Four minutes is the
 * spec's own example of the moment the number has to change someone's
 * behaviour, so the band that shouts starts above it.
 */
export const CRITICAL_REMAINING_MS = 5 * 60 * 1000;

export type RemainingLevel = 'unknown' | 'expired' | 'critical' | 'normal';

export function remainingLevel(ms: number | null): RemainingLevel {
  if (ms === null) return 'unknown';
  if (ms <= 0) return 'expired';
  return ms < CRITICAL_REMAINING_MS ? 'critical' : 'normal';
}

/**
 * `m:ss`, rounded UP to the next whole second.
 *
 * Ceiling rather than floor so the display never reads `0:00` while the grant
 * is still live: a countdown that hits zero early teaches an operator that
 * the number lies, and the number is the only thing telling them not to start
 * a five-minute job with two minutes left.
 */
export function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** es-CO reading of the countdown, for the banner's one time slot. */
export function remainingLabel(ms: number | null): string {
  switch (remainingLevel(ms)) {
    case 'unknown':
      return 'Tiempo restante desconocido';
    case 'expired':
      return 'La sesión expiró';
    default:
      return `Quedan ${formatRemaining(ms as number)}`;
  }
}

/** The store's name for the banner, degrading to a phrase that still reads as
 * a warning rather than to an empty gap. */
export function storeLabel(context: ImpersonationContext): string {
  return context.storeName ?? 'una tienda de otro comercio';
}

// ---- the way out ----------------------------------------------------

/**
 * Where the operator lands after exiting.
 *
 * `/plataforma`, not `/` — an operator usually has no merchant tenant of
 * their own, so the merchant root would bounce them through the `(app)`
 * layout into `/onboarding`, i.e. into being asked to create a store.
 *
 * The literal is repeated here rather than imported from `lib/platform-api.ts`
 * on purpose: that module's own doc comment asks that nothing in the merchant
 * app import it, so that a reader can tell from the imports alone which world
 * a file belongs to. A four-character path constant is a cheaper duplication
 * than that boundary is to lose.
 */
export const CONSOLE_PATH = '/plataforma';

export function impersonationReturnPath(context: ImpersonationContext): string {
  return context.tenantId ? `${CONSOLE_PATH}/${context.tenantId}` : CONSOLE_PATH;
}

/**
 * `DELETE` on the issuing route clears the grant cookie (§3). `null` when the
 * tenant id is unknown — the caller then falls back to navigating away, which
 * leaves the cookie to expire on its own. That backstop is the design's, not
 * a workaround: §2 makes the token self-expiring precisely so that no exit
 * path has to be reliable for the session to end.
 */
export function impersonationExitPath(context: ImpersonationContext): string | null {
  return context.tenantId ? `/v1/platform/tenants/${context.tenantId}/impersonate` : null;
}


// ---- when the grant stops being honoured ----------------------------

/**
 * A grant that is present but no longer honourable makes `GET /v1/admin/me`
 * answer **403** with an `IMPERSONATION_*` code — expired, not bound to this
 * operator, or revoked mid-session (`session-context.ts`).
 *
 * That collides with the merchant app's existing reading of 403 on that
 * endpoint, which is `NO_TENANT`, and whose handling is "send them to
 * /onboarding". Without this distinction, an operator whose thirty minutes
 * ran out is redirected into the create-your-store wizard — a Ventia employee
 * invited to found a shop, at the exact moment the correct move is "go back
 * to the console". Hence: the code is read, not the status alone.
 */
export const IMPERSONATION_ERROR_PREFIX = 'IMPERSONATION_';

export function isImpersonationFailure(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false;
  const code = (body as { error?: unknown }).error;
  return typeof code === 'string' && code.startsWith(IMPERSONATION_ERROR_PREFIX);
}
