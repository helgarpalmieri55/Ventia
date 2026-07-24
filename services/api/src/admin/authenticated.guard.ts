import { CanActivate, ExecutionContext, HttpException, Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { platformDb } from '@ventia/db';
import { getSessionContext, type SessionContext } from '../auth/session-context';
import { AUTH_INSTANCE, type AuthInstance } from './auth-instance';

/** Stashes the raw (possibly tenant-less) session on the request — see
 * AuthenticatedGuard's doc comment for why this is a separate shape from
 * RequestWithAdminSession's narrowed `adminSession`. */
export type RequestWithSession = Request & { session?: SessionContext };

/**
 * Lightweight sibling to AdminSessionGuard: requires only a signed-in
 * better-auth session, with NO membership requirement.
 *
 * AdminSessionGuard's NO_TENANT check (403 whenever `session.tenantId` is
 * null — see admin-session.guard.ts) is exactly wrong for
 * `POST /v1/admin/onboarding/tenant`: provisioning a tenant is the one
 * admin-portal action a signed-in user with NO tenant yet must be allowed to
 * call, and the handler itself needs to see the raw, nullable `tenantId` to
 * decide 409 ALREADY_HAS_TENANT vs "go ahead and create one" (see
 * onboarding.service.ts#provisionTenant). A boolean "skip the tenant check"
 * option on AdminSessionGuard was considered instead, but that guard's whole
 * contract downstream (AdminSessionContext's non-null tenantId/role — see
 * roles.decorator.ts) depends on the check always running; branching its
 * behavior per-route would make every other handler behind it re-verify an
 * invariant that used to be guaranteed. A separate, single-purpose guard
 * keeps that guarantee intact for everyone else.
 */
@Injectable()
export class AuthenticatedGuard implements CanActivate {
  // Explicit @Inject: esbuild (vitest's default TS transform) does not emit
  // TypeScript's `design:paramtypes` decorator metadata, so Nest's implicit
  // constructor-injection cannot resolve AuthInstance by type alone (same
  // caution as AdminSessionGuard's identical constructor).
  constructor(@Inject(AUTH_INSTANCE) private readonly auth: AuthInstance) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<RequestWithSession>();
    const headers = new Headers();
    if (req.headers.cookie) headers.set('cookie', req.headers.cookie);

    const session = await getSessionContext(this.auth, platformDb, headers);
    if (!session) throw new HttpException({ error: 'UNAUTHENTICATED' }, 401);

    req.session = session;
    return true;
  }
}
