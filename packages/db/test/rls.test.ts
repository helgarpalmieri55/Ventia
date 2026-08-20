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

// ---------------------------------------------------------------------------
// Payment ledger (20260819120000_payment_ledger)
// ---------------------------------------------------------------------------
//
// The `Payment` table stopped being an ordinary tenant-writable table in that
// migration: it is now the append-only, per-attempt record of what a gateway
// said about money, so `ventia_app` holds SELECT and nothing else, and its
// `FOR ALL` policy was replaced with a `FOR SELECT` one to match. These tests
// pin BOTH halves — a merchant can read their own history, and nothing running
// under tenant credentials can write, amend, or erase it.
describe('Payment ledger isolation and append-only privileges', () => {
  const ORDER: Record<string, string> = {};

  beforeAll(async () => {
    // Seeded as the table owner, which bypasses RLS and holds every privilege —
    // the point of these tests is what `ventia_app` can do, so both tenants'
    // rows must exist first. This is also exactly how production writes them:
    // `recordPaymentAttempt` (services/api/src/payments/payment-ledger.ts) runs
    // on `platformDb`, the owner connection, because the tenant role has no
    // INSERT to write them with.
    for (const [tenantId, suffix] of [[T1, 'a'], [T2, 'b']] as const) {
      const order = await prisma.order.create({
        data: {
          tenantId,
          number: 5000,
          reference: `vr_ledger_rls_${suffix}`,
          email: 'comprador@example.com',
          phone: '3000000000',
          shippingAddress: {},
          subtotalCents: 25_000,
          taxCents: 0,
          totalCents: 25_000,
        },
      });
      ORDER[tenantId] = order.id;
      await prisma.payment.create({
        data: {
          tenantId,
          orderId: order.id,
          provider: 'wompi',
          providerRef: `wompi_txn_rls_${suffix}`,
          amountCents: 25_000,
          status: 'PAID',
          raw: { source: 'test', suffix },
        },
      });
    }
  });

  it('tenant 1 sees only its own payment rows', async () => {
    const rows = await asTenant(T1, (tx) =>
      tx.$queryRaw<{ tenantId: string; providerRef: string }[]>`
        SELECT "tenantId", "providerRef" FROM "Payment"
      `,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tenantId).toBe(T1);
    expect(rows[0]!.providerRef).toBe('wompi_txn_rls_a');
  });

  it('a tenant cannot reach another tenant row even by its exact orderId', async () => {
    // The merchant-facing read is "this order's payment history", so the
    // orderId is the natural handle — knowing one from another tenant must
    // still not be enough to read its money history.
    const otherOrderId = ORDER[T2]!;
    const rows = await asTenant(T1, (tx) =>
      tx.$queryRaw<unknown[]>`SELECT "id" FROM "Payment" WHERE "orderId" = ${otherOrderId}::uuid`,
    );
    expect(rows).toHaveLength(0);
  });

  it('no GUC set means no payment rows visible', async () => {
    const rows = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE ventia_app`);
      return tx.$queryRaw<unknown[]>`SELECT "id" FROM "Payment"`;
    });
    expect(rows).toHaveLength(0);
  });

  it('the whole row is readable — no column is withheld from the merchant', async () => {
    // Unlike `WhatsAppNumber`, this table holds no secrets: `raw` is what a
    // gateway said about a payment the merchant already knows about. So the
    // grant is table-level and `SELECT *` must SUCCEED here — asserted so that
    // narrowing it later is a deliberate act with a failing test, not a
    // side effect.
    const rows = await asTenant(T1, (tx) => tx.$queryRaw<unknown[]>`SELECT * FROM "Payment"`);
    expect(rows).toHaveLength(1);
  });

  it('ventia_app cannot append to the ledger', async () => {
    // Writes are not blocked, only relocated: both settle paths write through
    // `platformDb`. A tenant-scoped INSERT would let a merchant manufacture
    // evidence that a gateway said something it never said.
    const orderId = ORDER[T1]!;
    await expect(
      asTenant(T1, (tx) => tx.$executeRaw`
        INSERT INTO "Payment" ("id", "tenantId", "orderId", "provider", "amountCents", "status")
        VALUES (gen_random_uuid(), ${T1}::uuid, ${orderId}::uuid, 'wompi', 1, 'PAID')
      `),
    ).rejects.toThrow(/permission denied/i);
  });

  it('ventia_app cannot amend a ledger row', async () => {
    // The rows most worth tampering with are precisely the ones recording a
    // charge someone would rather forget.
    await expect(
      asTenant(T1, (tx) => tx.$executeRaw`UPDATE "Payment" SET "status" = 'FAILED'`),
    ).rejects.toThrow(/permission denied/i);
  });

  it('ventia_app cannot delete a ledger row', async () => {
    await expect(
      asTenant(T1, (tx) => tx.$executeRaw`DELETE FROM "Payment"`),
    ).rejects.toThrow(/permission denied/i);
  });

  it('the same gateway statement cannot be recorded twice', async () => {
    // The dedupe key is what keeps the 2-minute reconciliation sweep from
    // appending a row per pass for an order nothing is happening to. Asserted
    // on the OWNER connection, so this is the constraint talking, not RLS.
    await expect(
      prisma.payment.create({
        data: {
          tenantId: T1,
          orderId: ORDER[T1]!,
          provider: 'wompi',
          providerRef: 'wompi_txn_rls_a',
          amountCents: 25_000,
          status: 'PAID',
        },
      }),
    ).rejects.toThrow(/[Uu]nique constraint/);
  });

  it('a different statement about the SAME transaction is a new row', async () => {
    // PENDING-then-PAID on one transaction is two real statements, and a
    // partial refund is a third with a different amount. The key must dedupe
    // re-observation without collapsing genuine history.
    const rows = await prisma.payment.createManyAndReturn({
      data: [
        {
          tenantId: T1,
          orderId: ORDER[T1]!,
          provider: 'wompi',
          providerRef: 'wompi_txn_rls_a',
          amountCents: 25_000,
          status: 'PENDING',
        },
        {
          tenantId: T1,
          orderId: ORDER[T1]!,
          provider: 'wompi',
          providerRef: 'wompi_txn_rls_a',
          amountCents: 10_000,
          status: 'PAID',
        },
      ],
    });
    expect(rows).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Subscription (20260819170000_subscription_platform_owned)
// ---------------------------------------------------------------------------
describe('Subscription is platform-owned, not tenant-owned', () => {
  beforeAll(async () => {
    // Seeded as the table owner — which is also exactly how production writes
    // these rows: `SubscriptionService` and the auto-suspend sweep both run on
    // `platformDb`, because the tenant role has no privilege here at all.
    for (const [tenantId, cents] of [
      [T1, 99_900_00],
      [T2, 299_900_00],
    ] as const) {
      await prisma.subscription.create({
        data: { tenantId, plan: 'pro', priceCents: cents, paidUntil: new Date('2026-09-30T04:59:59.999Z') },
      });
    }
  });

  it('ventia_app cannot read a subscription — not even its own', async () => {
    // The difference from every other tenant table in this file, and the whole
    // point of the migration: this is not "tenant 1 sees only tenant 1's row",
    // it is "a merchant-scoped connection sees nothing, because what Ventia
    // charges a merchant is not the merchant's data to read". Getting this
    // wrong in the permissive direction leaks one merchant's negotiated price
    // to another.
    await expect(
      asTenant(T1, (tx) => tx.$queryRaw<unknown[]>`SELECT "priceCents" FROM "Subscription"`),
    ).rejects.toThrow(/permission denied/i);
  });

  it('ventia_app cannot move its own paidUntil — the reason the grant is gone', async () => {
    // `paidUntil` is what the auto-suspend sweep enforces against. Under the
    // old tenant-table grant, any tenant-scoped write path that could be
    // tricked into touching this table would have been a merchant granting
    // themselves free service forever.
    await expect(
      asTenant(T1, (tx) => tx.$executeRaw`UPDATE "Subscription" SET "paidUntil" = now() + interval '100 years'`),
    ).rejects.toThrow(/permission denied/i);
  });

  it('ventia_app cannot insert or delete a subscription', async () => {
    await expect(
      asTenant(T1, (tx) => tx.$executeRaw`
        INSERT INTO "Subscription" ("id", "tenantId", "plan", "priceCents", "updatedAt")
        VALUES (gen_random_uuid(), ${T1}::uuid, 'premium', 0, now())
      `),
    ).rejects.toThrow(/permission denied/i);

    await expect(
      asTenant(T1, (tx) => tx.$executeRaw`DELETE FROM "Subscription"`),
    ).rejects.toThrow(/permission denied/i);
  });

  it('the RLS policy is still there, as the second control behind the grant', async () => {
    // Belt and braces: if a future `GRANT ... ON ALL TABLES IN SCHEMA public`
    // ever re-grants `ventia_app` by accident — which is precisely how this
    // table ended up classified as tenant-owned in the first place — the
    // policy still bounds the damage to one tenant's own row instead of the
    // whole platform's price list.
    const rows = await prisma.$queryRaw<{ relrowsecurity: boolean; policies: bigint }[]>`
      SELECT c.relrowsecurity,
             (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
        FROM pg_class c WHERE c.relname = 'Subscription'
    `;
    expect(rows[0]!.relrowsecurity).toBe(true);
    expect(Number(rows[0]!.policies)).toBeGreaterThan(0);
  });

  it('one subscription per tenant, enforced by the database', async () => {
    // The sweep reads this table to decide whether to take a store offline.
    // "Whichever row sorts last" is not an acceptable answer to that question.
    await expect(
      prisma.subscription.create({ data: { tenantId: T1, plan: 'basico', priceCents: 1 } }),
    ).rejects.toThrow(/[Uu]nique constraint/);
  });
});
