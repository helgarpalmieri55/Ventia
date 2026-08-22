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
        data: { tenantId, plan: 'crece', priceCents: cents, paidUntil: new Date('2026-09-30T04:59:59.999Z') },
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
        VALUES (gen_random_uuid(), ${T1}::uuid, 'escala', 0, now())
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
      prisma.subscription.create({ data: { tenantId: T1, plan: 'emprende', priceCents: 1 } }),
    ).rejects.toThrow(/[Uu]nique constraint/);
  });
});

describe('AgentUsage: readable by its tenant, except what it costs us', () => {
  beforeAll(async () => {
    const month = new Date().toISOString().slice(0, 7);
    await prisma.agentUsage.create({
      data: { tenantId: T1, month, messagesCount: 12, inputTokens: 900, outputTokens: 300, costMicroUsd: 4_200n },
    });
  });

  it('a tenant can still read its own meter', async () => {
    // 20260818090000_agent_usage deliberately kept SELECT so a merchant can see
    // their month against their plan. Adding the cost column must not have
    // taken that away.
    const rows = await asTenant(T1, (tx) =>
      tx.$queryRaw<{ messagesCount: number }[]>`SELECT "messagesCount", "inputTokens" FROM "AgentUsage"`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.messagesCount).toBe(12);
  });

  it('a tenant CANNOT read what its messages cost the platform', async () => {
    // The margin on a merchant's own plan is not the merchant's data. This is
    // a column-level grant, and it only works because the migration REVOKED
    // the table-level SELECT and re-granted per column: `REVOKE SELECT (col)`
    // against a table-level grant silently does nothing, which is exactly what
    // the first version of that migration did.
    await expect(
      asTenant(T1, (tx) => tx.$queryRaw<unknown[]>`SELECT "costMicroUsd" FROM "AgentUsage"`),
    ).rejects.toThrow(/permission denied/i);

    await expect(
      asTenant(T1, (tx) => tx.$queryRaw<unknown[]>`SELECT "costCents" FROM "AgentUsage"`),
    ).rejects.toThrow(/permission denied/i);
  });

  it('`SELECT *` is refused too, rather than quietly omitting the column', async () => {
    // The failure mode worth pinning: a star select must not succeed by
    // dropping the columns the role cannot see.
    await expect(
      asTenant(T1, (tx) => tx.$queryRaw<unknown[]>`SELECT * FROM "AgentUsage"`),
    ).rejects.toThrow(/permission denied/i);
  });

  it('a tenant still cannot write the meter at all', async () => {
    // Unchanged from 20260818090000: a cap a tenant can write to is not a cap.
    await expect(
      asTenant(T1, (tx) => tx.$executeRaw`UPDATE "AgentUsage" SET "messagesCount" = 0`),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe('Shopper accounts: tenant data, but the credential is not', () => {
  let accountId: string;

  beforeAll(async () => {
    const customer = await prisma.customer.create({ data: { tenantId: T1, email: 'ana@example.com' } });
    const account = await prisma.shopperAccount.create({
      data: {
        tenantId: T1,
        email: 'ana@example.com',
        passwordHash: 'scrypt$c2FsdA==$a2V5',
        customerId: customer.id,
      },
    });
    accountId = account.id;
    await prisma.shopperAccount.create({ data: { tenantId: T2, email: 'otra@example.com' } });
    await prisma.shopperSession.create({
      data: { tenantId: T1, accountId, tokenHash: 'a'.repeat(64), expiresAt: new Date(Date.now() + 3_600_000) },
    });
    await prisma.shopperToken.create({
      data: {
        tenantId: T1,
        accountId,
        purpose: 'magic_link',
        tokenHash: 'b'.repeat(64),
        expiresAt: new Date(Date.now() + 900_000),
      },
    });
  });

  it('a store sees its own shoppers and not another store\'s', async () => {
    const rows = await asTenant(T1, (tx) =>
      tx.$queryRaw<{ email: string }[]>`SELECT "email" FROM "ShopperAccount"`,
    );
    expect(rows.map((r) => r.email)).toEqual(['ana@example.com']);
  });

  it('the same address at two stores is two separate accounts', async () => {
    // The "per store, not per platform" decision, enforced by the database
    // rather than by a convention some future write path can forget.
    await expect(
      prisma.shopperAccount.create({ data: { tenantId: T1, email: 'ana@example.com' } }),
    ).rejects.toThrow(/[Uu]nique constraint/);

    // ...but the same address at a DIFFERENT store is fine, and is a different
    // person as far as either merchant is concerned.
    const elsewhere = await prisma.shopperAccount.create({
      data: { tenantId: T2, email: 'ana@example.com' },
    });
    expect(elsewhere.tenantId).toBe(T2);
  });

  it('no tenant-scoped query can read a password hash', async () => {
    // Column-level grant, same tool as `WhatsAppNumber.credentialsEnc`. The
    // storefront legitimately reads a shopper's profile under RLS; nothing
    // legitimately reads their credential that way.
    await expect(
      asTenant(T1, (tx) => tx.$queryRaw<unknown[]>`SELECT "passwordHash" FROM "ShopperAccount"`),
    ).rejects.toThrow(/permission denied/i);

    // And a star select is refused rather than quietly dropping the column —
    // which is what makes a careless `findMany()` fail loudly instead of
    // loading credentials into application memory.
    await expect(
      asTenant(T1, (tx) => tx.$queryRaw<unknown[]>`SELECT * FROM "ShopperAccount"`),
    ).rejects.toThrow(/permission denied/i);
  });

  it('a tenant cannot create or modify a shopper account', async () => {
    // Registration, verification and password changes all run on `platformDb`.
    // A merchant-scoped INSERT here would let a store mint logins for
    // addresses it does not control.
    await expect(
      asTenant(T1, (tx) => tx.$executeRaw`
        INSERT INTO "ShopperAccount" ("id", "tenantId", "email", "updatedAt")
        VALUES (gen_random_uuid(), ${T1}::uuid, 'intruso@example.com', now())
      `),
    ).rejects.toThrow(/permission denied/i);

    await expect(
      asTenant(T1, (tx) => tx.$executeRaw`UPDATE "ShopperAccount" SET "emailVerifiedAt" = now()`),
    ).rejects.toThrow(/permission denied/i);
  });

  it('sessions and tokens are invisible to tenant code entirely', async () => {
    // Not narrowed — closed. These hold nothing but credential material, so
    // the tenant role gets no grant at all and the tables cannot be opened.
    await expect(
      asTenant(T1, (tx) => tx.$queryRaw<unknown[]>`SELECT "id" FROM "ShopperSession"`),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      asTenant(T1, (tx) => tx.$queryRaw<unknown[]>`SELECT "id" FROM "ShopperToken"`),
    ).rejects.toThrow(/permission denied/i);
  });

  it('RLS is enabled on all three, as the backstop behind the grants', async () => {
    // If a future `GRANT ... ON ALL TABLES IN SCHEMA public` ever re-grants
    // these by accident — precisely how `Subscription` was mis-classified —
    // the policy still bounds the damage to one store's own rows.
    const rows = await prisma.$queryRaw<{ relname: string; relrowsecurity: boolean; policies: bigint }[]>`
      SELECT c.relname, c.relrowsecurity,
             (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
        FROM pg_class c
       WHERE c.relname IN ('ShopperAccount', 'ShopperSession', 'ShopperToken')
    `;
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.relrowsecurity, row.relname).toBe(true);
      expect(Number(row.policies), row.relname).toBeGreaterThan(0);
    }
  });

  it('deleting the CRM row keeps the login alive', async () => {
    // Anonymisation under Ley 1581 (privacy/ implements it) removes the
    // customer record. It must not delete the person's ability to sign in —
    // ON DELETE SET NULL, not CASCADE.
    const customer = await prisma.customer.create({ data: { tenantId: T2, email: 'borrable@example.com' } });
    const account = await prisma.shopperAccount.create({
      data: { tenantId: T2, email: 'borrable@example.com', customerId: customer.id },
    });

    await prisma.customer.delete({ where: { id: customer.id } });

    const after = await prisma.shopperAccount.findUnique({ where: { id: account.id } });
    expect(after).not.toBeNull();
    expect(after!.customerId).toBeNull();
  });
});

describe('Collections, reviews, addresses and wishlist: ordinary tenant tables', () => {
  let productId: string;
  let accountId: string;
  let orderId: string;

  beforeAll(async () => {
    const product = await prisma.product.findFirstOrThrow({ where: { tenantId: T1 } });
    productId = product.id;
    const account = await prisma.shopperAccount.create({
      data: { tenantId: T1, email: `reviewer-${Date.now()}@example.com` },
    });
    accountId = account.id;
    const order = await prisma.order.create({
      data: {
        tenantId: T1,
        number: 5001,
        reference: `VNT-rev-${Date.now()}`,
        email: 'reviewer@example.com',
        phone: '3001112233',
        shippingAddress: { departamento: 'Bogotá D.C.', municipio: 'Bogotá', linea1: 'Calle 1' },
        subtotalCents: 1000,
        taxCents: 0,
        totalCents: 1000,
      },
    });
    orderId = order.id;
  });

  it('a store sees only its own collections', async () => {
    await prisma.collection.create({ data: { tenantId: T1, name: 'Ofertas', slug: 'ofertas' } });
    await prisma.collection.create({ data: { tenantId: T2, name: 'Ajena', slug: 'ajena' } });

    const rows = await asTenant(T1, (tx) => tx.$queryRaw<{ slug: string }[]>`SELECT "slug" FROM "Collection"`);
    expect(rows.map((r) => r.slug)).toEqual(['ofertas']);
  });

  it('a merchant can write its own collections — these are not read-only tables', async () => {
    // Unlike `AgentUsage` or `ShopperSession`, a collection IS the merchant's
    // own data and the admin edits it through `tenantDb`. The grant has to be
    // there, and a test that only proved isolation would not notice its loss.
    await expect(
      asTenant(T1, (tx) => tx.$executeRaw`
        INSERT INTO "Collection" ("id", "tenantId", "name", "slug", "updatedAt")
        VALUES (gen_random_uuid(), ${T1}::uuid, 'Nuevos', 'nuevos', now())
      `),
    ).resolves.toBeGreaterThan(0);
  });

  it('refuses to write a collection into ANOTHER store', async () => {
    // The WITH CHECK half of the policy. Without it a tenant-scoped insert
    // could name someone else's tenantId and land in their storefront.
    await expect(
      asTenant(T1, (tx) => tx.$executeRaw`
        INSERT INTO "Collection" ("id", "tenantId", "name", "slug", "updatedAt")
        VALUES (gen_random_uuid(), ${T2}::uuid, 'Intruso', 'intruso', now())
      `),
    ).rejects.toThrow(/row-level security/i);
  });

  it('refuses a rating outside 1..5 at the database, not just in Zod', async () => {
    // An out-of-range rating skews every average a shopper reads, and the
    // CHECK is the only layer a future import script cannot route around.
    for (const rating of [0, 6, -1]) {
      await expect(
        prisma.review.create({ data: { tenantId: T1, productId, accountId, orderId, rating } }),
        String(rating),
      ).rejects.toThrow(/Review_rating_range|constraint/i);
    }
    await expect(
      prisma.review.create({ data: { tenantId: T1, productId, accountId, orderId, rating: 5 } }),
    ).resolves.toBeTruthy();
  });

  it('allows one review per shopper per product', async () => {
    // What makes review bombing cost a purchase each time instead of a loop.
    await expect(
      prisma.review.create({ data: { tenantId: T1, productId, accountId, orderId, rating: 1 } }),
    ).rejects.toThrow(/[Uu]nique constraint/);
  });

  it('allows at most ONE default address per shopper', async () => {
    // A partial unique index, because the application version of this rule
    // (clear the old default, then set the new one) is a check-then-act that
    // two browser tabs can interleave — and "which address does checkout
    // pre-fill" must not have two answers.
    const address = { departamento: 'Bogotá D.C.', municipio: 'Bogotá', linea1: 'Calle 1' };
    await prisma.shopperAddress.create({ data: { tenantId: T1, accountId, address, isDefault: true } });

    await expect(
      prisma.shopperAddress.create({ data: { tenantId: T1, accountId, address, isDefault: true } }),
    ).rejects.toThrow(/[Uu]nique constraint/);

    // ...but any number of non-default ones.
    await expect(
      prisma.shopperAddress.create({ data: { tenantId: T1, accountId, address, isDefault: false } }),
    ).resolves.toBeTruthy();
    await expect(
      prisma.shopperAddress.create({ data: { tenantId: T1, accountId, address, isDefault: false } }),
    ).resolves.toBeTruthy();
  });

  it('keeps a wishlist entry unique per shopper and product', async () => {
    await prisma.wishlistItem.create({ data: { tenantId: T1, accountId, productId } });
    await expect(
      prisma.wishlistItem.create({ data: { tenantId: T1, accountId, productId } }),
    ).rejects.toThrow(/[Uu]nique constraint/);
  });

  it('deleting the order takes its review with it', async () => {
    // An erasure request removes the order; a review left behind would claim a
    // purchase that no longer exists, which is exactly the claim it is for.
    const order = await prisma.order.create({
      data: {
        tenantId: T2,
        number: 5002,
        reference: `VNT-rev2-${Date.now()}`,
        email: 'otra@example.com',
        phone: '3001112233',
        shippingAddress: { departamento: 'Bogotá D.C.', municipio: 'Bogotá', linea1: 'Calle 2' },
        subtotalCents: 1000,
        taxCents: 0,
        totalCents: 1000,
      },
    });
    const otherProduct = await prisma.product.findFirstOrThrow({ where: { tenantId: T2 } });
    const otherAccount = await prisma.shopperAccount.create({
      data: { tenantId: T2, email: `otro-${Date.now()}@example.com` },
    });
    const review = await prisma.review.create({
      data: { tenantId: T2, productId: otherProduct.id, accountId: otherAccount.id, orderId: order.id, rating: 4 },
    });

    await prisma.order.delete({ where: { id: order.id } });

    expect(await prisma.review.findUnique({ where: { id: review.id } })).toBeNull();
  });
});
