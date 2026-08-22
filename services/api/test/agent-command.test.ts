import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient as PrismaClientType, OrderStatus } from '@ventia/db';
import { COMMAND_TOOL_NAMES, generateOrderReference } from '@ventia/core';
import { startTestDb } from './helpers';
import type { signUpWithTenant as SignUpWithTenant } from './admin-helpers';
import type { AgentService as AgentServiceType } from '../src/agent/agent.service';

/**
 * `POST /v1/admin/ai/command` — the merchant's business assistant
 * (docs/design-gap.md §7 item 6), driven against a FAKE Anthropic client.
 *
 * No network call and no API key: the client is a Nest provider precisely so
 * these can assert what the loop DOES rather than what a model says. What is
 * worth pinning here is everything the model cannot be trusted to get right:
 *
 *  1. **Whose data it reads.** The tenant comes from the admin session, and
 *     the neighbouring store's numbers must not appear in a tool result no
 *     matter what the model asks for.
 *  2. **Which tools exist.** Not one shopper tool, not one write tool. A model
 *     offered `create_cart_link` on a margin question will eventually call it.
 *  3. **Who runs out of budget first.** The merchant assistant and the shopper
 *     agent share one counter, so the test that matters is the one where the
 *     merchant is refused and the storefront keeps selling.
 *  4. **That it says "no sé".** An unset cost must arrive as an explicit null,
 *     and a failed tool must arrive flagged as an error — the model can only
 *     decline a question it can see it cannot answer.
 */

let db: Awaited<ReturnType<typeof startTestDb>>;
let redisContainer: StartedTestContainer;
let app: INestApplication;
let prisma: PrismaClientType;
let signUpWithTenant: typeof SignUpWithTenant;
let agent: AgentServiceType;

/** Queue of responses the fake client returns, one per `messages.create`. */
let scripted: unknown[] = [];
/** Every request the loop sent, deep-copied at call time. */
let createCalls: Array<Record<string, unknown>> = [];

let shop: { cookie: string; tenantId: string };
let neighbour: { cookie: string; tenantId: string };
let orderNumber = 1000;

/** The month's allowance every budget assertion below is written against. */
const LIMIT = 500;
/** 20% of {@link LIMIT}, held back for shoppers. */
const RESERVE = 100;

/** A total no other fixture uses, so "did the neighbour's money leak" is a
 * substring search rather than a judgement call. */
const NEIGHBOUR_TOTAL = 777_777_777;

function textResponse(text: string) {
  return { content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 5 }, stop_reason: 'end_turn' };
}

function toolUseResponse(name: string, input: unknown, id = `tu_${Math.random().toString(36).slice(2)}`) {
  return {
    content: [{ type: 'tool_use', id, name, input }],
    usage: { input_tokens: 10, output_tokens: 5 },
    stop_reason: 'tool_use',
  };
}

/** Everything the loop put in front of the model on call `index`, as raw JSON
 * text. Used for the "did anything leak" searches, where a substring miss
 * anywhere in the payload is the assertion. */
function everythingSentOn(index: number): string {
  const messages = createCalls[index].messages as Array<{ role: string; content: unknown }>;
  return JSON.stringify(messages.filter((m) => m.role === 'user'));
}

interface SentToolResult {
  content: string;
  is_error: boolean;
}

/** The `tool_result` blocks the loop fed back before call `index`, in order.
 * These live in a user message whose content is an ARRAY — the plain-text user
 * turn carrying the question is skipped. */
function toolResultsSentOn(index: number): SentToolResult[] {
  const messages = createCalls[index].messages as Array<{ role: string; content: unknown }>;
  const blocks: SentToolResult[] = [];
  for (const message of messages) {
    if (message.role !== 'user' || !Array.isArray(message.content)) continue;
    for (const block of message.content as Array<Record<string, unknown>>) {
      if (block.type === 'tool_result') blocks.push(block as unknown as SentToolResult);
    }
  }
  return blocks;
}

/** The parsed payload of the first tool result on call `index` — what the
 * model actually got to reason from. */
function firstToolPayload<T>(index: number): { ok: boolean; data: T } {
  return JSON.parse(toolResultsSentOn(index)[0].content) as { ok: boolean; data: T };
}

/** The system prompt out of the cacheable block array. */
function systemText(call: Record<string, unknown>): string {
  return (call.system as Array<{ text: string }>).map((block) => block.text).join('\n');
}

async function ask(cookie: string, question: string) {
  return request(app.getHttpServer()).post('/v1/admin/ai/command').set('cookie', cookie).send({ question });
}

async function usageRow(tenantId: string) {
  const now = new Date();
  const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  return prisma.agentUsage.findUnique({ where: { tenantId_month: { tenantId, month } } });
}

/** Pins the month's usage to an exact figure, so a budget boundary is a fixture
 * rather than something a test has to spend 400 questions reaching. */
async function setUsage(tenantId: string, messagesCount: number) {
  const now = new Date();
  const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  await prisma.agentUsage.upsert({
    where: { tenantId_month: { tenantId, month } },
    // Token columns reset alongside the count: they accumulate across the
    // whole month, so a later test asserting an exact token total would
    // otherwise be reading whatever earlier tests in this file happened to add.
    create: { tenantId, month, messagesCount },
    update: { messagesCount, inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 },
  });
}

beforeAll(async () => {
  db = await startTestDb();
  redisContainer = await new GenericContainer('redis:7-alpine')
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
    .start();

  // Env before the first import of @ventia/db / ../src/app.module /
  // ./admin-helpers, same pattern as dashboard.test.ts.
  process.env.DATABASE_URL = db.url;
  process.env.REDIS_URL = `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`;
  // The real client is built by the module factory. It never reaches the
  // network here (it is overridden below), but the SDK constructor is happier
  // with a value present than absent.
  process.env.ANTHROPIC_API_KEY ??= 'sk-ant-test-not-used';

  const { ANTHROPIC_CLIENT, AgentService } = await import('../src/agent/agent.service');
  const { Test } = await import('@nestjs/testing');
  const { AgentCommandModule } = await import('../src/agent-command/agent-command.module');

  // This module's own graph rather than the whole `AppModule`. It pulls in
  // everything this endpoint actually needs — `AgentModule` (for the shared
  // budget service and the shopper loop these tests also drive),
  // `DashboardModule` and `AdminModule` — and nothing else, so the suite boots
  // in a fraction of the time and does not fail because an unrelated module
  // elsewhere in the app is mid-edit. Nothing under test here depends on
  // `main.ts`'s middleware: `AdminSessionGuard` reads `req.headers.cookie`
  // directly rather than through cookie-parser.
  const moduleRef = await Test.createTestingModule({ imports: [AgentCommandModule] })
    // One override, both loops. `AgentCommandModule` re-provides the SAME
    // imported symbol rather than a token of its own, which is what makes this
    // single substitution reach the merchant assistant as well as the shopper
    // agent — and is why the shopper-reserve test below can drive both.
    .overrideProvider(ANTHROPIC_CLIENT)
    .useValue({
      messages: {
        create: vi.fn(async (params: Record<string, unknown>) => {
          // Deep-copied: the loop passes the SAME `messages` array on every
          // call and keeps pushing to it, so storing the reference would make
          // every recorded call show the final state rather than what was sent.
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

  ({ signUpWithTenant } = await import('./admin-helpers'));
  ({ platformDb: prisma } = (await import('@ventia/db')) as unknown as { platformDb: PrismaClientType });

  shop = await signUpWithTenant('tiendacomando@example.com', 'owner');
  neighbour = await signUpWithTenant('tiendavecina@example.com', 'owner');

  await prisma.tenantLimits.create({
    data: { tenantId: shop.tenantId, productsMax: 100, aiMessagesMonth: LIMIT, staffSeats: 2 },
  });
  await prisma.tenantLimits.create({
    data: { tenantId: neighbour.tenantId, productsMax: 100, aiMessagesMonth: LIMIT, staffSeats: 2 },
  });

  await seedFixtures();
}, 240_000);

afterAll(async () => {
  await app.close();
  await redisContainer.stop();
  await db.stop();
});

beforeEach(async () => {
  scripted = [];
  createCalls = [];
  await setUsage(shop.tenantId, 0);
});

/**
 * A store with a history a merchant would actually ask about, and a
 * neighbouring store whose money must never turn up in it.
 *
 * Dates are fixed and in the past relative to nothing — the tools resolve
 * their own window from the clock, so every assertion below that depends on a
 * date passes an explicit `from`/`to` in the tool input instead of relying on
 * "today".
 */
async function seedFixtures() {
  const camisa = await seedProduct(shop.tenantId, {
    name: 'Camisa que se mueve',
    stock: 20,
    costCents: 30_000,
  });
  // Deliberately no cost: the honest-unknown the assistant must refuse to
  // build a margin out of. Stock on the shelf and nothing sold, so it is also
  // the correct answer to "¿qué se está quedando quieto?".
  await seedProduct(shop.tenantId, { name: 'Ruana quieta', stock: 15, costCents: null });
  await seedProduct(shop.tenantId, { name: 'Agotada', stock: 0, costCents: 10_000 });
  // Made to order: its `stock` column sits wherever it was last left, so
  // reporting it as "quedan 0" would send the merchant to restock something
  // that is never stocked.
  await seedProduct(shop.tenantId, {
    name: 'Sobre pedido',
    stock: 0,
    costCents: 10_000,
    trackInventory: false,
  });
  await seedProduct(shop.tenantId, { name: 'Casi agotada', stock: 2, costCents: 10_000 });
  await seedProduct(shop.tenantId, { name: 'Borrador escondido', stock: 50, costCents: 10_000, status: 'draft' });

  await seedOrder(shop.tenantId, {
    at: '2026-08-12T15:00:00.000Z',
    totalCents: 120_000,
    items: [{ productId: camisa, name: 'Camisa que se mueve', priceCents: 60_000, qty: 2 }],
  });
  await seedOrder(shop.tenantId, { at: '2026-08-13T15:00:00.000Z', totalCents: 80_000, status: 'PENDING' });
  // Cancelled: counted in the by-status breakdown, excluded from every peso
  // figure AND from every unit count, exactly as the tablero excludes it. It
  // carries LINES on purpose — a cancelled order with no items would let the
  // product tallies ignore the cancellation rule and still look right.
  await seedOrder(shop.tenantId, {
    at: '2026-08-13T16:00:00.000Z',
    totalCents: 999_000,
    status: 'CANCELLED',
    items: [{ productId: camisa, name: 'Camisa que se mueve', priceCents: 60_000, qty: 5 }],
  });
  // Exactly midnight in Bogota on the day AFTER the window closes
  // (2026-08-17T00:00 = 05:00 UTC). The upper bound is half-open, so this must
  // fall outside — an inclusive bound would silently pull the next day's first
  // orders into every window this product reports on.
  await seedOrder(shop.tenantId, { at: '2026-08-17T05:00:00.000Z', totalCents: 555_000 });

  await seedOrder(neighbour.tenantId, { at: '2026-08-12T15:00:00.000Z', totalCents: NEIGHBOUR_TOTAL });
}

async function seedProduct(
  tenantId: string,
  opts: {
    name: string;
    stock: number;
    costCents: number | null;
    status?: 'active' | 'draft';
    trackInventory?: boolean;
  },
): Promise<string> {
  const product = await prisma.product.create({
    data: {
      tenantId,
      name: opts.name,
      slug: `${opts.name.toLowerCase().replace(/[^a-z]+/g, '-')}-${orderNumber++}`,
      priceCents: 60_000,
      costCents: opts.costCents,
      stock: opts.stock,
      trackInventory: opts.trackInventory ?? true,
      status: opts.status ?? 'active',
    },
  });
  return product.id;
}

async function seedOrder(
  tenantId: string,
  opts: {
    at: string;
    totalCents: number;
    status?: OrderStatus;
    items?: Array<{ productId: string; name: string; priceCents: number; qty: number }>;
  },
) {
  const order = await prisma.order.create({
    data: {
      tenantId,
      number: orderNumber++,
      reference: generateOrderReference(),
      status: opts.status ?? 'CONFIRMED',
      paymentStatus: 'PENDING',
      // The PII the orders tool must never hand to the model.
      email: 'clienta-secreta@example.com',
      phone: '3001234567',
      shippingAddress: { line1: 'Calle Privada 1' },
      subtotalCents: opts.totalCents,
      taxCents: 0,
      totalCents: opts.totalCents,
      createdAt: new Date(opts.at),
    },
  });
  for (const item of opts.items ?? []) {
    await prisma.orderItem.create({
      data: {
        tenantId,
        orderId: order.id,
        productId: item.productId,
        nameSnapshot: item.name,
        priceCentsSnapshot: item.priceCents,
        qty: item.qty,
        taxRateSnapshot: 'NINETEEN',
      },
    });
  }
}

describe('POST /v1/admin/ai/command — answering the merchant', () => {
  it('answers from a tool and reports what it cost against the plan', async () => {
    scripted = [
      toolUseResponse('get_business_summary', { from: '2026-08-10', to: '2026-08-16' }),
      textResponse('Esta semana vendiste $200.000 en 2 pedidos.'),
    ];

    const res = await ask(shop.cookie, '¿cómo vamos esta semana?');

    expect(res.status).toBe(200);
    expect(res.body.answer).toContain('$200.000');
    // The grounding is reported, so a merchant handed a surprising number can
    // tell "it looked it up" from "it guessed".
    expect(res.body.usedTools).toEqual([{ name: 'get_business_summary', ok: true }]);
    expect(res.body.budget).toMatchObject({
      used: 1,
      limit: LIMIT,
      shopperReserve: RESERVE,
      remainingForCommands: LIMIT - RESERVE - 1,
      remainingTotal: LIMIT - 1,
    });
  });

  it('counts one MESSAGE per question however many round-trips it takes', async () => {
    // The plan sells "mensajes de IA", and a merchant cannot predict how many
    // times the model will loop. Billing per round-trip would make the same
    // question cost a different amount each time it is asked.
    scripted = [
      toolUseResponse('get_business_summary', {}),
      toolUseResponse('get_orders_snapshot', {}),
      textResponse('Van 2 pedidos hoy.'),
    ];

    await ask(shop.cookie, '¿cuántos pedidos van hoy y cómo vamos?');

    expect(createCalls).toHaveLength(3);
    expect((await usageRow(shop.tenantId))?.messagesCount).toBe(1);
  });

  it('stops at the turn cap instead of looping on the merchant’s allowance', async () => {
    // A model that keeps calling tools without concluding would otherwise bill
    // one question unboundedly against the plan the storefront also depends on.
    scripted = Array.from({ length: 6 }, () => toolUseResponse('get_business_summary', {}));

    const res = await ask(shop.cookie, '¿y ahora?');

    expect(res.status).toBe(200);
    expect(createCalls).toHaveLength(4);
  });

  it('records cache tokens separately from ordinary input tokens', async () => {
    // Folding them together would price a cache hit as a full-price read and
    // hide the saving the cacheable system block exists to produce.
    scripted = [
      {
        content: [{ type: 'text', text: 'Listo.' }],
        usage: {
          input_tokens: 11,
          output_tokens: 7,
          cache_creation_input_tokens: 900,
          cache_read_input_tokens: 1300,
        },
        stop_reason: 'end_turn',
      },
    ];

    await ask(shop.cookie, '¿todo bien?');

    expect(await usageRow(shop.tenantId)).toMatchObject({
      inputTokens: 11,
      outputTokens: 7,
      cacheWriteTokens: 900,
      cacheReadTokens: 1300,
    });
  });
});

describe('what the model is allowed to ask for', () => {
  it('offers exactly the three read-only merchant tools and none of the shopper’s', async () => {
    scripted = [textResponse('Hola.')];
    await ask(shop.cookie, 'hola');

    const offered = (createCalls[0].tools as Array<{ name: string }>).map((tool) => tool.name);
    expect(offered.sort()).toEqual([...COMMAND_TOOL_NAMES].sort());
    // Named explicitly, because this is the failure the separation exists to
    // prevent: a cart built out of a misread margin question is a fake order
    // in the merchant's own books.
    expect(offered).not.toContain('create_cart_link');
    expect(offered).not.toContain('escalate_to_human');
  });

  it('marks the system block cacheable', async () => {
    scripted = [textResponse('Hola.')];
    await ask(shop.cookie, 'hola');

    expect((createCalls[0].system as Array<{ cache_control?: unknown }>)[0].cache_control).toEqual({
      type: 'ephemeral',
    });
  });

  it('keeps today’s date OUT of the cacheable prefix', async () => {
    // A date in the system block changes its bytes every midnight and evicts
    // the cached prefix for every store, once a day, forever. It belongs after
    // the last breakpoint — but it must still be there, because only the
    // server may say what "hoy" means in Bogota.
    scripted = [textResponse('Hola.')];
    await ask(shop.cookie, '¿cuántos pedidos van hoy?');

    expect(systemText(createCalls[0])).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(JSON.stringify(createCalls[0].messages)).toMatch(/Hoy es \d{4}-\d{2}-\d{2} en Colombia/);
  });

  it('tells the model it may not invent a figure', async () => {
    scripted = [textResponse('Hola.')];
    await ask(shop.cookie, 'hola');

    const system = systemText(createCalls[0]);
    expect(system).toContain('Cuando no sepas, dilo');
    expect(system).toContain('No puedes cambiar nada');
    // The store's own name, so the assistant can say "tu tienda" and mean it.
    expect(system).toContain('tiendacomando@example.com');
  });
});

describe('tenant scoping — the neighbour’s money never appears', () => {
  it('answers only about the store on the session', async () => {
    scripted = [
      toolUseResponse('get_business_summary', { from: '2026-08-10', to: '2026-08-16' }),
      textResponse('Listo.'),
    ];

    await ask(shop.cookie, '¿cuánto vendí?');

    // What the model was actually handed, on the second call.
    const sent = everythingSentOn(1);
    expect(sent).toContain('200000'); // this store's own non-cancelled sales
    expect(sent).not.toContain(String(NEIGHBOUR_TOTAL));
  });

  it('gives the neighbour their own numbers on the same endpoint', async () => {
    // The mirror of the test above: scoping that returned nothing to everyone
    // would also pass that one.
    scripted = [
      toolUseResponse('get_business_summary', { from: '2026-08-10', to: '2026-08-16' }),
      textResponse('Listo.'),
    ];

    await ask(neighbour.cookie, '¿cuánto vendí?');

    expect(everythingSentOn(1)).toContain(String(NEIGHBOUR_TOTAL));
  });

  it('ignores a tenantId smuggled into the body', async () => {
    // The schema strips it and the controller never reads it — the tenant comes
    // from the session. This is the test that fails if anyone ever "helpfully"
    // lets a caller name the store they are asking about.
    scripted = [
      toolUseResponse('get_business_summary', { from: '2026-08-10', to: '2026-08-16' }),
      textResponse('Listo.'),
    ];

    const res = await request(app.getHttpServer())
      .post('/v1/admin/ai/command')
      .set('cookie', shop.cookie)
      .send({ question: '¿cuánto vendí?', tenantId: neighbour.tenantId });

    expect(res.status).toBe(200);
    expect(everythingSentOn(1)).not.toContain(String(NEIGHBOUR_TOTAL));
  });

  it('refuses an anonymous caller before any model call', async () => {
    const res = await request(app.getHttpServer()).post('/v1/admin/ai/command').send({ question: '¿cuánto vendí?' });

    expect(res.status).toBe(401);
    expect(createCalls).toHaveLength(0);
  });

  it('rejects an empty question without spending a message', async () => {
    const res = await ask(shop.cookie, '   ');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_FAILED');
    expect(createCalls).toHaveLength(0);
    expect((await usageRow(shop.tenantId))?.messagesCount ?? 0).toBe(0);
  });
});

describe('the shared budget, and who goes quiet first', () => {
  it('refuses the merchant while the SHOPPER agent keeps selling', async () => {
    // The whole point of the reserve. At `limit - reserve` the owner's
    // questions stop; the storefront still has 100 messages, because the
    // storefront is what earns them the money.
    await setUsage(shop.tenantId, LIMIT - RESERVE);

    const res = await ask(shop.cookie, '¿cómo vamos?');

    expect(res.status).toBe(402);
    expect(res.body).toMatchObject({
      error: 'PLAN_LIMIT_EXCEEDED',
      details: { feature: 'aiMessagesMonth', limit: LIMIT, reason: 'shopper_reserve' },
    });
    expect(createCalls).toHaveLength(0);

    // And now the part that makes the refusal worth having: the same tenant,
    // the same counter, and the shopper agent answers normally.
    scripted = [textResponse('¡Claro! Tenemos esa camisa en talla M.')];
    const reply = await agent.respond({ tenantId: shop.tenantId, message: '¿tienen camisa talla M?' });

    expect(reply.budgetExhausted).toBe(false);
    expect(reply.text).toContain('talla M');
  });

  it('says the allowance is exhausted, not reserved, once nothing is left', async () => {
    await setUsage(shop.tenantId, LIMIT);

    const res = await ask(shop.cookie, '¿cómo vamos?');

    expect(res.status).toBe(402);
    expect(res.body.details.reason).toBe('exhausted');
  });

  it('answers the last question before the reserve', async () => {
    await setUsage(shop.tenantId, LIMIT - RESERVE - 1);
    scripted = [textResponse('Vas bien.')];

    const res = await ask(shop.cookie, '¿cómo vamos?');

    expect(res.status).toBe(200);
    expect(res.body.budget.remainingForCommands).toBe(0);
  });

  it('charges nothing for a refused question', async () => {
    // `record()` runs only after an answer exists. Over-counting bills a
    // merchant for something they did not get, and there is no refund path.
    await setUsage(shop.tenantId, LIMIT);

    await ask(shop.cookie, '¿cómo vamos?');

    expect((await usageRow(shop.tenantId))?.messagesCount).toBe(LIMIT);
  });
});

describe('grounding — the tools tell the truth, including when they do not know', () => {
  it('reports an unset cost as an explicit null rather than omitting it', async () => {
    // The single most important honest-unknown here. A model handed a missing
    // cost will happily produce a margin from the price alone, and a merchant
    // pricing against an invented margin loses real money.
    scripted = [
      toolUseResponse('get_product_performance', { from: '2026-08-10', to: '2026-08-16', sort: 'slowest' }),
      textResponse('No tengo el costo de la ruana.'),
    ];

    await ask(shop.cookie, '¿cuál es mi margen en la ruana?');

    const payload = firstToolPayload<{ products: Array<{ name: string; cost_cents: number | null }> }>(1);
    const ruana = payload.data.products.find((p) => p.name === 'Ruana quieta');
    expect(ruana).toBeDefined();
    expect(ruana!.cost_cents).toBeNull();
  });

  it('ranks the product with stock and no sales as the slowest, and hides the sold-out and the draft', async () => {
    scripted = [
      toolUseResponse('get_product_performance', { from: '2026-08-10', to: '2026-08-16', sort: 'slowest' }),
      textResponse('La ruana está quieta.'),
    ];

    await ask(shop.cookie, '¿qué producto se está quedando quieto?');

    const payload = firstToolPayload<{
      catalog_truncated: boolean;
      products: Array<{ name: string; units_sold: number }>;
    }>(1);
    const names = payload.data.products.map((p) => p.name);

    // Zero sales AND stock on the shelf — capital sitting still, which is the
    // question.
    expect(names[0]).toBe('Ruana quieta');
    // Sold out is the OPPOSITE of the answer, and a draft product selling
    // nothing is not news.
    expect(names).not.toContain('Agotada');
    expect(names).not.toContain('Borrador escondido');
    // Stated even when false, so the model never infers completeness from an
    // absent field.
    expect(payload.data.catalog_truncated).toBe(false);
  });

  it('does not count units from a cancelled order', async () => {
    // Five of these shirts were "sold" on an order that was then cancelled.
    // Counting them would tell the merchant a product is moving when it is not
    // — and would disagree with their own tablero's top-products panel.
    scripted = [
      toolUseResponse('get_product_performance', { from: '2026-08-10', to: '2026-08-16', sort: 'bestselling' }),
      textResponse('La camisa va de primera.'),
    ];

    await ask(shop.cookie, '¿qué se vendió más?');

    const payload = firstToolPayload<{ products: Array<{ name: string; units_sold: number }> }>(1);
    const camisa = payload.data.products.find((p) => p.name === 'Camisa que se mueve');
    expect(camisa?.units_sold).toBe(2);
  });

  it('closes the window on Colombian midnight, exclusive', async () => {
    // The seeded order at 2026-08-17T05:00Z is 00:00 on the 17th in Bogota —
    // the first instant AFTER a window ending on the 16th. An inclusive upper
    // bound would count it here and in every other window this product reports.
    scripted = [
      toolUseResponse('get_orders_snapshot', { from: '2026-08-10', to: '2026-08-16' }),
      textResponse('Van 2 pedidos.'),
    ];

    await ask(shop.cookie, '¿cuántos pedidos van?');

    const payload = firstToolPayload<{ total_sales_cents_excluding_cancelled: number }>(1);
    expect(payload.data.total_sales_cents_excluding_cancelled).toBe(200_000);
  });

  it('ranks by stock but leaves made-to-order products out of it', async () => {
    scripted = [
      toolUseResponse('get_product_performance', { from: '2026-08-10', to: '2026-08-16', sort: 'lowest_stock' }),
      textResponse('Se te está acabando la Agotada.'),
    ];

    await ask(shop.cookie, '¿qué se me está agotando?');

    const payload = firstToolPayload<{ products: Array<{ name: string; stock: number }> }>(1);
    const names = payload.data.products.map((p) => p.name);

    // Fewest units first.
    expect(names.slice(0, 2)).toEqual(['Agotada', 'Casi agotada']);
    // A product that does not track inventory has no stock number worth
    // ranking — listing it as "0 unidades" would send the merchant to restock
    // something that is made to order.
    expect(names).not.toContain('Sobre pedido');
  });

  it('admits when the catalogue is bigger than it looked at', async () => {
    // The other half of "say when you do not know". A ranking over part of the
    // catalogue reported as a complete one is exactly the invented certainty
    // this feature must not have — so the flag is asserted against a store that
    // genuinely exceeds the scan cap.
    const big = await signUpWithTenant('tiendagrande@example.com', 'owner');
    await prisma.tenantLimits.create({
      data: { tenantId: big.tenantId, productsMax: 5000, aiMessagesMonth: LIMIT, staffSeats: 2 },
    });
    await prisma.product.createMany({
      data: Array.from({ length: 1001 }, (_, i) => ({
        tenantId: big.tenantId,
        name: `Producto ${String(i).padStart(4, '0')}`,
        slug: `producto-grande-${i}`,
        priceCents: 10_000,
        stock: 5,
        status: 'active' as const,
      })),
    });

    scripted = [
      toolUseResponse('get_product_performance', { from: '2026-08-10', to: '2026-08-16', sort: 'slowest' }),
      textResponse('Revisé parte del catálogo.'),
    ];

    await ask(big.cookie, '¿qué se está quedando quieto?');

    const payload = firstToolPayload<{ catalog_truncated: boolean; catalog_scanned: number }>(1);
    expect(payload.data.catalog_truncated).toBe(true);
    expect(payload.data.catalog_scanned).toBe(1000);
  });

  it('keeps cancelled orders out of the peso figure but inside the breakdown', async () => {
    // Agreeing with the tablero is the requirement: a merchant told one number
    // here and shown another on their own dashboard has no way to tell which
    // is wrong.
    scripted = [
      toolUseResponse('get_orders_snapshot', { from: '2026-08-10', to: '2026-08-16' }),
      textResponse('Van 2 pedidos.'),
    ];

    await ask(shop.cookie, '¿cuántos pedidos van?');

    const payload = firstToolPayload<{
      total_orders_excluding_cancelled: number;
      total_sales_cents_excluding_cancelled: number;
      by_status: Record<string, number>;
    }>(1);

    expect(payload.data.total_orders_excluding_cancelled).toBe(2);
    expect(payload.data.total_sales_cents_excluding_cancelled).toBe(200_000);
    expect(payload.data.by_status.CANCELLED).toBe(1);
    // Every status named, so a quiet window is unambiguously zero rather than
    // unknown.
    expect(payload.data.by_status.SHIPPED).toBe(0);
  });

  it('sends no customer PII to the model', async () => {
    scripted = [
      toolUseResponse('get_orders_snapshot', { from: '2026-08-10', to: '2026-08-16' }),
      textResponse('Van 2 pedidos.'),
    ];

    await ask(shop.cookie, '¿qué pedidos tengo?');

    const sent = everythingSentOn(1);
    expect(sent).not.toContain('clienta-secreta@example.com');
    expect(sent).not.toContain('3001234567');
    expect(sent).not.toContain('Calle Privada');
  });

  it('hands a bad window back to the model as an error rather than failing the question', async () => {
    // A model that picked an impossible range should be told and try again.
    // A 400 escaping the executor would fail the merchant's whole question
    // because the model guessed a date badly.
    scripted = [
      toolUseResponse('get_business_summary', { from: '2026-08-16', to: '2026-08-10' }),
      textResponse('Perdón, déjame revisar otra vez.'),
    ];

    const res = await ask(shop.cookie, '¿cómo vamos?');

    expect(res.status).toBe(200);
    expect(res.body.usedTools).toEqual([{ name: 'get_business_summary', ok: false }]);

    // Flagged rather than dropped: a dropped result leaves the model waiting
    // on something that never comes, and an answer built on a silently missing
    // lookup is the invented number this feature must not produce.
    expect(toolResultsSentOn(1)[0].is_error).toBe(true);
  });

  it('reports an unknown tool name as an error result rather than killing the turn', async () => {
    scripted = [toolUseResponse('bajar_precios', { pct: 10 }), textResponse('No puedo hacer eso.')];

    const res = await ask(shop.cookie, 'bájale 10% a todo');

    expect(res.status).toBe(200);
    expect(res.body.usedTools).toEqual([{ name: 'bajar_precios', ok: false }]);
    expect(res.body.answer).toContain('No puedo');
  });
});
