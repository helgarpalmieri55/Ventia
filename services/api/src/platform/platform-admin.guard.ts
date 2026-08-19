import { CanActivate, ExecutionContext, HttpException, Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { AUTH_INSTANCE, type AuthInstance } from '../admin/auth-instance';
import type { PlatformOperatorContext } from './platform-operator.decorator';

export type RequestWithPlatformOperator = Request & { platformOperator?: PlatformOperatorContext };

/** Env var holding the operator allowlist: comma-separated email addresses. */
export const PLATFORM_ADMIN_EMAILS_ENV = 'PLATFORM_ADMIN_EMAILS';

// Memoized parse, keyed on the raw env string. The value is read per request
// (not once at boot) so a test — or an operator rotating the list — sees the
// change without a rebuild; the memo keeps that from re-splitting a string on
// every call while still recomputing the instant the raw value differs.
let allowlistCacheRaw: string | undefined;
let allowlistCache: ReadonlySet<string> = new Set();

/**
 * Parses the allowlist. Emails are lowercased and trimmed; blanks are
 * dropped. An unset, empty, or all-blank value yields an EMPTY set, which
 * `canActivate` treats as "nobody is a platform admin".
 */
export function platformAdminAllowlist(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
  const raw = env[PLATFORM_ADMIN_EMAILS_ENV];
  if (raw === allowlistCacheRaw) return allowlistCache;
  allowlistCacheRaw = raw;
  allowlistCache = new Set(
    (raw ?? '')
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0),
  );
  return allowlistCache;
}

/**
 * Authenticates a **Ventia operator** — not a merchant.
 *
 * ## Why an env allowlist, and not a role in the database
 *
 * There is no platform-operator role that is safe to grant from inside the
 * product today. The three candidates, and why this one won:
 *
 * 1. **`User.isPlatformAdmin` column.** The right long-term answer: an
 *    explicit, auditable, per-user flag. It needs a schema migration, which
 *    is out of scope for this change, so it is filed as a follow-up (see the
 *    "When the column lands" note below).
 *
 * 2. **A `Membership` row with `role: 'platform_admin'`.** Representable
 *    today — `MembershipRole.platform_admin` already exists in the schema and
 *    `Membership.tenantId` is nullable — and therefore tempting. Rejected,
 *    because a membership row is reachable from application code paths that
 *    merchants drive: the staff-invite flow already creates `Membership`
 *    rows, and the only thing standing between "merchant invites a
 *    colleague" and "merchant mints a platform operator" is that
 *    `staffInviteSchema` happens not to accept a `role` field. That is one
 *    careless `...body` spread away from total platform compromise, and it
 *    would be a silent one. A privilege that a merchant-facing write path
 *    could ever produce is not a platform privilege.
 *    It also reads badly through `getSessionContext`, which picks the OLDEST
 *    membership: an operator who also owns a test store would resolve to
 *    whichever row was created first.
 *
 * 3. **An operator allowlist in the environment (chosen).** Granting it
 *    requires editing deployment configuration and restarting/rotating the
 *    service. There is no code path — buggy or otherwise — by which a
 *    merchant's HTTP request writes to `process.env`. That is a categorically
 *    stronger boundary than any row in a database the product also writes to,
 *    and it needs no migration.
 *
 * ## Fail closed
 *
 * An unset or empty `PLATFORM_ADMIN_EMAILS` denies EVERYONE. The tempting
 * inversion ("no allowlist configured, so don't enforce one") would mean that
 * forgetting an env var in a new environment silently publishes cross-tenant
 * GMV and a suspend button to every signed-in merchant on the internet. A
 * platform admin API that is unreachable is an inconvenience; one that is
 * open is the whole company.
 *
 * ## Why `emailVerified` is also required
 *
 * The allowlist names an email address, and `createAuth` sets
 * `requireEmailVerification: false` — anyone may sign up as any address that
 * is not already registered and immediately hold a valid session for it. So
 * if `ops@ventia.co` were on the allowlist but had never signed up, an
 * attacker who read the list (or guessed it — operator addresses at a
 * company's own domain are not secret) could register that exact address and
 * walk in. Requiring `emailVerified` closes it: proving control of the
 * address means receiving the verification mail, which an attacker cannot do
 * for a mailbox they do not own.
 *
 * The other half of that binding is that better-auth is configured with no
 * email-change flow (`user.changeEmail` is not enabled in `auth.ts`), so a
 * merchant cannot rename an existing verified account onto an allowlisted
 * address. **If email change is ever enabled, this guard must additionally
 * require that the address was verified after the change** — better-auth
 * resets `emailVerified` on change, so the existing check would cover it, but
 * it is worth re-testing rather than assuming.
 *
 * ## Deliberately independent of `Membership`
 *
 * This calls `auth.api.getSession` directly instead of the shared
 * `getSessionContext`, which joins `Membership`. The decision to admit an
 * operator must not read a single byte that a merchant-facing write path can
 * influence. Session + verified email + env allowlist, nothing else.
 *
 * ## When the `User.isPlatformAdmin` column lands
 *
 * Require BOTH, do not replace: the column makes operators visible to
 * queries and audit joins, while the env allowlist keeps the grant outside
 * the database. Two independent controls, neither sufficient alone.
 */
@Injectable()
export class PlatformAdminGuard implements CanActivate {
  // Explicit @Inject, like every other guard here: esbuild (vitest's default
  // TS transform) does not emit `design:paramtypes`, so Nest cannot resolve
  // AuthInstance by type alone.
  constructor(@Inject(AUTH_INSTANCE) private readonly auth: AuthInstance) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<RequestWithPlatformOperator>();
    const headers = new Headers();
    if (req.headers.cookie) headers.set('cookie', req.headers.cookie);

    const session = await this.auth.api.getSession({ headers });
    if (!session) throw new HttpException({ error: 'UNAUTHENTICATED' }, 401);

    const allowlist = platformAdminAllowlist();
    if (allowlist.size === 0) {
      // Loud, because the alternative reading of this state ("nobody
      // configured it, so let everyone in") is the failure this log exists to
      // make impossible to reach silently.
      console.error(
        `[platform-admin] ${PLATFORM_ADMIN_EMAILS_ENV} is unset or empty — every /v1/platform request is denied`,
      );
      throw new HttpException({ error: 'NOT_PLATFORM_ADMIN' }, 403);
    }

    const email = session.user.email.trim().toLowerCase();
    // Both conditions collapse into one 403 with one error code: an ordinary
    // merchant probing this API learns only "not for you", never whether the
    // address they tried is on the list or merely unverified.
    if (!session.user.emailVerified || !allowlist.has(email)) {
      throw new HttpException({ error: 'NOT_PLATFORM_ADMIN' }, 403);
    }

    req.platformOperator = { userId: session.user.id, email };
    return true;
  }
}
