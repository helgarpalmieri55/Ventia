import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient as PrismaClientType } from '@ventia/db';
import { startTestDb } from './helpers';
import type { AgentToolsService as AgentToolsServiceType } from '../src/agent/agent-tools.service';
import { MAILER, type MailMessage, type Mailer } from '../src/mailer/mailer';

/**
 * `escalate_to_human` — SPEC.md §7's seventh tool, and the one whose failure
 * mode is a person rather than a number: an agent that promises "un asesor te
 * contactará" and then tells nobody has, from the shopper's side, simply lied.
 */

let db: Awaited<ReturnType<typeof startTestDb>>;
let prisma: PrismaClientType;
let app: INestApplication;
let tools: AgentToolsServiceType;
let sentMail: MailMessage[];

let tenantId: string;
/** Same tenant, but its plan does not include handoff. */
let noHandoffTenantId: string;

const MERCHANT_EMAIL = 'dueña@tienda.co';

beforeAll(async () => {
  db = await startTestDb();
  process.env.DATABASE_URL = db.url;
  process.env.REDIS_URL = 'redis://localhost:6379';

  const { createApp } = await import('../src/main');
  app = await createApp();
  await app.init();

  ({ platformDb: prisma } = (await import('@ventia/db')) as unknown as { platformDb: PrismaClientType });
  const { AgentToolsService } = await import('../src/agent/agent-tools.service');
  tools = app.get(AgentToolsService);

  const tenant = await prisma.tenant.create({
    data: {
      slug: `esc-${Date.now()}`,
      name: 'Tienda Escalada',
      status: 'live',
      settings: { storeInfo: { contactEmail: MERCHANT_EMAIL, contactPhone: '3015550000' } },
      limits: { create: { productsMax: 100, aiMessagesMonth: 500, staffSeats: 2, humanHandoff: true } },
    },
  });
  tenantId = tenant.id;

  const noHandoff = await prisma.tenant.create({
    data: {
      slug: `esc-no-${Date.now()}`,
      name: 'Tienda Sin Handoff',
      status: 'live',
      settings: { storeInfo: { contactEmail: 'otra@tienda.co' } },
      limits: { create: { productsMax: 100, aiMessagesMonth: 500, staffSeats: 2, humanHandoff: false } },
    },
  });
  noHandoffTenantId = noHandoff.id;

  // Spying on the shared ConsoleMailer captures the fire-and-forget send
  // without standing up a second module — same pattern as checkout.test.ts.
  const mailer = app.get<Mailer>(MAILER);
  vi.spyOn(mailer, 'send').mockImplementation(async (msg) => {
    sentMail.push(msg);
  });
}, 180_000);

afterAll(async () => {
  await app.close();
  await db.stop();
});

beforeEach(() => {
  sentMail = [];
});

async function newConversation(forTenantId = tenantId, shopperRef: string | null = null) {
  return prisma.conversation.create({
    data: { tenantId: forTenantId, channel: 'web', status: 'open', shopperRef },
  });
}

/** The email is sent fire-and-forget, so a test that asserts on it has to let
 * the microtask queue drain first. */
async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 30));
}

const INPUT = {
  reason: 'la clienta está molesta porque su pedido no llegó',
  transcript_summary: 'Pidió el estado del pedido VNT-1042, lo consulté y sigue en tránsito hace 9 días.',
};

describe('escalate_to_human — the plan gate', () => {
  it('refuses for a store whose plan does not include handoff', async () => {
    const conversation = await newConversation(noHandoffTenantId);

    const result = await tools.execute(
      { tenantId: noHandoffTenantId, conversationId: conversation.id, handoffEnabled: false },
      'escalate_to_human',
      INPUT,
    );
    await flush();

    // An ERROR, not a silent success: the model has to hear "I can't transfer
    // you" so it falls back to offering contact details rather than promising
    // a callback nobody will make.
    expect(result.ok).toBe(false);
    expect(sentMail).toHaveLength(0);

    const after = await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
    expect(after.status).toBe('open');
  });

  it('refuses when there is no conversation to escalate', async () => {
    const result = await tools.execute({ tenantId, handoffEnabled: true }, 'escalate_to_human', INPUT);
    expect(result.ok).toBe(false);
  });

  it('refuses a conversation belonging to another store', async () => {
    const foreign = await newConversation(noHandoffTenantId);

    const result = await tools.execute(
      { tenantId, conversationId: foreign.id, handoffEnabled: true },
      'escalate_to_human',
      INPUT,
    );
    await flush();

    expect(result.ok).toBe(false);
    expect(sentMail).toHaveLength(0);
  });
});

describe('escalate_to_human — what a successful handoff does', () => {
  it('marks the conversation escalated and emails the merchant', async () => {
    const conversation = await newConversation(tenantId, '3009998877');

    const result = await tools.execute(
      { tenantId, conversationId: conversation.id, handoffEnabled: true },
      'escalate_to_human',
      INPUT,
    );
    await flush();

    expect(result.ok).toBe(true);

    // The durable half — what the merchant's admin reads, independent of
    // whether any email was delivered.
    const after = await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
    expect(after.status).toBe('escalated');

    const mail = sentMail.find((m) => m.to === MERCHANT_EMAIL);
    expect(mail).toBeDefined();
    expect(mail?.text).toContain(INPUT.reason);
    expect(mail?.text).toContain(INPUT.transcript_summary);
    // So the merchant can reply without opening the panel.
    expect(mail?.text).toContain('3009998877');
  });

  it('hands the store\'s contact details back, so the shopper has somewhere to go now', async () => {
    const conversation = await newConversation();

    const result = await tools.execute(
      { tenantId, conversationId: conversation.id, handoffEnabled: true },
      'escalate_to_human',
      INPUT,
    );

    expect(result.data).toMatchObject({
      escalated: true,
      contact_email: MERCHANT_EMAIL,
      contact_phone: '3015550000',
    });
  });

  it('says so when the shopper left no contact details', async () => {
    // A web-widget visitor who never identified themselves — the merchant's
    // route back is the conversation, not a reply, and the email must say that
    // rather than leaving a blank line where a phone number should be.
    const conversation = await newConversation(tenantId, null);

    await tools.execute(
      { tenantId, conversationId: conversation.id, handoffEnabled: true },
      'escalate_to_human',
      INPUT,
    );
    await flush();

    const mail = sentMail.find((m) => m.to === MERCHANT_EMAIL);
    expect(mail?.text).toContain('no dejó datos de contacto');
    // And a way to actually find them: for an anonymous shopper the link IS
    // the notice's usefulness.
    expect(mail?.text).toContain(`/conversaciones?c=${conversation.id}`);
  });

  it('does not mail the merchant twice about the same conversation', async () => {
    // A model that calls this twice in one conversation is not a reason to
    // notify a merchant twice about one customer.
    const conversation = await newConversation();
    const ctx = { tenantId, conversationId: conversation.id, handoffEnabled: true };

    const first = await tools.execute(ctx, 'escalate_to_human', INPUT);
    await flush();
    const second = await tools.execute(ctx, 'escalate_to_human', INPUT);
    await flush();

    // Still a success — the model should tell the shopper the same reassuring
    // thing, not report an error at them.
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(sentMail.filter((m) => m.to === MERCHANT_EMAIL)).toHaveLength(1);
  });

  it('still escalates when the merchant has published no contact email', async () => {
    // Nobody gets actively told, but the conversation is recorded and the
    // shopper is not left believing a message went somewhere it did not.
    const silent = await prisma.tenant.create({
      data: {
        slug: `esc-silent-${Date.now()}`,
        name: 'Sin Correo',
        status: 'live',
        limits: { create: { productsMax: 10, aiMessagesMonth: 10, staffSeats: 1, humanHandoff: true } },
      },
    });
    const conversation = await newConversation(silent.id);

    const result = await tools.execute(
      { tenantId: silent.id, conversationId: conversation.id, handoffEnabled: true },
      'escalate_to_human',
      INPUT,
    );
    await flush();

    expect(result.ok).toBe(true);
    expect((result.data as { contact_email: string | null }).contact_email).toBeNull();
    const after = await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
    expect(after.status).toBe('escalated');
  });
});

describe('escalate_to_human — input handling', () => {
  it('rejects a summary long enough to be the whole transcript', async () => {
    const conversation = await newConversation();

    const result = await tools.execute(
      { tenantId, conversationId: conversation.id, handoffEnabled: true },
      'escalate_to_human',
      { reason: 'x'.repeat(10), transcript_summary: 'y'.repeat(1001) },
    );
    await flush();

    expect(result.ok).toBe(false);
    expect(sentMail).toHaveLength(0);
  });

  it('rejects a call with no reason at all', async () => {
    const conversation = await newConversation();

    const result = await tools.execute(
      { tenantId, conversationId: conversation.id, handoffEnabled: true },
      'escalate_to_human',
      { transcript_summary: 'algo pasó' },
    );

    expect(result.ok).toBe(false);
  });
});
