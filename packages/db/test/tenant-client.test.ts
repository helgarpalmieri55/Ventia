import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { startTestDb } from './helpers';
import { createTenantDbFactory, CrossTenantError, RawQueryOnTenantClientError } from '../src/tenant-client';

const T1 = '11111111-1111-1111-1111-111111111111';
const T2 = '22222222-2222-2222-2222-222222222222';

let db: Awaited<ReturnType<typeof startTestDb>>;
// `base` is the owner connection — the same role platformDb uses in
// src/index.ts (unscoped, bypasses RLS, full table privileges).
let base: PrismaClient;
let tenantDb: ReturnType<typeof createTenantDbFactory>;
let t2ProductId: string;

beforeAll(async () => {
  db = await startTestDb();
  base = new PrismaClient({ datasources: { db: { url: db.url } } });
  tenantDb = createTenantDbFactory(base);
  for (const [id, slug] of [[T1, 't1'], [T2, 't2']] as const) {
    await base.tenant.create({ data: { id, slug, name: slug, status: 'live' } });
    await base.product.create({ data: { tenantId: id, name: slug, slug, priceCents: 1000 } });
  }
  t2ProductId = (await base.product.findFirstOrThrow({ where: { tenantId: T2 } })).id;
});

afterAll(async () => {
  await base.$disconnect();
  await db.stop();
});

describe('tenantDb', () => {
  it('findMany returns only own-tenant rows without an explicit where', async () => {
    const products = await tenantDb(T1).product.findMany();
    expect(products.map((p) => p.tenantId)).toEqual([T1]);
  });

  it('cannot read another tenant row even with an explicit filter', async () => {
    const other = await tenantDb(T1).product.findFirst({ where: { tenantId: T2 } });
    expect(other).toBeNull();
  });

  it('create injects tenantId', async () => {
    const p = await tenantDb(T1).product.create({
      data: { name: 'nuevo', slug: 'nuevo', priceCents: 500 },
    });
    expect(p.tenantId).toBe(T1);
  });

  it('create naming another tenantId throws CrossTenantError', async () => {
    await expect(
      tenantDb(T1).product.create({
        data: { tenantId: T2, name: 'evil', slug: 'evil', priceCents: 1 },
      }),
    ).rejects.toThrow(CrossTenantError);
  });

  it('updateMany cannot touch another tenant rows', async () => {
    const res = await tenantDb(T1).product.updateMany({ data: { priceCents: 9 } });
    expect(res.count).toBeGreaterThan(0);
    const t2 = await base.product.findFirstOrThrow({ where: { tenantId: T2 } });
    expect(t2.priceCents).toBe(1000);
  });

  it('upsert update branch naming another tenantId throws CrossTenantError', async () => {
    await expect(
      tenantDb(T1).product.upsert({
        where: { tenantId_slug: { tenantId: T1, slug: 't1' } },
        create: { name: 'x', slug: 'x-upsert', priceCents: 1 },
        update: { tenantId: T2 },
      }),
    ).rejects.toThrow(CrossTenantError);
  });
});

// scopeArgs() deliberately leaves `where` untouched for findUnique-style ops
// (findUnique/findUniqueOrThrow/delete/update/upsert's locator) — RLS is the
// backstop that filters those at the database level instead. These tests pin
// that backstop down: without RLS actually working, all three would succeed
// against T2's row.
describe('RLS backstop on unscoped-where operations', () => {
  it('findUnique on another tenant row is RLS-filtered to null', async () => {
    const result = await tenantDb(T1).product.findUnique({ where: { id: t2ProductId } });
    expect(result).toBeNull();
  });

  it('update on another tenant row is rejected', async () => {
    await expect(
      tenantDb(T1).product.update({
        where: { id: t2ProductId },
        data: { priceCents: 1 },
      }),
    ).rejects.toThrow();
    const t2 = await base.product.findUniqueOrThrow({ where: { id: t2ProductId } });
    expect(t2.priceCents).toBe(1000);
  });

  it('delete on another tenant row is rejected', async () => {
    await expect(tenantDb(T1).product.delete({ where: { id: t2ProductId } })).rejects.toThrow();
    await expect(base.product.findUniqueOrThrow({ where: { id: t2ProductId } })).resolves.toMatchObject({
      id: t2ProductId,
    });
  });
});

// The GRANT ... ON ALL TABLES from the rls migration swept up tables with no
// tenantId / RLS policy at all (auth + platform-system tables). The
// revoke_ventia_app_system_tables migration revokes ventia_app's privileges
// on those explicitly; these tests prove tenant-scoped code can no longer
// touch them, while the owner/platform connection still can.
describe('non-RLS system tables are unreachable via tenantDb', () => {
  it('membership queries through tenantDb are rejected (privileges revoked)', async () => {
    await expect(tenantDb(T1).membership.findMany()).rejects.toThrow(/permission denied/i);
  });

  it('platformDb (owner connection) can still query membership', async () => {
    await expect(base.membership.findMany()).resolves.toBeInstanceOf(Array);
  });
});

// $queryRaw/$executeRaw(Unsafe) are top-level client operations, not model
// operations — $allModels.$allOperations never intercepts them — so without
// an explicit block they'd run on the owner connection with no SET ROLE /
// GUC applied: a silent tenant-isolation bypass.
describe('raw queries are blocked on the tenant-scoped client', () => {
  it('$queryRaw rejects', async () => {
    await expect(tenantDb(T1).$queryRaw`SELECT 1`).rejects.toThrow(
      RawQueryOnTenantClientError,
    );
    await expect(tenantDb(T1).$queryRaw`SELECT 1`).rejects.toThrow(/tenant-scoped/i);
  });

  it('$executeRawUnsafe rejects', async () => {
    await expect(tenantDb(T1).$executeRawUnsafe('SELECT 1')).rejects.toThrow(
      RawQueryOnTenantClientError,
    );
    await expect(tenantDb(T1).$executeRawUnsafe('SELECT 1')).rejects.toThrow(/tenant-scoped/i);
  });
});
