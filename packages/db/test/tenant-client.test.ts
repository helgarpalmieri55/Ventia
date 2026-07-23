import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { startTestDb } from './helpers';
import { createTenantDbFactory, CrossTenantError } from '../src/tenant-client';

const T1 = '11111111-1111-1111-1111-111111111111';
const T2 = '22222222-2222-2222-2222-222222222222';

let db: Awaited<ReturnType<typeof startTestDb>>;
let base: PrismaClient;
let tenantDb: ReturnType<typeof createTenantDbFactory>;

beforeAll(async () => {
  db = await startTestDb();
  base = new PrismaClient({ datasources: { db: { url: db.url } } });
  tenantDb = createTenantDbFactory(base);
  for (const [id, slug] of [[T1, 't1'], [T2, 't2']] as const) {
    await base.tenant.create({ data: { id, slug, name: slug, status: 'live' } });
    await base.product.create({ data: { tenantId: id, name: slug, slug, priceCents: 1000 } });
  }
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
