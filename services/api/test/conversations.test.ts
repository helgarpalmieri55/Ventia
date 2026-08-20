import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient as PrismaClientType } from '@ventia/db';
import { startTestDb } from './helpers';
import type { signUpWithTenant as SignUpWithTenant } from './admin-helpers';

/**
 * The merchant's view of what their agent has been saying.
 *
 * This exists because `escalate_to_human` needs it to mean anything: the
 * handoff email links here, and for a web-widget shopper who never left a
 * phone number this page is the merchant's ONLY way to find out who needs
 * help and why.
 */

let db: Awaited<ReturnType<typeof startTestDb>>;
let redisContainer: StartedTestContainer;
let app: INestApplication;
let prisma: PrismaClientType;
let signUpWithTenant: typeof SignUpWithTenant;

let cookie: string;
let tenantId: string;
let otherTenantId: string;
let escalatedId: string;

beforeAll(async () => {
  db = await startTestDb();
  redisContainer = await new GenericContainer('redis:7-alpine')
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
    .start();

  process.env.DATABASE_URL = db.url;
  process.env.REDIS_URL = `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`;

  const { createApp } = await import('../src/main');
  app = await createApp();
  await app.init();

  ({ signUpWithTenant } = await import('./admin-helpers'));
  ({ platformDb: prisma } = await import('@ventia/db'));

  ({ cookie, tenantId } = await signUpWithTenant('conversations-owner@demo.co', 'owner'));
  ({ tenantId: otherTenantId } = await signUpWithTenant('conversations-other@demo.co', 'owner'));

  const escalated = await seedConversation(tenantId, {
    status: 'escalated',
    shopperRef: '3001234567',
    messages: [
      ['user', '¿Dónde está mi pedido?'],
      ['assistant', 'Déjame revisarlo.'],
      ['user', 'Quiero hablar con una persona.'],
    ],
  });
  escalatedId = escalated.id;
  await seedConversation(tenantId, { status: 'open', messages: [['user', 'hola']] });
  await seedConversation(otherTenantId, { status: 'escalated', messages: [['user', 'secreto ajeno']] });
}, 180_000);

afterAll(async () => {
  await app.close();
  await redisContainer.stop();
  await db.stop();
});

async function seedConversation(
  forTenantId: string,
  opts: { status: string; shopperRef?: string; messages: Array<[string, string]> },
) {
  const conversation = await prisma.conversation.create({
    data: { tenantId: forTenantId, channel: 'web', status: opts.status, shopperRef: opts.shopperRef ?? null },
  });
  for (const [role, content] of opts.messages) {
    await prisma.message.create({
      data: { tenantId: forTenantId, conversationId: conversation.id, role, content },
    });
  }
  return conversation;
}

describe('GET /v1/admin/conversations', () => {
  it('lists this store\'s conversations with enough to scan them', async () => {
    const res = await request(app.getHttpServer()).get('/v1/admin/conversations').set('cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeGreaterThanOrEqual(2);
    const escalated = res.body.items.find((c: { id: string }) => c.id === escalatedId);
    expect(escalated).toMatchObject({ status: 'escalated', shopperRef: '3001234567', messageCount: 3 });
    // The last thing said, so a merchant can triage without opening each row.
    expect(escalated.lastMessage).toBe('Quiero hablar con una persona.');
  });

  it('filters to escalated, which is the reason this page exists', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/admin/conversations?status=escalated')
      .set('cookie', cookie);

    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe(escalatedId);
  });

  it('reports the escalated count even while a filtered list is shown', async () => {
    // So "3 sin atender" stays visible when the merchant is looking at
    // something else.
    const res = await request(app.getHttpServer())
      .get('/v1/admin/conversations?status=open')
      .set('cookie', cookie);

    expect(res.body.items.every((c: { status: string }) => c.status === 'open')).toBe(true);
    expect(res.body.escalatedCount).toBe(1);
  });

  it('ignores a status it does not write rather than returning nothing', async () => {
    // A typo returning an empty list reads as "you have no escalations",
    // which is the one wrong answer this page must never give.
    const res = await request(app.getHttpServer())
      .get('/v1/admin/conversations?status=urgente')
      .set('cookie', cookie);

    expect(res.body.items.length).toBeGreaterThanOrEqual(2);
  });

  it('never lists another store\'s conversations', async () => {
    const res = await request(app.getHttpServer()).get('/v1/admin/conversations').set('cookie', cookie);

    expect(JSON.stringify(res.body)).not.toContain('secreto ajeno');
    expect(res.body.items.every((c: { id: string }) => c.id !== undefined)).toBe(true);
  });

  it('401s without a session', async () => {
    const res = await request(app.getHttpServer()).get('/v1/admin/conversations');
    expect(res.status).toBe(401);
  });
});

describe('GET /v1/admin/conversations/:id', () => {
  it('returns the transcript in order', async () => {
    const res = await request(app.getHttpServer())
      .get(`/v1/admin/conversations/${escalatedId}`)
      .set('cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body.messages.map((m: { content: string }) => m.content)).toEqual([
      '¿Dónde está mi pedido?',
      'Déjame revisarlo.',
      'Quiero hablar con una persona.',
    ]);
  });

  it('leaves out the tool rows, which would bury the conversation', async () => {
    await prisma.message.create({
      data: {
        tenantId,
        conversationId: escalatedId,
        role: 'tool',
        content: '',
        toolCalls: [{ name: 'search_products', result: { ok: true } }],
      },
    });

    const res = await request(app.getHttpServer())
      .get(`/v1/admin/conversations/${escalatedId}`)
      .set('cookie', cookie);

    expect(res.body.messages.every((m: { role: string }) => m.role !== 'tool')).toBe(true);
  });

  it('404s another store\'s conversation', async () => {
    const foreign = await prisma.conversation.findFirstOrThrow({ where: { tenantId: otherTenantId } });

    const res = await request(app.getHttpServer())
      .get(`/v1/admin/conversations/${foreign.id}`)
      .set('cookie', cookie);

    expect(res.status).toBe(404);
  });

  it('404s a malformed id rather than erroring on the query', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/admin/conversations/not-a-uuid')
      .set('cookie', cookie);

    expect(res.status).toBe(404);
  });
});

describe('PATCH /v1/admin/conversations/:id/resolve', () => {
  it('marks an escalation handled, so the list stays meaningful', async () => {
    const conversation = await seedConversation(tenantId, {
      status: 'escalated',
      messages: [['user', 'ayuda']],
    });

    const res = await request(app.getHttpServer())
      .patch(`/v1/admin/conversations/${conversation.id}/resolve`)
      .set('cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('resolved');

    const filtered = await request(app.getHttpServer())
      .get('/v1/admin/conversations?status=escalated')
      .set('cookie', cookie);
    expect(filtered.body.items.map((c: { id: string }) => c.id)).not.toContain(conversation.id);
  });

  it('404s another store\'s conversation instead of resolving it', async () => {
    const foreign = await prisma.conversation.findFirstOrThrow({ where: { tenantId: otherTenantId } });

    const res = await request(app.getHttpServer())
      .patch(`/v1/admin/conversations/${foreign.id}/resolve`)
      .set('cookie', cookie);

    expect(res.status).toBe(404);
    const after = await prisma.conversation.findUniqueOrThrow({ where: { id: foreign.id } });
    expect(after.status).toBe('escalated');
  });
});
