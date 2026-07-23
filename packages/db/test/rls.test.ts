import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { startTestDb } from './helpers';

const T1 = '11111111-1111-1111-1111-111111111111';
const T2 = '22222222-2222-2222-2222-222222222222';

let db: Awaited<ReturnType<typeof startTestDb>>;
let prisma: PrismaClient;

beforeAll(async () => {
  db = await startTestDb();
  prisma = new PrismaClient({ datasources: { db: { url: db.url } } });
  // seed two tenants + one product each (as table owner, bypasses RLS)
  for (const [id, slug] of [[T1, 't1'], [T2, 't2']] as const) {
    await prisma.tenant.create({ data: { id, slug, name: slug, status: 'live' } });
    await prisma.product.create({
      data: { tenantId: id, name: `p-${slug}`, slug: `p-${slug}`, priceCents: 1000 },
    });
  }
});

afterAll(async () => {
  await prisma.$disconnect();
  await db.stop();
});

async function asTenant<T>(tenantId: string, fn: (tx: Parameters<Parameters<PrismaClient['$transaction']>[0]>[0]) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE ventia_app`);
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    return fn(tx);
  });
}

describe('Postgres RLS', () => {
  it('tenant 1 context sees only tenant 1 products', async () => {
    const rows = await asTenant(T1, (tx) => tx.$queryRaw<{ tenantId: string }[]>`SELECT "tenantId" FROM "Product"`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tenantId).toBe(T1);
  });

  it('cannot insert a row for another tenant', async () => {
    await expect(
      asTenant(T1, (tx) => tx.$executeRaw`
        INSERT INTO "Product" ("id", "tenantId", "name", "slug", "priceCents", "taxRate", "status", "updatedAt")
        VALUES (gen_random_uuid(), ${T2}::uuid, 'evil', 'evil', 1, '19', 'draft', now())
      `),
    ).rejects.toThrow(/row-level security/);
  });

  it('no GUC set means no rows visible', async () => {
    const rows = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE ventia_app`);
      return tx.$queryRaw<unknown[]>`SELECT 1 FROM "Product"`;
    });
    expect(rows).toHaveLength(0);
  });
});
