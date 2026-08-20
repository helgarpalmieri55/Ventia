import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient as PrismaClientType } from '@ventia/db';
import { startTestDb } from './helpers';
import type { signUpWithTenant as SignUpWithTenant } from './admin-helpers';
import type {
  purgeExpiredConversations as PurgeExpiredConversations,
  retentionCutoff as RetentionCutoff,
  retentionMonths as RetentionMonths,
} from '../src/agent/conversation-retention.worker';

let db: Awaited<ReturnType<typeof startTestDb>>;
let redisContainer: StartedTestContainer;
let app: INestApplication;
let signUpWithTenant: typeof SignUpWithTenant;
let prisma: PrismaClientType;
let purgeExpiredConversations: typeof PurgeExpiredConversations;
let retentionCutoff: typeof RetentionCutoff;
let retentionMonths: typeof RetentionMonths;

beforeAll(async () => {
  db = await startTestDb();
  redisContainer = await new GenericContainer('redis:7-alpine')
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
    .start();

  // Env vars must be set BEFORE the first import of @ventia/db / ../src/main /
  // ./admin-helpers / the worker module — same pattern as
  // stock-reservation-worker.test.ts.
  process.env.DATABASE_URL = db.url;
  process.env.REDIS_URL = `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`;
  process.env.PAYMENTS_ENCRYPTION_KEY = Buffer.alloc(32, 3).toString('base64');

  // createApp()/app.init() is exercised here deliberately, exactly as
  // stock-reservation-worker.test.ts does: app.init() runs AgentModule's full
  // provider graph including ConversationRetentionWorker, which must NOT start
  // a real BullMQ Queue/Worker against this test's ephemeral Redis. For THIS
  // worker that matters more than for the stock one — an auto-started
  // retention sweep would be DELETING rows in the background of every suite in
  // this repo. A leaked Worker would most likely surface as a hung afterAll.
  const { createApp } = await import('../src/main');
  app = await createApp();
  await app.init();

  ({ signUpWithTenant } = await import('./admin-helpers'));
  ({ platformDb: prisma } = (await import('@ventia/db')) as unknown as { platformDb: PrismaClientType });
  ({ purgeExpiredConversations, retentionCutoff, retentionMonths } = await import(
    '../src/agent/conversation-retention.worker'
  ));
}, 180_000);

afterAll(async () => {
  await app.close();
  await redisContainer.stop();
  await db.stop();
});

afterEach(() => {
  delete process.env.AGENT_RETENTION_MONTHS;
});

const DAY_MS = 24 * 60 * 60 * 1000;
const monthsAgo = (months: number): Date => new Date(Date.now() - months * 30 * DAY_MS);

/**
 * Seeds one Conversation plus `messageCount` Messages, all stamped at `at`.
 * Message bodies are deliberately PII-shaped (a name, a phone, an address) —
 * this is the data Ley 1581 says must not outlive its purpose, and the point
 * of the assertions below is that these exact rows stop existing.
 */
async function seedConversation(
  tenantId: string,
  opts: {
    startedAt: Date;
    status?: string;
    channel?: 'web' | 'whatsapp';
    messageAt?: Date;
    messageCount?: number;
  },
): Promise<string> {
  const conversation = await prisma.conversation.create({
    data: {
      tenantId,
      channel: opts.channel ?? 'web',
      status: opts.status ?? 'open',
      shopperRef: '+573001234567',
      startedAt: opts.startedAt,
    },
  });
  const at = opts.messageAt ?? opts.startedAt;
  const count = opts.messageCount ?? 2;
  for (let i = 0; i < count; i++) {
    await prisma.message.create({
      data: {
        tenantId,
        conversationId: conversation.id,
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: 'Hola, soy Ana Gómez, mi celular es 3001234567 y vivo en Calle 45 #12-30, Bogotá',
        createdAt: at,
      },
    });
  }
  return conversation.id;
}

/** Reads straight out of Postgres, not through the Prisma model layer, so the
 * "the rows are actually gone" claim is checked against the database itself. */
async function rawCounts(tenantId: string): Promise<{ conversations: number; messages: number; usage: number }> {
  const [row] = await prisma.$queryRawUnsafe<{ conversations: bigint; messages: bigint; usage: bigint }[]>(
    `SELECT
       (SELECT count(*) FROM "Conversation" WHERE "tenantId" = $1::uuid) AS conversations,
       (SELECT count(*) FROM "Message"      WHERE "tenantId" = $1::uuid) AS messages,
       (SELECT count(*) FROM "AgentUsage"   WHERE "tenantId" = $1::uuid) AS usage`,
    tenantId,
  );
  return { conversations: Number(row.conversations), messages: Number(row.messages), usage: Number(row.usage) };
}

describe('retentionMonths — env parsing', () => {
  it('defaults to 12 when unset', () => {
    delete process.env.AGENT_RETENTION_MONTHS;
    expect(retentionMonths()).toBe(12);
  });

  it('honours a valid positive integer', () => {
    process.env.AGENT_RETENTION_MONTHS = '6';
    expect(retentionMonths()).toBe(6);
  });

  it.each(['abc', '', '12.5', '-3', '0'])(
    'falls back to 12 for the malformed value %j — never disabling the purge, never purging everything',
    (raw) => {
      process.env.AGENT_RETENTION_MONTHS = raw;
      expect(retentionMonths()).toBe(12);
    },
  );
});

describe('retentionCutoff — month arithmetic', () => {
  it('subtracts whole months', () => {
    expect(retentionCutoff(new Date('2026-08-19T10:00:00Z'), 12).toISOString()).toBe('2025-08-19T10:00:00.000Z');
  });

  it('clamps 29 February back to 28 February rather than rolling forward to 1 March', () => {
    // Rolling forward would move the cutoff LATER, i.e. purge data one day
    // short of the retention window — the wrong direction to be sloppy in.
    expect(retentionCutoff(new Date('2024-02-29T00:00:00Z'), 12).toISOString()).toBe('2023-02-28T00:00:00.000Z');
  });
});

describe('purgeExpiredConversations — aged-out conversations are deleted', () => {
  it('deletes a 13-month-old conversation and every one of its messages, and reports the counts', async () => {
    const { tenantId } = await signUpWithTenant('retention-old@demo.co', 'owner');
    const conversationId = await seedConversation(tenantId, { startedAt: monthsAgo(13), messageCount: 3 });

    const before = await rawCounts(tenantId);
    expect(before).toMatchObject({ conversations: 1, messages: 3 });

    const result = await purgeExpiredConversations();
    expect(result.conversationsDeleted).toBeGreaterThanOrEqual(1);
    expect(result.messagesDeleted).toBeGreaterThanOrEqual(3);
    expect(result.tenantsAffected).toBeGreaterThanOrEqual(1);
    expect(result.cappedOut).toBe(false);

    // Verified against Postgres directly, not just through Prisma's models.
    const after = await rawCounts(tenantId);
    expect(after.conversations).toBe(0);
    expect(after.messages).toBe(0);
    expect(await prisma.conversation.findUnique({ where: { id: conversationId } })).toBeNull();
  });

  it('running the purge again is a safe no-op — the same rows are not re-counted', async () => {
    const { tenantId } = await signUpWithTenant('retention-idempotent@demo.co', 'owner');
    await seedConversation(tenantId, { startedAt: monthsAgo(14) });

    await purgeExpiredConversations();
    expect(await rawCounts(tenantId)).toMatchObject({ conversations: 0, messages: 0 });

    const second = await purgeExpiredConversations();
    expect(second.conversationsDeleted).toBe(0);
    expect(second.messagesDeleted).toBe(0);
  });
});

describe('purgeExpiredConversations — AgentUsage survives (billing history)', () => {
  it('leaves the AgentUsage aggregate for the very same month intact while deleting that month’s conversations', async () => {
    const { tenantId } = await signUpWithTenant('retention-usage@demo.co', 'owner');
    const startedAt = monthsAgo(13);
    await seedConversation(tenantId, { startedAt, messageCount: 4 });

    // The month the purged conversation belongs to — the exact row a naive
    // "delete everything agent-related older than 12 months" would take out,
    // and taking it out would corrupt the merchant's billing history. Verified
    // against the schema: AgentUsage has no FK to Conversation or Message and
    // carries no PII — only tenantId, month, token counts, cost and a message
    // count.
    const month = `${startedAt.getUTCFullYear()}-${String(startedAt.getUTCMonth() + 1).padStart(2, '0')}`;
    await prisma.agentUsage.create({
      data: { tenantId, month, inputTokens: 12_000, outputTokens: 3_400, costCents: 890, messagesCount: 4 },
    });

    await purgeExpiredConversations();

    const after = await rawCounts(tenantId);
    expect(after.conversations).toBe(0);
    expect(after.messages).toBe(0);
    expect(after.usage).toBe(1);

    const usage = await prisma.agentUsage.findUnique({ where: { tenantId_month: { tenantId, month } } });
    expect(usage).toMatchObject({ inputTokens: 12_000, outputTokens: 3_400, costCents: 890, messagesCount: 4 });
  });
});

describe('purgeExpiredConversations — what the age cutoff protects', () => {
  it('leaves a conversation younger than the retention window completely alone', async () => {
    const { tenantId } = await signUpWithTenant('retention-recent@demo.co', 'owner');
    await seedConversation(tenantId, { startedAt: monthsAgo(2), messageCount: 2 });

    await purgeExpiredConversations();

    expect(await rawCounts(tenantId)).toMatchObject({ conversations: 1, messages: 2 });
  });

  it('leaves an OLD conversation that a shopper has written into recently — the WhatsApp thread-reuse case', async () => {
    // whatsapp-inbound.service.ts reuses the most recent non-resolved
    // conversation for a returning shopper forever ("on WhatsApp the thread IS
    // the history"), so a loyal customer writes into a row whose startedAt is
    // years old. A startedAt-only sweep would delete a live thread mid-chat.
    const { tenantId } = await signUpWithTenant('retention-live-thread@demo.co', 'owner');
    const conversationId = await prisma.conversation
      .create({
        data: { tenantId, channel: 'whatsapp', status: 'open', shopperRef: '+573009998877', startedAt: monthsAgo(20) },
      })
      .then((c) => c.id);
    await prisma.message.create({
      data: { tenantId, conversationId, role: 'user', content: 'antiguo', createdAt: monthsAgo(20) },
    });
    await prisma.message.create({
      data: { tenantId, conversationId, role: 'user', content: 'de hoy', createdAt: new Date() },
    });

    await purgeExpiredConversations();

    expect(await rawCounts(tenantId)).toMatchObject({ conversations: 1, messages: 2 });
  });
});

describe('purgeExpiredConversations — an unresolved escalation is never purged', () => {
  it('keeps a 24-month-old ESCALATED conversation, however far past the window it is', async () => {
    // The handoff a merchant has not answered is the one thing that must not
    // vanish out from under them. Protected by status, unconditionally, with
    // no age escape hatch.
    const { tenantId } = await signUpWithTenant('retention-escalated@demo.co', 'owner');
    await seedConversation(tenantId, { startedAt: monthsAgo(24), status: 'escalated', messageCount: 2 });

    const result = await purgeExpiredConversations();
    expect(result.conversationsDeleted).toBe(0);

    expect(await rawCounts(tenantId)).toMatchObject({ conversations: 1, messages: 2 });
  });

  it('purges a same-age RESOLVED conversation from the same tenant in the same run', async () => {
    // The other half of the claim above: the escalated row survives because it
    // is escalated, not because this tenant's rows are somehow all skipped.
    const { tenantId } = await signUpWithTenant('retention-escalated-vs-resolved@demo.co', 'owner');
    const escalatedId = await seedConversation(tenantId, {
      startedAt: monthsAgo(24),
      status: 'escalated',
      messageCount: 1,
    });
    const resolvedId = await seedConversation(tenantId, {
      startedAt: monthsAgo(24),
      status: 'resolved',
      messageCount: 1,
    });

    await purgeExpiredConversations();

    expect(await prisma.conversation.findUnique({ where: { id: escalatedId } })).not.toBeNull();
    expect(await prisma.conversation.findUnique({ where: { id: resolvedId } })).toBeNull();
    expect(await rawCounts(tenantId)).toMatchObject({ conversations: 1, messages: 1 });
  });
});

describe('purgeExpiredConversations — cross-tenant sweep', () => {
  it('purges aged-out conversations from several tenants in one call and leaves a third tenant’s fresh data alone', async () => {
    const a = await signUpWithTenant('retention-tenant-a@demo.co', 'owner');
    const b = await signUpWithTenant('retention-tenant-b@demo.co', 'owner');
    const c = await signUpWithTenant('retention-tenant-c@demo.co', 'owner');

    await seedConversation(a.tenantId, { startedAt: monthsAgo(13), messageCount: 2 });
    await seedConversation(b.tenantId, { startedAt: monthsAgo(18), messageCount: 5 });
    // Tenant C is inside the window — proof the sweep filters by age rather
    // than by "every tenant it touched".
    await seedConversation(c.tenantId, { startedAt: monthsAgo(1), messageCount: 3 });

    const result = await purgeExpiredConversations();
    expect(result.conversationsDeleted).toBeGreaterThanOrEqual(2);
    expect(result.tenantsAffected).toBeGreaterThanOrEqual(2);

    expect(await rawCounts(a.tenantId)).toMatchObject({ conversations: 0, messages: 0 });
    expect(await rawCounts(b.tenantId)).toMatchObject({ conversations: 0, messages: 0 });
    expect(await rawCounts(c.tenantId)).toMatchObject({ conversations: 1, messages: 3 });
  });
});

describe('purgeExpiredConversations — the retention window is configurable', () => {
  it('AGENT_RETENTION_MONTHS=1 purges a 2-month-old conversation that the 12-month default keeps', async () => {
    const { tenantId } = await signUpWithTenant('retention-configurable@demo.co', 'owner');
    await seedConversation(tenantId, { startedAt: monthsAgo(2), messageCount: 2 });

    // Default window first: 2 months old is well inside 12, so nothing goes.
    await purgeExpiredConversations();
    expect(await rawCounts(tenantId)).toMatchObject({ conversations: 1, messages: 2 });

    process.env.AGENT_RETENTION_MONTHS = '1';
    await purgeExpiredConversations();
    expect(await rawCounts(tenantId)).toMatchObject({ conversations: 0, messages: 0 });
  });

  it('a malformed AGENT_RETENTION_MONTHS falls back to 12 months rather than purging everything', async () => {
    const { tenantId } = await signUpWithTenant('retention-malformed-env@demo.co', 'owner');
    await seedConversation(tenantId, { startedAt: monthsAgo(2), messageCount: 2 });

    process.env.AGENT_RETENTION_MONTHS = 'not-a-number';
    const result = await purgeExpiredConversations();

    // The cutoff really is the 12-month one, not "now" and not an Invalid Date.
    expect(result.cutoff.getTime()).toBeLessThan(Date.now() - 300 * DAY_MS);
    expect(Number.isNaN(result.cutoff.getTime())).toBe(false);
    expect(await rawCounts(tenantId)).toMatchObject({ conversations: 1, messages: 2 });
  });
});

describe('purgeExpiredConversations — batching', () => {
  it('drains a backlog larger than one batch (200) in a single run', async () => {
    // PURGE_BATCH_SIZE is 200 and PURGE_MAX_PER_RUN is 2000, so 205 rows
    // proves the while-loop actually re-queries rather than stopping after the
    // first batch — the failure mode that would leave a backlog draining 200 a
    // day forever.
    const { tenantId } = await signUpWithTenant('retention-batching@demo.co', 'owner');
    const startedAt = monthsAgo(15);
    await prisma.conversation.createMany({
      data: Array.from({ length: 205 }, () => ({
        tenantId,
        channel: 'web' as const,
        status: 'open',
        shopperRef: '+573001112233',
        startedAt,
      })),
    });

    const before = await rawCounts(tenantId);
    expect(before.conversations).toBe(205);

    const result = await purgeExpiredConversations();
    expect(result.conversationsDeleted).toBeGreaterThanOrEqual(205);
    expect(result.cappedOut).toBe(false);

    expect(await rawCounts(tenantId)).toMatchObject({ conversations: 0 });
  });
});
