import { platformDb, Prisma } from '@ventia/db';
import type { SessionContext } from '../auth/session-context';

/**
 * AuditLog writes always go through platformDb (the unscoped, owner-role
 * client), never tenantDb. AuditLog is RLS-exempt by design — it isn't
 * itself a tenant-owned catalog/order row, it's the system's own record of
 * what tenants did, and platform admins need to query it across tenants.
 * Routing it through tenantDb would force every audit write through a
 * per-tenant RLS policy that serves no purpose here. This is a deliberate
 * system-context write, not an oversight of the "every other model goes
 * through tenantDb" rule.
 */
export async function writeAudit(
  session: SessionContext,
  action: string,
  entity: string,
  entityId: string,
  data?: unknown,
): Promise<void> {
  await platformDb.auditLog.create({
    data: {
      tenantId: session.tenantId,
      actorUserId: session.userId,
      action,
      entity,
      entityId,
      ...(data !== undefined ? { data: data as Prisma.InputJsonValue } : {}),
    },
  });
}
