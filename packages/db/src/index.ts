import { PrismaClient } from '@prisma/client';
import { createTenantDbFactory } from './tenant-client.js';

/** Unscoped client. Owner connection — bypasses RLS. Platform-admin/system use only. */
export const platformDb = new PrismaClient();

/** Tenant-scoped client: RLS GUC + role per transaction, tenantId injection. */
export const tenantDb = createTenantDbFactory(platformDb);

export { CrossTenantError, createTenantDbFactory } from './tenant-client.js';
export type { TenantClient } from './tenant-client.js';
export { TENANT_MODELS } from './tenant-models.js';
export * from '@prisma/client';
