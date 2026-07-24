import { HttpException } from '@nestjs/common';
import { tenantDb } from '@ventia/db';
import type { SessionContext } from '../auth/session-context';

/**
 * Enforces the tenant's plan product limit before a new product is created.
 *
 * Counts only non-archived products (archived rows don't count toward the
 * limit — archiving is how a tenant makes room without losing history). A
 * tenant with no `tenant_limits` row is treated as unlimited: absence of a
 * limits row is not itself a limit of zero.
 *
 * Exported (not just used internally by products.service.ts) so the CSV
 * bulk-import commit path (Task 8) can call the same check before writing
 * a batch of products, instead of duplicating this logic.
 */
export async function assertProductLimit(session: SessionContext): Promise<void> {
  const tenantId = session.tenantId!;
  const db = tenantDb(tenantId);

  const limits = await db.tenantLimits.findUnique({ where: { tenantId } });
  if (!limits) return;

  const count = await db.product.count({ where: { status: { not: 'archived' } } });
  if (count >= limits.productsMax) {
    throw new HttpException({ error: 'PLAN_LIMIT_EXCEEDED', details: { limit: limits.productsMax } }, 402);
  }
}
