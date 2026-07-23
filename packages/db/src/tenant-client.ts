import { Prisma, PrismaClient } from '@prisma/client';
import { TENANT_MODELS } from './tenant-models.js';

export class CrossTenantError extends Error {
  constructor(model: string) {
    super(`Cross-tenant write rejected on ${model}`);
    this.name = 'CrossTenantError';
  }
}

type AnyArgs = Record<string, unknown> & { where?: Record<string, unknown>; data?: unknown };

function scopeArgs(model: string, operation: string, args: AnyArgs, tenantId: string): AnyArgs {
  const next: AnyArgs = { ...args };
  const guardData = (data: unknown): unknown => {
    if (Array.isArray(data)) return data.map(guardData);
    if (data && typeof data === 'object') {
      const d = { ...(data as Record<string, unknown>) };
      if ('tenantId' in d && d.tenantId !== tenantId) throw new CrossTenantError(model);
      d.tenantId = tenantId;
      return d;
    }
    return data;
  };
  if (operation === 'create' || operation === 'createMany' || operation === 'upsert') {
    if ('data' in next) next.data = guardData(next.data);
    if ('create' in next) next.create = guardData(next.create);
  }
  if (operation === 'update' || operation === 'updateMany') {
    const d = next.data as Record<string, unknown> | undefined;
    if (d && 'tenantId' in d && d.tenantId !== tenantId) throw new CrossTenantError(model);
  }
  // create/createMany take no `where` at all; findUnique-style ops (and upsert's
  // locator) require the unique where untouched — RLS still filters those at the
  // database level. Every other read/write op gets an AND-scoped where.
  const NO_WHERE_OPS = new Set(['create', 'createMany']);
  const UNSCOPED_WHERE_OPS = new Set(['findUnique', 'findUniqueOrThrow', 'delete', 'update', 'upsert']);
  if (!NO_WHERE_OPS.has(operation) && !UNSCOPED_WHERE_OPS.has(operation)) {
    next.where = { AND: [{ tenantId }, (args.where ?? {}) as object] };
  }
  return next;
}

export function createTenantDbFactory(base: PrismaClient) {
  return function tenantDb(tenantId: string) {
    if (!tenantId) throw new Error('tenantDb requires a tenantId');
    return base.$extends({
      query: {
        $allModels: {
          async $allOperations({ model, operation, args, query }) {
            const scoped = TENANT_MODELS.has(model)
              ? scopeArgs(model, operation, args as AnyArgs, tenantId)
              : args;
            const [, , result] = await base.$transaction([
              base.$executeRawUnsafe('SET LOCAL ROLE ventia_app'),
              base.$executeRaw(
                Prisma.sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`,
              ),
              query(scoped),
            ]);
            return result;
          },
        },
      },
    });
  };
}

export type TenantClient = ReturnType<ReturnType<typeof createTenantDbFactory>>;
