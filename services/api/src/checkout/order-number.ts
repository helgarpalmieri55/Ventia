import type { Prisma } from '@ventia/db';

/**
 * Allocates the next sequential per-tenant Order.number under concurrency.
 *
 * Assumes the caller's `tx` has ALREADY run the RLS escape (`SET LOCAL ROLE
 * ventia_app` + `set_config('app.tenant_id', ...)`) at the top of the same
 * `platformDb.$transaction` — this helper does not repeat that setup, it
 * only adds the advisory lock + MAX query on top of an already-scoped `tx`.
 *
 * `pg_advisory_xact_lock(hashtext(tenantId))` serializes concurrent callers
 * for the SAME tenant for the lifetime of the enclosing transaction (it's
 * released automatically on commit/rollback, hence "xact") — a second
 * concurrent checkout for the same tenant blocks here until the first
 * commits or rolls back, so the `MAX("number")` read below can never race
 * with another allocation for that tenant. Different tenants hash to
 * (almost certainly) different lock keys and never contend with each other.
 */
export async function nextOrderNumber(tx: Prisma.TransactionClient, tenantId: string): Promise<number> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${tenantId}))`;
  const result = await tx.$queryRaw<{ max: number | null }[]>`
    SELECT MAX("number") as max FROM "Order" WHERE "tenantId" = ${tenantId}::uuid
  `;
  return (result[0]?.max ?? 0) + 1;
}
