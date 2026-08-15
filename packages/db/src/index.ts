import { PrismaClient } from '@prisma/client';
import { createTenantDbFactory } from './tenant-client.js';

/** Unscoped client. Owner connection — bypasses RLS. Platform-admin/system use only.
 *
 * This bypass is Postgres's ordinary table-owner exemption (every RLS policy
 * in this codebase uses plain `ENABLE ROW LEVEL SECURITY`, never `FORCE`,
 * which never applies to a table's owner regardless of role attributes) —
 * not something this client configures itself. It holds only as long as
 * `DATABASE_URL`'s role stays the schema owner in every environment this
 * connects to. That's an invariant, not an incidental detail: genuinely
 * cross-tenant reads with no per-request tenant context (e.g.
 * `services/api/src/payments/stock-reservation.worker.ts`'s expiry sweep)
 * rely on it directly for correctness, not just as a convenience — a future
 * least-privilege change that connects this client as a non-owner role would
 * silently break that sweep's cross-tenant visibility. */
export const platformDb = new PrismaClient();

/** Tenant-scoped client: RLS GUC + role per transaction, tenantId injection. */
export const tenantDb = createTenantDbFactory(platformDb);

export { CrossTenantError, RawQueryOnTenantClientError, createTenantDbFactory } from './tenant-client.js';
export type { TenantClient } from './tenant-client.js';
export { TENANT_MODELS } from './tenant-models.js';
export * from '@prisma/client';
