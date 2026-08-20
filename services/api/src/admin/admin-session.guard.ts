import { CanActivate, ExecutionContext, HttpException, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { platformDb } from '@ventia/db';
import type { ImpersonationContext } from '@ventia/core';
import { getSessionContext } from '../auth/session-context';
import { assertImpersonatedRequestAllowed } from '../auth/impersonation-policy';
import { ROLES_KEY, type AdminSessionContext } from './roles.decorator';
import { AUTH_INSTANCE, type AuthInstance } from './auth-instance';

// Exported so AdminMeController can read `emailVerified` off the request
// without it being part of AdminSessionContext (see roles.decorator.ts's
// AdminSessionContext doc comment: it's the narrowed, guaranteed-shape
// session used by every catalog/csv-import handler, and emailVerified is
// per-request response data for /me specifically, not identity every
// downstream handler needs).
// `impersonation` rides on the request rather than inside
// AdminSessionContext for the same reason `emailVerified` does: that type is
// the narrowed identity EVERY downstream handler depends on, and it must stay
// the same shape whether or not an operator is behind the request — the whole
// design's point is that an impersonated write is indistinguishable to a
// service, because `userId` is already the right answer. Only `/v1/admin/me`
// reads this, so the admin shell can render its banner from the server's
// answer (design §5).
export type RequestWithAdminSession = Request & {
  adminSession?: AdminSessionContext;
  emailVerified?: boolean;
  impersonation?: ImpersonationContext;
};

@Injectable()
export class AdminSessionGuard implements CanActivate {
  // Explicit @Inject on both params: esbuild (vitest's default TS transform)
  // does not emit TypeScript's `design:paramtypes` decorator metadata, so
  // Nest's implicit constructor-injection cannot resolve Reflector by type
  // alone (see the same caution in tenant.middleware.ts).
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(AUTH_INSTANCE) private readonly auth: AuthInstance,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<RequestWithAdminSession>();
    const headers = new Headers();
    if (req.headers.cookie) headers.set('cookie', req.headers.cookie);

    const session = await getSessionContext(this.auth, platformDb, headers);
    if (!session) throw new HttpException({ error: 'UNAUTHENTICATED' }, 401);
    if (!session.tenantId || !session.role || session.role === 'platform_admin') {
      throw new HttpException({ error: 'NO_TENANT' }, 403);
    }

    // Impersonation policy (design §4), BEFORE the @Roles check so a refused
    // route reports why it was refused rather than a misleading
    // FORBIDDEN_ROLE — the borrowed role is always 'owner', so @Roles would
    // never have refused it anyway.
    if (session.impersonation) {
      assertImpersonatedRequestAllowed(
        session.impersonation.tenantId,
        req.method,
        req.originalUrl ?? req.url,
        req.tenant?.tenantId,
      );
    }

    const required = this.reflector.getAllAndOverride<Array<'owner' | 'staff'> | undefined>(ROLES_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (required && !required.includes(session.role)) {
      throw new HttpException({ error: 'FORBIDDEN_ROLE' }, 403);
    }

    // Suspended-tenant semantics (P1b-6): a suspended tenant may still be
    // read (GET) — e.g. an owner checking settings to see why they're
    // suspended — but every mutation across /v1/admin/* is rejected. The
    // extra lookup is skipped entirely for GET requests (the common case),
    // so the perf cost of this indexed PK read lands only on writes.
    if (req.method !== 'GET') {
      const tenant = await platformDb.tenant.findUnique({
        where: { id: session.tenantId },
        select: { status: true },
      });
      if (tenant?.status === 'suspended') {
        throw new HttpException({ error: 'TENANT_SUSPENDED' }, 403);
      }
    }

    // Narrowed after the check above: tenantId is a non-null string and role
    // is 'owner' | 'staff' (never null, never 'platform_admin') for every
    // handler downstream of this guard.
    const adminSession: AdminSessionContext = {
      userId: session.userId,
      email: session.email,
      tenantId: session.tenantId,
      role: session.role,
    };
    req.adminSession = adminSession;
    req.emailVerified = session.emailVerified;
    req.impersonation = session.impersonation;
    return true;
  }
}
