import { platformDb, Prisma } from '@ventia/db';
import type { AdminSessionContext } from '../admin/roles.decorator';

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
  session: AdminSessionContext,
  action: string,
  entity: string,
  entityId: string,
  data?: unknown,
): Promise<void> {
  try {
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
  } catch (err) {
    // Audit writes must never fail the already-committed business mutation.
    // Loud log so ops can spot audit-trail gaps (spec §9 requires audit rows).
    console.error('[audit] failed to write audit log entry', {
      action,
      entity,
      entityId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
