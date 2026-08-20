import { CanActivate, ExecutionContext, HttpException, Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { platformDb } from '@ventia/db';
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
 * 1. **`User.isPlatformAdmin` column.** An explicit, auditable, per-user
 *    flag. Now LANDED (migration `20260819140000_user_is_platform_admin`) and
 *    required in ADDITION to the allowlist, not instead of it — see "Both, not
 *    either" below.
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
 * ## Both, not either
 *
 * `User.isPlatformAdmin` is required IN ADDITION to the env allowlist. Each
 * control covers the other's weakness:
 *
 * - The **allowlist** lives outside the database, so no application bug — not
 *   even arbitrary writes through the ORM — can add an operator. But it names
 *   an *address*, and an address is a claim about identity rather than
 *   identity itself.
 * - The **column** names a specific user row, and is invisible to every write
 *   path the product has: better-auth is configured with no
 *   `user.additionalFields`, so it does not know the column exists and cannot
 *   set it during sign-up or profile update, and no endpoint updates it.
 *   Granting it is a deliberate SQL statement by someone who already holds
 *   database credentials. But a column alone could in principle be reached by
 *   a future careless write, which is precisely what the allowlist backstops.
 *
 * Requiring both means an attacker needs to hold an allowlisted verified
 * mailbox AND to have written a row in a database they should not be able to
 * write. Either alone is not enough, which is the whole point.
 *
 * Revocation is the practical payoff: flipping the column to `false` removes
 * an operator immediately, with a SQL statement and no deploy, while the env
 * allowlist continues to bound the set of addresses that could ever qualify.
 *
 * The read is a single `platformDb` lookup by the session's own user id — no
 * `Membership` join, nothing a merchant-facing write path influences, which
 * keeps the "Deliberately independent of `Membership`" property above intact.
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
    // All three conditions collapse into one 403 with one error code: an
    // ordinary merchant probing this API learns only "not for you", never
    // whether the address they tried is on the list, merely unverified, or
    // allowlisted-but-not-flagged.
    //
    // The column is read only after the first two pass, so an unauthorised
    // probe costs no query. `select` is narrowed to the one field: this guard
    // has no business loading a user record.
    if (!session.user.emailVerified || !allowlist.has(email)) {
      throw new HttpException({ error: 'NOT_PLATFORM_ADMIN' }, 403);
    }

    const user = await platformDb.user.findUnique({
      where: { id: session.user.id },
      select: { isPlatformAdmin: true },
    });
    if (!user?.isPlatformAdmin) {
      // Distinct log line, because this is the state an operator hits after
      // the column migration lands and before anyone has run the UPDATE — and
      // "my allowlisted, verified account gets a 403" is otherwise a genuinely
      // confusing thing to debug. Says what to do about it.
      console.error(
        `[platform-admin] ${email} is allowlisted and verified but User.isPlatformAdmin is false — ` +
          `grant it with: UPDATE "User" SET "isPlatformAdmin" = true WHERE email = '${email}';`,
      );
      throw new HttpException({ error: 'NOT_PLATFORM_ADMIN' }, 403);
    }

    req.platformOperator = { userId: session.user.id, email };
    return true;
  }
}
