import { HttpException } from '@nestjs/common';
import type { PrismaClient } from '@ventia/db';
import type { ImpersonationContext } from '@ventia/core';
import { platformAdminAllowlist } from '../platform/platform-admin.guard';
import type { createAuth } from './auth';
import { authSecret, readImpersonationCookie, verifyImpersonationGrant } from './impersonation';

export interface SessionContext {
  userId: string;
  email: string;
  emailVerified: boolean;
  tenantId: string | null;
  role: 'owner' | 'staff' | 'platform_admin' | null;
  /**
   * Present ONLY while a valid operator grant is being presented alongside
   * this session (docs/superpowers/specs/2026-08-19-impersonation-design.md).
   *
   * When it is present, `userId` is still the OPERATOR's own id — that is the
   * entire point of the design, and the reason `writeAudit` needs no change
   * to attribute every impersonated action correctly. `tenantId` is the
   * borrowed scope and `role` is `'owner'`, neither of which comes from a
   * `Membership` row; none is created, read, or implied.
   */
  impersonation?: ImpersonationContext;
}

/**
 * Resolves an impersonation grant, if one is being presented.
 *
 * Returns `null` when no grant cookie is present at all — the overwhelmingly
 * common case, and one that must cost nothing. THROWS when a grant is present
 * but not honourable, rather than silently ignoring it: an operator whose
 * thirty minutes ran out needs to be told that, and an operator holding a
 * grant that fails the binding check needs the request refused rather than
 * quietly served as their own (tenant-less) session, which would read as a
 * confusing `NO_TENANT` and hide a real security event.
 *
 * ## The `op` binding — the check that turns "signed" into "bound"
 *
 * `grant.op` MUST equal the live session's user id. A signed token that is
 * accepted from whoever presents it is a bearer credential: anyone who
 * obtained one out of a log, a screenshot, or a shared machine would hold
 * thirty minutes of owner-level scope inside a named merchant's store. The
 * comparison below is the difference between "the server issued this" and
 * "the server issued this TO YOU", and design §7 names it as one of the two
 * assertions that must be mutation-tested.
 *
 * ## Why the operator's platform privilege is re-checked here
 *
 * Beyond the design's minimum. The grant is self-expiring, so the blast
 * radius of a de-flagged operator is already bounded at thirty minutes — but
 * `UPDATE "User" SET "isPlatformAdmin" = false` is this codebase's documented
 * revocation for an operator (see `PlatformAdminGuard`), and an operator whose
 * privilege was just revoked mid-incident should not keep acting inside a
 * store because a cookie in their browser predates the UPDATE. The read is one
 * indexed PK lookup, on impersonated requests only.
 */
async function resolveImpersonation(
  db: PrismaClient,
  headers: Headers,
  sessionUserId: string,
  sessionEmail: string,
  emailVerified: boolean,
): Promise<ImpersonationContext | null> {
  const token = readImpersonationCookie(headers.get('cookie'));
  if (!token) return null;

  const verified = verifyImpersonationGrant(token, authSecret());
  if (!verified.ok) {
    throw new HttpException(
      { error: verified.reason === 'expired' ? 'IMPERSONATION_EXPIRED' : 'IMPERSONATION_INVALID' },
      403,
    );
  }

  // THE binding check. See the doc comment above.
  if (verified.grant.op !== sessionUserId) {
    throw new HttpException({ error: 'IMPERSONATION_NOT_BOUND' }, 403);
  }

  const email = sessionEmail.trim().toLowerCase();
  const allowlist = platformAdminAllowlist();
  if (!emailVerified || !allowlist.has(email)) {
    throw new HttpException({ error: 'IMPERSONATION_REVOKED' }, 403);
  }
  const operator = await db.user.findUnique({
    where: { id: sessionUserId },
    select: { isPlatformAdmin: true },
  });
  if (!operator?.isPlatformAdmin) {
    throw new HttpException({ error: 'IMPERSONATION_REVOKED' }, 403);
  }

  // The tenant is read for its NAME, which the banner needs so it can say
  // which store rather than showing a uuid (design §5). A grant for a tenant
  // that no longer exists is refused rather than served with a blank name —
  // there is nothing to be inside.
  const tenant = await db.tenant.findUnique({
    where: { id: verified.grant.ten },
    select: { name: true },
  });
  if (!tenant) throw new HttpException({ error: 'IMPERSONATION_INVALID' }, 403);

  return {
    operatorId: verified.grant.op,
    operatorEmail: email,
    tenantId: verified.grant.ten,
    tenantName: tenant.name,
    expiresAt: new Date(verified.grant.exp).toISOString(),
  };
}

export async function getSessionContext(
  auth: ReturnType<typeof createAuth>,
  db: PrismaClient,
  headers: Headers,
): Promise<SessionContext | null> {
  const session = await auth.api.getSession({ headers });
  // A grant is a SCOPE, never a credential: with no session there is nobody
  // to bind it to, so this returns null (→ 401) exactly as it always did,
  // whether or not a grant cookie was sent. Design §7's "rejected when
  // presented with no session" is this line.
  if (!session) return null;

  const impersonation = await resolveImpersonation(
    db,
    headers,
    session.user.id,
    session.user.email,
    session.user.emailVerified,
  );
  if (impersonation) {
    return {
      // The operator's own id. UNCHANGED, always — `writeAudit` reads this,
      // so every audit row written during an impersonation names the operator
      // and the merchant's log shows a Ventia operator acting in their store,
      // which is exactly what happened.
      userId: session.user.id,
      email: session.user.email,
      emailVerified: session.user.emailVerified,
      tenantId: impersonation.tenantId,
      // Not a membership. Support questions are about things only an owner
      // can see, and no `Membership` row is created, read, or implied — which
      // keeps this function's "deliberately independent of Membership"
      // posture intact and means an impersonation can never be mistaken for a
      // staff seat, or count against one.
      role: 'owner',
      impersonation,
    };
  }

  // Deterministic selection: a user who ends up with more than one
  // membership (e.g. invited into a second tenant) must always resolve to
  // the SAME tenant across requests. `findFirst` with no `orderBy` returns
  // whatever row order Postgres/Prisma happens to produce — an
  // implementation detail, not a guarantee — so `orderBy: createdAt: 'asc'`
  // pins the choice to the oldest membership every time.
  const membership = await db.membership.findFirst({
    where: { userId: session.user.id },
    orderBy: { createdAt: 'asc' },
  });
  return {
    userId: session.user.id,
    email: session.user.email,
    emailVerified: session.user.emailVerified,
    tenantId: membership?.tenantId ?? null,
    role: membership?.role ?? null,
  };
}
