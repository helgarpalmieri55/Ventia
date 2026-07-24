import { HttpException } from '@nestjs/common';
import { tenantDb } from '@ventia/db';
import type { SessionContext } from '../auth/session-context';

/**
 * Enforces the tenant's plan product limit before `additionalCount` new
 * product(s) are created.
 *
 * Counts only non-archived products (archived rows don't count toward the
 * limit — archiving is how a tenant makes room without losing history). A
 * tenant with no `tenant_limits` row is treated as unlimited: absence of a
 * limits row is not itself a limit of zero.
 *
 * `additionalCount` defaults to 1 (the single-product-create path in
 * products.service.ts). The CSV bulk-import commit path (Task 8) passes the
 * number of CREATE rows in the file (never the updates — replacing an
 * existing product doesn't grow the tenant's product count), so a 500-row
 * file that's mostly updates isn't blocked by a small plan limit.
 */
export async function assertProductLimit(session: SessionContext, additionalCount = 1): Promise<void> {
  const tenantId = session.tenantId!;
  const db = tenantDb(tenantId);

  const limits = await db.tenantLimits.findUnique({ where: { tenantId } });
  if (!limits) return;

  const count = await db.product.count({ where: { status: { not: 'archived' } } });
  if (count + additionalCount > limits.productsMax) {
    throw new HttpException({ error: 'PLAN_LIMIT_EXCEEDED', details: { limit: limits.productsMax } }, 402);
  }
}
