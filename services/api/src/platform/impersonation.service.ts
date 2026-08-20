import { HttpException, Injectable } from '@nestjs/common';
import { platformDb } from '@ventia/db';
import { IMPERSONATION_TTL_MS, type ImpersonationContext } from '@ventia/core';
import { issueImpersonationGrant, authSecret } from '../auth/impersonation';
import type { PlatformOperatorContext } from './platform-operator.decorator';
import { writePlatformAudit, writePlatformAuditOrThrow } from './platform-audit';

/**
 * Issuing and ending an impersonation grant
 * (docs/superpowers/specs/2026-08-19-impersonation-design.md §3).
 *
 * Nothing is minted for the merchant here — no `Session` row, no
 * `Membership`, no credential of any kind. The only artifact is a signed,
 * self-expiring scope bound to the OPERATOR who asked for it, which is why
 * this service can be this small.
 */
@Injectable()
export class ImpersonationService {
  /**
   * Ordering is the whole method: **the audit row is written before the token
   * exists.**
   *
   * `writePlatformAuditOrThrow`, not the swallowing `writePlatformAudit`: if
   * the audit write fails the caller gets a 500 and no grant, because an
   * impersonation that is not recorded must not happen. Every other platform
   * mutation uses the swallowing variant for the opposite and equally correct
   * reason — there, the mutation has already committed and an audit failure
   * must not roll it back.
   */
  async start(
    tenantId: string,
    reason: string | undefined,
    operator: PlatformOperatorContext,
  ): Promise<{ token: string; maxAgeMs: number; impersonation: ImpersonationContext }> {
    const tenant = await platformDb.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, name: true, slug: true, status: true },
    });
    if (!tenant) throw new HttpException({ error: 'TENANT_NOT_FOUND' }, 404);

    const now = Date.now();
    const expiresAt = new Date(now + IMPERSONATION_TTL_MS).toISOString();

    // BEFORE the token. See the doc comment.
    await writePlatformAuditOrThrow(operator, 'platform.tenant.impersonation_started', tenantId, {
      tenantSlug: tenant.slug,
      tenantStatus: tenant.status,
      expiresAt,
      ...(reason ? { reason } : {}),
    });

    const { token, grant } = issueImpersonationGrant(operator.userId, tenantId, authSecret(), now);

    return {
      token,
      // The cookie's own lifetime matches the signature's, so a browser drops
      // it at the same instant the server would stop honouring it. The
      // signature is still the authority — a cookie that outlived its `exp`
      // (clock skew, a client that ignores `Max-Age`) verifies as expired.
      maxAgeMs: grant.exp - now,
      impersonation: {
        operatorId: operator.userId,
        operatorEmail: operator.email,
        tenantId,
        tenantName: tenant.name,
        expiresAt: new Date(grant.exp).toISOString(),
      },
    };
  }

  /**
   * Ending is clearing the cookie, and the caller does that — this only
   * records it.
   *
   * The swallowing `writePlatformAudit` here, unlike `start`: the grant is
   * gone from the operator's browser either way, and refusing to end an
   * impersonation because the audit row would not write is precisely
   * backwards. The token expiring on its own is the backstop; this is the
   * mechanism.
   */
  async end(tenantId: string, operator: PlatformOperatorContext): Promise<{ ended: true }> {
    await writePlatformAudit(operator, 'platform.tenant.impersonation_ended', tenantId);
    return { ended: true };
  }
}
