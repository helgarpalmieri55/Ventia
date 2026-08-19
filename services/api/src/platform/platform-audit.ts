import { platformDb, Prisma } from '@ventia/db';
import type { PlatformOperatorContext } from './platform-operator.decorator';

/**
 * Audit writes for platform-operator actions. The sibling of
 * `../catalog/audit.ts#writeAudit`, with the same two properties: it writes
 * through `platformDb` (AuditLog is RLS-exempt system bookkeeping, not a
 * tenant-owned row — see that file's comment), and it NEVER throws, because
 * an audit failure must not roll back a mutation that already committed.
 *
 * It is a separate function rather than a call into `writeAudit` because
 * `writeAudit` takes an `AdminSessionContext`, whose contract is a MERCHANT
 * session: non-null `tenantId`, role narrowed to `owner | staff`. A platform
 * operator has neither. Faking one to reuse the helper would put a lie
 * (`role: 'owner'`) into the type system at exactly the boundary these two
 * authorities are supposed to stay separable across.
 *
 * `tenantId` on the row is the tenant ACTED UPON, not the actor's (the actor
 * has none), so a merchant's own audit timeline shows platform actions taken
 * against them — "why did my store go down" is answerable from one query.
 * `actorUserId` is the operator, and `data.actorEmail` records which
 * allowlisted address it was, since the allowlist is the thing that granted
 * the authority and it can change between the action and the investigation.
 */
export async function writePlatformAudit(
  operator: PlatformOperatorContext,
  action: `platform.${string}`,
  tenantId: string,
  data?: Record<string, unknown>,
): Promise<void> {
  try {
    await platformDb.auditLog.create({
      data: {
        tenantId,
        actorUserId: operator.userId,
        action,
        entity: 'Tenant',
        entityId: tenantId,
        data: { actorEmail: operator.email, ...(data ?? {}) } as Prisma.InputJsonValue,
      },
    });
  } catch (err) {
    console.error('[platform-audit] failed to write audit log entry', {
      action,
      tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
