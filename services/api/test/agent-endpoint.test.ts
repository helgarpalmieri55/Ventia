import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import Redis from 'ioredis';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient as PrismaClientType } from '@ventia/db';
import { startTestDb } from './helpers';

/**
 * The storefront's public HTTP surface for the agent.
 *
 * `agent-loop.test.ts` covers what the loop DOES with a model; this file
 * covers everything between an anonymous HTTP request and that loop — tenant
 * resolution, body validation, the SSE framing, and the per-conversation
 * throttle. The Anthropic client is the same fake, for the same reason: none
 * of the properties asserted here depend on what a model would actually say.
 */

const AGENT_DOMAINS = ['agent-a.ventia.localhost', 'agent-b.ventia.localhost', 'agent-draft.ventia.localhost'];

let db: Awaited<ReturnType<typeof startTestDb>>;
let prisma: PrismaClientType;
let app: INestApplication;
let redis: Redis;

let tenantId: string;
let otherTenantId: string;
let variantId: string;

let scripted: unknown[] = [];
let createCalls: Array<Record<string, unknown>> = [];

function textResponse(text: string) {
  return {
    content: [{ type: 'text', text }],
    usage: { input_tokens: 10, output_tokens: 5 },
    stop_reason: 'end_turn',
  };
}

function toolUseResponse(name: string, input: unknown) {
  return {
    content: [{ type: 'tool_use', id: `tu_${Math.random().toString(36).slice(2)}`, name, input }],
    usage: { input_tokens: 10, output_tokens: 5 },
    stop_reason: 'tool_use',
  };
}

/** Splits an SSE body into `[eventName, parsedData]` pairs. */
function parseSse(body: string): Array<[string, Record<string, unknown>]> {
  return body
    .split('\n\n')
    .filter((chunk) => chunk.trim().length > 0)
    .map((chunk) => {
      const event = /^event: (.+)$/m.exec(chunk)?.[1] ?? '';
      const data = /^data: (.+)$/m.exec(chunk)?.[1] ?? '{}';
      return [event, JSON.parse(data) as Record<string, unknown>];
    });
}

beforeAll(async () => {
  db = await startTestDb();
  process.env.DATABASE_URL = db.url;
  process.env.REDIS_URL = 'redis://localhost:6379';
  process.env.ANTHROPIC_API_KEY ??= 'sk-ant-test-not-used';

  // DomainResolver caches domain → tenant in the shared dev Redis for 60s, so
  // a previous local run's tenantId would otherwise be served against this
  // run's fresh Postgres.
  redis = new Redis(process.env.REDIS_URL);
  await redis.del(...AGENT_DOMAINS.map((d) => `tenant:domain:${d}`));

  const { ANTHROPIC_CLIENT } = await import('../src/agent/agent.service');
  const { Test } = await import('@nestjs/testing');
  const { AppModule } = await import('../src/app.module');

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ANTHROPIC_CLIENT)
    .useValue({
      messages: {
        create: vi.fn(async (params: Record<string, unknown>) => {
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

  ({ platformDb: prisma } = (await import('@ventia/db')) as unknown as { platformDb: PrismaClientType });

  const tenant = await prisma.tenant.create({
    data: { slug: `agent-ep-${Date.now()}`, name: 'Tienda Endpoint', status: 'live' },
  });
  tenantId = tenant.id;
  await prisma.tenantDomain.create({ data: { tenantId, domain: AGENT_DOMAINS[0], isPrimary: true } });
  // Generous, so the budget cap is never what a throttle test is measuring.
  await prisma.tenantLimits.create({
    data: { tenantId, productsMax: 100, aiCreditsMonth: 500, staffSeats: 2 },
  });

  const other = await prisma.tenant.create({
    data: { slug: `agent-ep-other-${Date.now()}`, name: 'Otra Endpoint', status: 'live' },
  });
  otherTenantId = other.id;
  await prisma.tenantDomain.create({ data: { tenantId: otherTenantId, domain: AGENT_DOMAINS[1], isPrimary: true } });
  await prisma.tenantLimits.create({
    data: { tenantId: otherTenantId, productsMax: 100, aiCreditsMonth: 500, staffSeats: 2 },
  });

  const draft = await prisma.tenant.create({
    data: { slug: `agent-ep-draft-${Date.now()}`, name: 'Borrador', status: 'draft' },
  });
  await prisma.tenantDomain.create({ data: { tenantId: draft.id, domain: AGENT_DOMAINS[2], isPrimary: true } });

  const product = await prisma.product.create({
    data: {
      tenantId,
      name: 'Camisa Endpoint',
      slug: 'camisa-endpoint',
      priceCents: 90_000,
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
  await redis.quit();
  await db.stop();
});

beforeEach(() => {
  scripted = [];
  createCalls = [];
});

/** A POST to the JSON route as an anonymous shopper on `domain`. */
function post(domain: string, body: unknown) {
  return request(app.getHttpServer()).post('/v1/storefront/agent/messages').set('Host', domain).send(body);
}

describe('agent endpoint — who is allowed to reach it', () => {
  it('answers an anonymous shopper on a live storefront', async () => {
    scripted = [textResponse('¡Claro que sí!')];

    const res = await post(AGENT_DOMAINS[0], { message: '¿tienen camisas?' });

    expect(res.status).toBe(201);
    expect(res.body.text).toBe('¡Claro que sí!');
    expect(res.body.conversationId).toBeTruthy();
  });

  it('404s on a domain no tenant owns', async () => {
    const res = await post('nobody.ventia.localhost', { message: 'hola' });
    expect(res.status).toBe(404);
    expect(createCalls).toHaveLength(0);
  });

  it('404s a draft store exactly like an unknown one', async () => {
    // A prober must not be able to learn that a business exists at a domain
    // before its merchant has launched it — same body, same status.
    const res = await post(AGENT_DOMAINS[2], { message: 'hola' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('TENANT_NOT_FOUND');
    expect(createCalls).toHaveLength(0);
  });

  it('takes the tenant from the domain, never from the body', async () => {
    // The body names another store. It must be ignored outright — a caller who
    // could choose a tenant could spend another merchant's AI budget.
    scripted = [textResponse('hola')];

    const res = await post(AGENT_DOMAINS[0], { message: 'hola', tenantId: otherTenantId });

    expect(res.status).toBe(201);
    const conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: res.body.conversationId } });
    expect(conversation.tenantId).toBe(tenantId);
  });

  it('starts a new conversation rather than adopting another store\'s', async () => {
    const foreign = await prisma.conversation.create({
      data: { tenantId: otherTenantId, channel: 'web', status: 'open' },
    });
    scripted = [textResponse('hola')];

    const res = await post(AGENT_DOMAINS[0], { message: 'hola', conversationId: foreign.id });

    expect(res.status).toBe(201);
    expect(res.body.conversationId).not.toBe(foreign.id);
  });
});

describe('agent endpoint — request validation', () => {
  it('rejects an empty message without calling the model', async () => {
    const res = await post(AGENT_DOMAINS[0], { message: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_FAILED');
    expect(createCalls).toHaveLength(0);
  });

  it('rejects a message far longer than a chat window produces', async () => {
    // Unbounded input is billed on every subsequent turn of the conversation,
    // not just the one that carried it.
    const res = await post(AGENT_DOMAINS[0], { message: 'a'.repeat(2001) });
    expect(res.status).toBe(400);
    expect(createCalls).toHaveLength(0);
  });

  it('rejects a conversation id that is not a uuid', async () => {
    const res = await post(AGENT_DOMAINS[0], { message: 'hola', conversationId: 'not-a-uuid' });
    expect(res.status).toBe(400);
  });
});

describe('agent endpoint — the SSE stream', () => {
  it('emits progress as the turn runs and a terminal done event', async () => {
    scripted = [
      toolUseResponse('create_cart_link', { items: [{ variant_id: variantId, qty: 1 }] }),
      textResponse('Te dejé el carrito listo.'),
    ];

    const res = await request(app.getHttpServer())
      .post('/v1/storefront/agent/stream')
      .set('Host', AGENT_DOMAINS[0])
      .send({ message: 'lo quiero' });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');

    const events = parseSse(res.text);
    const names = events.map(([name]) => name);
    // The conversation id arrives FIRST, before any model work: the widget can
    // persist it immediately, so a shopper who reloads mid-answer comes back to
    // the same conversation rather than starting over.
    expect(names[0]).toBe('conversation');
    expect(names).toContain('tool');
    expect(names.at(-1)).toBe('done');

    const done = events.find(([name]) => name === 'done')?.[1];
    expect(done?.text).toBe('Te dejé el carrito listo.');
    expect(done?.conversationId).toBe(events[0][1].conversationId);
  });

  it('validates the body BEFORE opening the stream, so a bad request is a real 400', async () => {
    // Once headers are flushed the status code is spent and a validation
    // failure would have to be delivered as an in-band event the caller has to
    // hand-parse.
    const res = await request(app.getHttpServer())
      .post('/v1/storefront/agent/stream')
      .set('Host', AGENT_DOMAINS[0])
      .send({ message: '' });

    expect(res.status).toBe(400);
    expect(res.headers['content-type']).not.toContain('text/event-stream');
  });

  it('reports a mid-turn failure in-band rather than hanging the widget', async () => {
    // No scripted response: the fake throws, standing in for any model-side
    // failure once the response has already begun.
    scripted = [];

    const res = await request(app.getHttpServer())
      .post('/v1/storefront/agent/stream')
      .set('Host', AGENT_DOMAINS[0])
      .send({ message: 'esto va a fallar' });

    expect(res.status).toBe(200);
    const events = parseSse(res.text);
    const error = events.find(([name]) => name === 'error');
    expect(error).toBeDefined();
    // Shopper-facing text only — this renders in a chat window.
    expect(JSON.stringify(error)).not.toContain('scripted');
  });
});

describe('agent endpoint — the per-conversation throttle', () => {
  it('cuts a conversation off after its message budget and spends no more tokens', async () => {
    scripted = Array.from({ length: 30 }, (_, i) => textResponse(`respuesta ${i}`));

    const first = await post(AGENT_DOMAINS[0], { message: 'mensaje 0' });
    const conversationId = first.body.conversationId as string;

    let last = first;
    // 20 permitted per 5-minute window; this is the 21st.
    for (let i = 1; i <= 20; i++) {
      last = await post(AGENT_DOMAINS[0], { message: `mensaje ${i}`, conversationId });
    }

    expect(last.status).toBe(201);
    expect(last.body.throttled).toBe(true);
    expect(last.body.text).toMatch(/vas muy rápido/i);
    // 20 turns reached the model, the 21st did not.
    expect(createCalls).toHaveLength(20);
  });

  it('answers a repeated identical message from cache instead of billing it again', async () => {
    scripted = [textResponse('Sí, tenemos envío a Cali.')];

    const first = await post(AGENT_DOMAINS[0], { message: '¿envían a Cali?' });
    const conversationId = first.body.conversationId as string;
    expect(createCalls).toHaveLength(1);

    // A double-tapped send, or a client stuck retrying.
    const repeat = await post(AGENT_DOMAINS[0], { message: '¿envían a Cali?', conversationId });

    expect(repeat.body.throttled).toBe(true);
    // From the shopper's side the second tap looks like it simply worked.
    expect(repeat.body.text).toBe('Sí, tenemos envío a Cali.');
    // And it cost nothing: no second model call, and no duplicate row in the
    // transcript the merchant reads.
    expect(createCalls).toHaveLength(1);
    const userMessages = await prisma.message.findMany({ where: { conversationId, role: 'user' } });
    expect(userMessages).toHaveLength(1);
  });

  it('does not treat the same text in a DIFFERENT conversation as a repeat', async () => {
    // Two shoppers both opening with "hola" is the normal case, not abuse.
    scripted = [textResponse('hola uno'), textResponse('hola dos')];

    const a = await post(AGENT_DOMAINS[0], { message: 'buenas tardes' });
    const b = await post(AGENT_DOMAINS[0], { message: 'buenas tardes' });

    expect(a.body.conversationId).not.toBe(b.body.conversationId);
    expect(a.body.throttled).toBe(false);
    expect(b.body.throttled).toBe(false);
    expect(createCalls).toHaveLength(2);
  });
});
