import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { SessionContext } from '../auth/session-context';

export const ROLES_KEY = 'admin_roles';
export const Roles = (...roles: Array<'owner' | 'staff'>) => SetMetadata(ROLES_KEY, roles);

export const AdminSession = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  return ctx.switchToHttp().getRequest().adminSession as SessionContext;
});
