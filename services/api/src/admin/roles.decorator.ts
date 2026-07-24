import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';

export const ROLES_KEY = 'admin_roles';
export const Roles = (...roles: Array<'owner' | 'staff'>) => SetMetadata(ROLES_KEY, roles);

/**
 * The session shape guaranteed inside every handler behind AdminSessionGuard.
 * The guard's NO_TENANT check (admin-session.guard.ts) rejects any session
 * without a tenantId, without a role, or with role 'platform_admin' BEFORE a
 * request reaches a handler — so by the time AdminSession() hands this back,
 * tenantId is a real tenant id (never null) and role is narrowed to the two
 * admin-portal roles (never null, never 'platform_admin'). Every catalog /
 * csv-import controller and service downstream of the guard should use this
 * type instead of the raw, nullable `SessionContext`.
 */
export interface AdminSessionContext {
  userId: string;
  email: string;
  tenantId: string;
  role: 'owner' | 'staff';
}

export const AdminSession = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  return ctx.switchToHttp().getRequest().adminSession as AdminSessionContext;
});
