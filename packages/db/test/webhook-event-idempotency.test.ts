import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { startTestDb } from './helpers';

/**
 * Schema-level regression coverage for P3 wave-1 security fix 4: `WebhookEvent`'s
 * idempotency key is `(provider, tenantId, eventId)`, not the global
 * `(provider, eventId)` it shipped as.
 *
 * Why this needs a test of its own, alongside the end-to-end one in
 * `services/api/test/webhooks.test.ts`: the defect lived in the CONSTRAINT, and
 * a constraint is exactly the kind of thing a later `prisma migrate dev` can
 * quietly regenerate differently. These assertions run against a real database
 * with the real migration chain applied, so they fail if the shipped SQL ever
 * stops matching the intent.
 *
 * The defect, concretely: two Ventia tenants sharing ONE gateway merchant
 * account (an explicitly supported shape) share that account's `eventsSecret`,
 * so one signed delivery verifies at either tenant's webhook URL, and
 * `Order.number` is per-tenant so the same reference exists in both. Under the
 * global key, whichever tenant's endpoint was hit SECOND — including the
 * payment's real owner — had its delivery permanently swallowed as a "replay".
 */

const T1 = '11111111-1111-1111-1111-111111111111';
const T2 = '22222222-2222-2222-2222-222222222222';

let db: Awaited<ReturnType<typeof startTestDb>>;
let prisma: PrismaClient;

beforeAll(async () => {
  db = await startTestDb();
  prisma = new PrismaClient({ datasources: { db: { url: db.url } } });
  for (const [id, slug] of [
    [T1, 'wh-t1'],
    [T2, 'wh-t2'],
  ] as const) {
    await prisma.tenant.create({ data: { id, slug, name: slug, status: 'live' } });
  }
});

afterAll(async () => {
  await prisma.$disconnect();
  await db.stop();
});

const row = (tenantId: string | null, eventId = 'evt-shared-1') => ({
  provider: 'wompi',
  eventId,
  tenantId,
  payload: {},
});

describe('WebhookEvent idempotency is scoped per tenant', () => {
  it('the SAME (provider, eventId) can be recorded once per tenant', async () => {
    await prisma.webhookEvent.create({ data: row(T1) });
    // Before the migration this threw P2002 — and in the real handler that
    // meant the second tenant's delivery (possibly the legitimate one) was
    // answered 200 without ever being processed.
    await expect(prisma.webhookEvent.create({ data: row(T2) })).resolves.toMatchObject({ tenantId: T2 });

    const rows = await prisma.webhookEvent.findMany({ where: { provider: 'wompi', eventId: 'evt-shared-1' } });
    expect(rows).toHaveLength(2);
  });

  it('but a genuine replay WITHIN one tenant is still rejected', async () => {
    await expect(prisma.webhookEvent.create({ data: row(T1) })).rejects.toMatchObject({ code: 'P2002' });
  });

  it('the old global (provider, eventId) unique index no longer exists', async () => {
    // Belt and braces: proves the migration DROPPED the old index rather than
    // leaving it in place alongside the new one — a leftover global index
    // would still reject the second tenant's row and silently restore the
    // defect, while the schema file looked correct.
    const indexes = await prisma.$queryRaw<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'WebhookEvent'
    `;
    const defs = indexes.map((i) => i.indexdef);
    expect(defs.some((d) => /UNIQUE.*\(provider, "tenantId", "eventId"\)|UNIQUE.*provider.*tenantId.*eventId/.test(d))).toBe(
      true,
    );
    expect(
      defs.some((d) => /UNIQUE/.test(d) && /provider/.test(d) && /eventId/.test(d) && !/tenantId/.test(d)),
    ).toBe(false);
  });
});
