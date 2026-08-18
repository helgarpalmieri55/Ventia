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

// ---------------------------------------------------------------------------
// WhatsApp channel (20260818120000_whatsapp_numbers)
// ---------------------------------------------------------------------------
describe('WhatsAppNumber isolation and secret protection', () => {
  beforeAll(async () => {
    // Seeded as the table owner, which bypasses RLS — the point of these tests
    // is what `ventia_app` can see, so both rows must exist first.
    for (const [tenantId, suffix] of [[T1, 'a'], [T2, 'b']] as const) {
      await prisma.whatsAppNumber.create({
        data: {
          tenantId,
          provider: 'cloud',
          externalId: `phone-number-id-${suffix}`,
          displayPhone: `+5730012345${suffix === 'a' ? '1' : '2'}`,
          status: 'connected',
          credentialsEnc: `iv:tag:ciphertext-${suffix}`,
          verifyToken: `verify-token-${suffix}`,
        },
      });
    }
  });

  it('tenant 1 cannot read tenant 2 WhatsApp numbers', async () => {
    const rows = await asTenant(T1, (tx) =>
      tx.$queryRaw<{ tenantId: string; externalId: string }[]>`
        SELECT "tenantId", "externalId" FROM "WhatsAppNumber"
      `,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tenantId).toBe(T1);
    expect(rows[0]!.externalId).toBe('phone-number-id-a');
  });

  it('a tenant cannot reach another tenant row even by its exact routing key', async () => {
    // The routing key is globally unique and therefore guessable/enumerable —
    // knowing it must still not be enough to read the row it belongs to.
    const rows = await asTenant(T1, (tx) =>
      tx.$queryRaw<unknown[]>`
        SELECT "id" FROM "WhatsAppNumber" WHERE "externalId" = 'phone-number-id-b'
      `,
    );
    expect(rows).toHaveLength(0);
  });

  it('no GUC set means no WhatsApp numbers visible', async () => {
    const rows = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE ventia_app`);
      return tx.$queryRaw<unknown[]>`SELECT "id" FROM "WhatsAppNumber"`;
    });
    expect(rows).toHaveLength(0);
  });

  it('externalId is globally unique, so a second tenant cannot claim it', async () => {
    // Owner connection, so this is the constraint talking and not RLS: even
    // platform code cannot let two tenants own one routing key.
    await expect(
      prisma.whatsAppNumber.create({
        data: {
          tenantId: T2,
          provider: 'cloud',
          externalId: 'phone-number-id-a',
          displayPhone: '+573001234599',
        },
      }),
    ).rejects.toThrow(/[Uu]nique constraint/);
  });

  // Postgres reports a query that touches a column the role has no grant on as
  // `permission denied for table <t>` (SQLSTATE 42501), not "for column" — the
  // message names the table even though the grant that is missing is per-column.
  it('ventia_app cannot read credentialsEnc', async () => {
    await expect(
      asTenant(T1, (tx) => tx.$queryRaw<unknown[]>`SELECT "credentialsEnc" FROM "WhatsAppNumber"`),
    ).rejects.toThrow(/permission denied for table "?WhatsAppNumber/i);
  });

  it('ventia_app cannot read verifyToken', async () => {
    await expect(
      asTenant(T1, (tx) => tx.$queryRaw<unknown[]>`SELECT "verifyToken" FROM "WhatsAppNumber"`),
    ).rejects.toThrow(/permission denied for table "?WhatsAppNumber/i);
  });

  it('SELECT * fails loudly rather than leaking the secret columns', async () => {
    // This is the case the column-level grant exists for: `SELECT *` is what an
    // ORM emits by default, so it must error, not silently succeed.
    await expect(
      asTenant(T1, (tx) => tx.$queryRaw<unknown[]>`SELECT * FROM "WhatsAppNumber"`),
    ).rejects.toThrow(/permission denied for table "?WhatsAppNumber/i);
  });

  it('the admin-visible columns are readable under tenant context', async () => {
    const rows = await asTenant(T1, (tx) =>
      tx.$queryRaw<{ displayPhone: string; status: string }[]>`
        SELECT "displayPhone", "status" FROM "WhatsAppNumber"
      `,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('connected');
    expect(rows[0]!.displayPhone).toBe('+57300123451');
  });

  it('ventia_app cannot register a number for itself or anyone else', async () => {
    // Registering a number is a platformDb operation (it encrypts credentials
    // with the platform key); tenant-scoped code must not be able to claim an
    // unowned phone_number_id and start receiving another business's traffic.
    await expect(
      asTenant(T1, (tx) => tx.$executeRaw`
        INSERT INTO "WhatsAppNumber" ("id", "tenantId", "provider", "externalId", "displayPhone", "updatedAt")
        VALUES (gen_random_uuid(), ${T1}::uuid, 'cloud', 'phone-number-id-stolen', '+573000000000', now())
      `),
    ).rejects.toThrow(/permission denied/i);
  });

  it('ventia_app cannot repoint an existing number', async () => {
    await expect(
      asTenant(T1, (tx) => tx.$executeRaw`
        UPDATE "WhatsAppNumber" SET "externalId" = 'phone-number-id-repointed'
      `),
    ).rejects.toThrow(/permission denied/i);
  });

  it('ventia_app cannot delete a number', async () => {
    await expect(
      asTenant(T1, (tx) => tx.$executeRaw`DELETE FROM "WhatsAppNumber"`),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe('Message inbound dedupe (tenant-scoped externalId)', () => {
  const CONV: Record<string, string> = {};

  beforeAll(async () => {
    for (const tenantId of [T1, T2]) {
      const conv = await prisma.conversation.create({
        data: { tenantId, channel: 'whatsapp', shopperRef: '573001234567' },
      });
      CONV[tenantId] = conv.id;
    }
  });

  it('rejects a redelivered provider message id within one tenant', async () => {
    const data = {
      tenantId: T1,
      conversationId: CONV[T1]!,
      role: 'user',
      content: 'hola',
      externalId: 'wamid.RETRY',
    };
    await prisma.message.create({ data });
    await expect(prisma.message.create({ data })).rejects.toThrow(/[Uu]nique constraint/);
  });

  it('lets a different tenant carry the same provider message id', async () => {
    // A shared provider account delivers one id to both tenants; a global
    // unique key would swallow the second one permanently.
    const row = await prisma.message.create({
      data: {
        tenantId: T2,
        conversationId: CONV[T2]!,
        role: 'user',
        content: 'hola',
        externalId: 'wamid.RETRY',
      },
    });
    expect(row.externalId).toBe('wamid.RETRY');
  });

  it('allows many null externalIds (web widget messages)', async () => {
    for (let i = 0; i < 3; i += 1) {
      await prisma.message.create({
        data: { tenantId: T1, conversationId: CONV[T1]!, role: 'assistant', content: `web ${i}` },
      });
    }
    const count = await prisma.message.count({ where: { tenantId: T1, externalId: null } });
    expect(count).toBe(3);
  });
});
