import { platformDb, Prisma } from '@ventia/db';
import type { PlatformOperatorContext } from './platform-operator.decorator';

/**
 * The actor on a platform action that NO HUMAN TOOK — today, only the
 * subscription auto-suspend sweep (`subscription-sweep.worker.ts`).
 *
 * `userId: null` rather than a sentinel UUID, and that is the whole point of
 * the type: `AuditLog.actorUserId` is nullable, so "nobody" is representable
 * honestly. Inventing a `00000000-…` user id would put a row in the audit log
 * that reads like a person did this, and the first question anybody asks of a
 * suspension is which authority ordered it. `actorEmail` carries the same
 * answer in the JSON payload, where a human reading the row will see it.
 */
export const SYSTEM_OPERATOR = {
  userId: null,
  email: 'sistema@ventia',
} as const;

/**
 * Who a platform audit row is attributed to: a real operator behind
 * `PlatformAdminGuard`, or the system itself.
 *
 * Deliberately a union rather than a widened `PlatformOperatorContext` with a
 * nullable `userId`: every HTTP handler still gets the narrow, non-null
 * operator context (an authenticated request always has a user), and only the
 * few functions that both a human and a job can call accept the union.
 */
export type PlatformActor = PlatformOperatorContext | typeof SYSTEM_OPERATOR;

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
  operator: PlatformActor,
  action: `platform.${string}`,
  tenantId: string,
  data?: Record<string, unknown>,
): Promise<void> {
  try {
    await writePlatformAuditOrThrow(operator, action, tenantId, data);
  } catch (err) {
    console.error('[platform-audit] failed to write audit log entry', {
      action,
      tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * The same write, but it PROPAGATES a failure instead of swallowing it.
 *
 * `writePlatformAudit` above must never throw, because it is called AFTER a
 * mutation has already committed and an audit failure must not roll back a
 * change that already happened. Impersonation inverts that ordering, and
 * deliberately: the audit row is written BEFORE the grant is issued, so if
 * the audit write fails, no token exists (impersonation design §3).
 *
 * "An impersonation that is not recorded must not happen" — that ordering is
 * the difference between an audit trail and a best-effort log, and it is only
 * expressible with a function that can fail. Hence two functions rather than
 * a boolean flag on one: the choice between them is a claim about which of
 * the two events came first, and it should be visible at the call site.
 */
export async function writePlatformAuditOrThrow(
  operator: PlatformActor,
  action: `platform.${string}`,
  tenantId: string,
  data?: Record<string, unknown>,
): Promise<void> {
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
}
