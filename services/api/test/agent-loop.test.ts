import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient as PrismaClientType } from '@ventia/db';
import { startTestDb } from './helpers';
import type { AgentService as AgentServiceType } from '../src/agent/agent.service';

/**
 * The conversation loop, driven against a FAKE Anthropic client.
 *
 * No network call and no API key: the client is a Nest provider precisely so
 * these can assert what the loop does — dispatches tools, persists the
 * transcript, honours the budget, stays inside its turn cap — which is the
 * part that can actually be wrong. What the model chooses to say is not this
 * suite's business.
 */

let db: Awaited<ReturnType<typeof startTestDb>>;
let prisma: PrismaClientType;
let app: INestApplication;
let agent: AgentServiceType;

let tenantId: string;
let variantId: string;

/** Queue of responses the fake client returns, one per `messages.create`. */
let scripted: unknown[] = [];
let createCalls: Array<Record<string, unknown>> = [];

function textResponse(text: string) {
  return {
    content: [{ type: 'text', text }],
    usage: { input_tokens: 10, output_tokens: 5 },
    stop_reason: 'end_turn',
  };
}

function toolUseResponse(name: string, input: unknown, id = `tu_${Math.random().toString(36).slice(2)}`) {
  return {
    content: [{ type: 'tool_use', id, name, input }],
    usage: { input_tokens: 10, output_tokens: 5 },
    stop_reason: 'tool_use',
  };
}

beforeAll(async () => {
  db = await startTestDb();
  process.env.DATABASE_URL = db.url;
  process.env.REDIS_URL = 'redis://localhost:6379';
  // The real client is constructed by AgentModule's factory. It never reaches
  // the network here (it is overridden below), but the SDK constructor is
  // happier with a value present than absent.
  process.env.ANTHROPIC_API_KEY ??= 'sk-ant-test-not-used';

  const { createApp } = await import('../src/main');
  const { ANTHROPIC_CLIENT, AgentService } = await import('../src/agent/agent.service');
  const { Test } = await import('@nestjs/testing');
  const { AppModule } = await import('../src/app.module');

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ANTHROPIC_CLIENT)
    .useValue({
      messages: {
        create: vi.fn(async (params: Record<string, unknown>) => {
          // Deep-copy: the loop passes the SAME `messages` array on every call
          // and keeps pushing to it, so storing the reference would make every
          // recorded call show the conversation's final state rather than what
          // was actually sent at that point.
          createCalls.push(JSON.parse(JSON.stringify(params)) as Record<string, unknown>);
          const next = scripted.shift();
          if (!next) throw new Error('fake anthropic client: no scripted response left');
          return next;
        }),
      },
    })
    .compile();

  app = moduleRef.createNestApplication();
  await app.init();
  agent = app.get(AgentService);
  void createApp;

  ({ platformDb: prisma } = (await import('@ventia/db')) as unknown as { platformDb: PrismaClientType });

  const tenant = await prisma.tenant.create({
    data: { slug: `agent-loop-${Date.now()}`, name: 'Tienda Loop', status: 'live' },
  });
  tenantId = tenant.id;
  await prisma.tenantLimits.create({
    data: { tenantId, productsMax: 100, aiMessagesMonth: 10, staffSeats: 2 },
  });

  const product = await prisma.product.create({
    data: {
      tenantId,
      name: 'Camisa Loop',
      slug: 'camisa-loop',
      priceCents: 80_000,
      stock: 10,
      status: 'active',
      variants: { create: [{ tenantId, option1: 'M', stock: 5 }] },
    },
    include: { variants: true },
  });
  variantId = product.variants[0].id;
}, 180_000);

afterAll(async () => {
  await app.close();
  await db.stop();
});

beforeEach(async () => {
  scripted = [];
  createCalls = [];
  await prisma.agentUsage.deleteMany({ where: { tenantId } });
});

describe('agent loop — a plain answer', () => {
  it('returns the model text and persists both sides of the turn', async () => {
    scripted = [textResponse('¡Hola! ¿En qué te ayudo?')];

    const reply = await agent.respond({ tenantId, message: 'hola' });

    expect(reply.text).toBe('¡Hola! ¿En qué te ayudo?');
    expect(reply.budgetExhausted).toBe(false);

    const messages = await prisma.message.findMany({
      where: { conversationId: reply.conversationId },
      orderBy: { createdAt: 'asc' },
    });
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(messages[0].content).toBe('hola');
  });

  it('records token usage against the tenant\'s month', async () => {
    scripted = [textResponse('listo')];

    await agent.respond({ tenantId, message: 'hola' });

    const usage = await prisma.agentUsage.findFirst({ where: { tenantId } });
    // One SHOPPER TURN, not one API call — the unit the plan limit is sold in.
    expect(usage?.messagesCount).toBe(1);
    expect(usage?.inputTokens).toBe(10);
    expect(usage?.outputTokens).toBe(5);
  });
});

describe('agent loop — tool dispatch', () => {
  it('executes a tool the model asks for and feeds the result back', async () => {
    scripted = [
      toolUseResponse('search_products', { query: 'camisa', limit: 5 }),
      textResponse('Tenemos la Camisa Loop por $80.000.'),
    ];

    const reply = await agent.respond({ tenantId, message: '¿tienen camisas?' });

    expect(reply.text).toContain('Camisa Loop');
    expect(reply.toolResults).toHaveLength(1);
    expect(reply.toolResults[0].name).toBe('search_products');

    // The second call must carry the tool_result back, or the model is
    // answering without ever seeing what the tool found.
    const secondCall = createCalls[1];
    const messages = secondCall.messages as Array<{ role: string; content: unknown }>;
    const lastUser = messages[messages.length - 1];
    expect(lastUser.role).toBe('user');
    expect(JSON.stringify(lastUser.content)).toContain('tool_result');
    expect(JSON.stringify(lastUser.content)).toContain('Camisa Loop');
  });

  it('runs tools with the CONVERSATION\'s tenant, never one the model names', async () => {
    // The model cannot pass a tenant — it does not know one exists. This
    // asserts the executor is reached with the conversation's tenant by
    // showing a cross-tenant product id resolves to nothing.
    const other = await prisma.tenant.create({
      data: { slug: `agent-other-${Date.now()}`, name: 'Otra', status: 'live' },
    });
    const otherProduct = await prisma.product.create({
      data: { tenantId: other.id, name: 'Secreto Ajeno', slug: 'secreto-ajeno', priceCents: 1, status: 'active' },
    });

    scripted = [
      toolUseResponse('get_product', { product_id: otherProduct.id }),
      textResponse('No encontré ese producto.'),
    ];

    const reply = await agent.respond({ tenantId, message: 'dame ese producto' });

    expect((reply.toolResults[0].result as { ok: boolean }).ok).toBe(false);
    expect(JSON.stringify(reply.toolResults)).not.toContain('Secreto Ajeno');
  });

  it('reports a failed tool as an error result rather than dropping it', async () => {
    // Dropping it leaves the model waiting on a result that never arrives.
    scripted = [
      toolUseResponse('get_product', { product_id: 'not-a-uuid' }),
      textResponse('No pude consultarlo.'),
    ];

    await agent.respond({ tenantId, message: 'x' });

    const resultBlocks = JSON.stringify((createCalls[1].messages as unknown[])[
      (createCalls[1].messages as unknown[]).length - 1
    ]);
    expect(resultBlocks).toContain('"is_error":true');
  });

  it('stops after the turn cap instead of looping on tools forever', async () => {
    // A model that keeps calling tools without concluding would otherwise bill
    // the merchant unboundedly for one question.
    scripted = Array.from({ length: 10 }, () => toolUseResponse('search_products', { query: 'x', limit: 1 }));

    const reply = await agent.respond({ tenantId, message: 'busca sin parar' });

    expect(createCalls.length).toBeLessThanOrEqual(4);
    expect(reply.budgetExhausted).toBe(false);
  });

  it('persists a cart link tool result so the widget can render it', async () => {
    scripted = [
      toolUseResponse('create_cart_link', { items: [{ variant_id: variantId, qty: 1 }] }),
      textResponse('Te dejé el carrito listo.'),
    ];

    const reply = await agent.respond({ tenantId, message: 'lo quiero' });

    const result = reply.toolResults[0].result as { ok: boolean; data: { cart_url: string } };
    expect(result.ok).toBe(true);
    expect(result.data.cart_url).toContain('/carrito?c=');
  });
});

describe('agent loop — the budget hard cap', () => {
  it('refuses to call the model at all once the plan limit is reached', async () => {
    // SPEC.md §7: "at 100% → agent replies with a fixed fallback and stops
    // calling the model. Hard cap, no exceptions." The assertion that matters
    // is not the text — it is that zero API calls happened.
    await prisma.agentUsage.create({
      data: {
        tenantId,
        month: `${new Date().getUTCFullYear()}-${String(new Date().getUTCMonth() + 1).padStart(2, '0')}`,
        messagesCount: 10,
      },
    });
    scripted = [textResponse('esto no debería enviarse')];

    const reply = await agent.respond({ tenantId, message: 'hola' });

    expect(reply.budgetExhausted).toBe(true);
    expect(createCalls).toHaveLength(0);
    expect(reply.text).toMatch(/no puedo responderte por chat/i);
  });

  it('still records the shopper\'s message when refused, so the merchant sees the demand', async () => {
    await prisma.agentUsage.create({
      data: {
        tenantId,
        month: `${new Date().getUTCFullYear()}-${String(new Date().getUTCMonth() + 1).padStart(2, '0')}`,
        messagesCount: 10,
      },
    });

    const reply = await agent.respond({ tenantId, message: '¿tienen envío a Cali?' });

    const messages = await prisma.message.findMany({ where: { conversationId: reply.conversationId } });
    expect(messages.map((m) => m.content)).toContain('¿tienen envío a Cali?');
  });

  it('treats a tenant with no plan row as zero budget, not unlimited', async () => {
    // An unprovisioned store getting free unmetered AI is the failure that
    // costs money and hides itself.
    const unprovisioned = await prisma.tenant.create({
      data: { slug: `agent-noplan-${Date.now()}`, name: 'Sin Plan', status: 'live' },
    });
    scripted = [textResponse('no debería enviarse')];

    const reply = await agent.respond({ tenantId: unprovisioned.id, message: 'hola' });

    expect(reply.budgetExhausted).toBe(true);
    expect(createCalls).toHaveLength(0);
  });
});

describe('agent loop — the plan decides which tools exist', () => {
  it('does not offer escalate_to_human to a store without handoff', async () => {
    // The fixture tenant's TenantLimits leaves `humanHandoff` at its default
    // of false. Offering the tool and then refusing the call would teach the
    // model to promise a shopper a callback that is never coming.
    scripted = [textResponse('hola')];

    await agent.respond({ tenantId, message: 'quiero hablar con una persona' });

    const tools = createCalls[0].tools as Array<{ name: string }>;
    expect(tools.map((t) => t.name)).not.toContain('escalate_to_human');
    // The other six are still there — this filters one tool, not the array.
    expect(tools).toHaveLength(6);
  });

  it('offers it once the plan includes handoff', async () => {
    const withHandoff = await prisma.tenant.create({
      data: {
        slug: `agent-handoff-${Date.now()}`,
        name: 'Con Handoff',
        status: 'live',
        limits: { create: { productsMax: 10, aiMessagesMonth: 10, staffSeats: 1, humanHandoff: true } },
      },
    });
    scripted = [textResponse('hola')];

    await agent.respond({ tenantId: withHandoff.id, message: 'quiero hablar con una persona' });

    const tools = createCalls[0].tools as Array<{ name: string }>;
    expect(tools.map((t) => t.name)).toContain('escalate_to_human');
  });

  it('tells the model to USE the tool only when it has it', async () => {
    // The prompt and the tool array must agree, or the model is being told to
    // call something that is not there.
    const withHandoff = await prisma.tenant.create({
      data: {
        slug: `agent-handoff2-${Date.now()}`,
        name: 'Con Handoff 2',
        status: 'live',
        limits: { create: { productsMax: 10, aiMessagesMonth: 10, staffSeats: 1, humanHandoff: true } },
      },
    });
    scripted = [textResponse('a'), textResponse('b')];

    await agent.respond({ tenantId, message: 'hola' });
    await agent.respond({ tenantId: withHandoff.id, message: 'hola' });

    expect(createCalls[0].system as string).not.toContain('escalate_to_human');
    expect(createCalls[1].system as string).toContain('escalate_to_human');
  });
});

describe('agent loop — conversation continuity', () => {
  it('continues an existing conversation rather than starting a new one', async () => {
    scripted = [textResponse('primera'), textResponse('segunda')];

    const first = await agent.respond({ tenantId, message: 'uno' });
    const second = await agent.respond({ tenantId, conversationId: first.conversationId, message: 'dos' });

    expect(second.conversationId).toBe(first.conversationId);
    // The second call must carry the first exchange as history.
    const history = createCalls[1].messages as Array<{ content: unknown }>;
    expect(JSON.stringify(history)).toContain('uno');
    expect(JSON.stringify(history)).toContain('primera');
  });

  it('ignores a conversation id belonging to another tenant', async () => {
    // A caller passing someone else's conversation gets a NEW conversation,
    // not their transcript.
    const other = await prisma.tenant.create({
      data: { slug: `agent-conv-other-${Date.now()}`, name: 'Otra Conv', status: 'live' },
    });
    const foreign = await prisma.conversation.create({
      data: { tenantId: other.id, channel: 'web', status: 'open' },
    });
    scripted = [textResponse('hola')];

    const reply = await agent.respond({ tenantId, conversationId: foreign.id, message: 'hola' });

    expect(reply.conversationId).not.toBe(foreign.id);
  });
});
