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

/** The prompt text out of the cacheable block array the loop sends. */
function systemText(call: { system?: unknown }): string {
  const system = call.system as Array<{ text: string }>;
  return system.map((block) => block.text).join('\n');
}

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
    data: { tenantId, productsMax: 100, aiCreditsMonth: 10, staffSeats: 2 },
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

    // El texto del modelo cierra la respuesta; delante va la revelación de
    // experiencia automatizada (su propio describe, más abajo).
    expect(reply.text.endsWith('¡Hola! ¿En qué te ayudo?')).toBe(true);
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

  it('marks the system prompt cacheable, which is what makes the prompt cheap', async () => {
    // The cacheable prefix is tools -> system -> messages, so a breakpoint on
    // the system block covers the tool schemas too. Both are byte-identical on
    // every turn of every conversation; without this they were re-sent and
    // re-billed at full input price on each of the up-to-four round-trips one
    // shopper question can make.
    scripted = [textResponse('listo')];

    await agent.respond({ tenantId, message: 'hola' });

    const system = createCalls[0].system as Array<{ type: string; cache_control?: { type: string } }>;
    expect(Array.isArray(system)).toBe(true);
    expect(system[0].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('meters cache tokens separately from ordinary input', async () => {
    // Three counters and not one: the three are billed at three different
    // rates, so folding cache reads into `inputTokens` would price every hit
    // as a full-price read and erase the saving in the very report meant to
    // show it.
    await prisma.agentUsage.deleteMany({ where: { tenantId } });
    scripted = [
      {
        content: [{ type: 'text', text: 'listo' }],
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_creation_input_tokens: 1200,
          cache_read_input_tokens: 3400,
        },
        stop_reason: 'end_turn',
      },
    ];

    await agent.respond({ tenantId, message: 'hola' });

    const usage = await prisma.agentUsage.findFirst({ where: { tenantId } });
    expect(usage?.inputTokens).toBe(10);
    expect(usage?.cacheWriteTokens).toBe(1200);
    expect(usage?.cacheReadTokens).toBe(3400);
  });

  it('survives a provider response that reports no cache fields at all', async () => {
    // Below the minimum cacheable length the marker is ignored and the usage
    // block carries no cache keys. That must record as zero, not NaN — a NaN
    // increment would poison the tenant's whole month.
    await prisma.agentUsage.deleteMany({ where: { tenantId } });
    scripted = [textResponse('listo')];

    await agent.respond({ tenantId, message: 'hola' });

    const usage = await prisma.agentUsage.findFirst({ where: { tenantId } });
    expect(usage?.cacheWriteTokens).toBe(0);
    expect(usage?.cacheReadTokens).toBe(0);
  });

  it('prices the turn at write time when model prices are configured', async () => {
    const { INPUT_PRICE_ENV, OUTPUT_PRICE_ENV } = await import('../src/agent/agent-pricing');
    process.env[INPUT_PRICE_ENV] = '3';
    process.env[OUTPUT_PRICE_ENV] = '15';
    await prisma.agentUsage.deleteMany({ where: { tenantId } });

    try {
      scripted = [textResponse('listo')];
      await agent.respond({ tenantId, message: 'hola' });

      // 10 input @ $3/Mtok = 30 micro-USD; 5 output @ $15/Mtok = 75. Total 105.
      // Priced HERE rather than derived on read: these rows are monthly
      // aggregates, so pricing them later would charge January's tokens at
      // whatever a dashboard's load time says the price is.
      const usage = await prisma.agentUsage.findFirst({ where: { tenantId } });
      expect(Number(usage?.costMicroUsd)).toBe(105);
    } finally {
      delete process.env[INPUT_PRICE_ENV];
      delete process.env[OUTPUT_PRICE_ENV];
    }
  });

  it('leaves cost at zero — and says nothing about it — when prices are unset', async () => {
    // The counters still work. What must NOT happen is a fabricated cost: the
    // predecessor column reported every tenant as free precisely because
    // nothing wrote it and everything read it as 0.
    await prisma.agentUsage.deleteMany({ where: { tenantId } });
    scripted = [textResponse('listo')];

    await agent.respond({ tenantId, message: 'hola' });

    const usage = await prisma.agentUsage.findFirst({ where: { tenantId } });
    expect(usage?.messagesCount).toBe(1);
    expect(Number(usage?.costMicroUsd)).toBe(0);
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

  it("gives the cart the CONVERSATION's channel, not a hardcoded one", async () => {
    // The channel is a server fact (which door the shopper came through), so
    // it comes from the conversation row the same way the tenant does. A cart
    // the agent builds mid-WhatsApp-chat has to be attributable to WhatsApp
    // even though the shopper will finish paying in a browser.
    const whatsappConversation = await prisma.conversation.create({
      data: { tenantId, channel: 'whatsapp', shopperRef: '573001112233', status: 'open' },
    });

    scripted = [
      toolUseResponse('create_cart_link', { items: [{ variant_id: variantId, qty: 1 }] }),
      textResponse('Te dejé el carrito listo.'),
    ];

    const reply = await agent.respond({
      tenantId,
      conversationId: whatsappConversation.id,
      message: 'lo quiero',
    });

    const url = (reply.toolResults[0].result as { data: { cart_url: string } }).data.cart_url;
    const key = new URL(`http://x${url}`).searchParams.get('c');
    const cart = await prisma.cart.findFirst({ where: { tenantId, cookieKey: key! } });
    expect(cart?.channel).toBe('whatsapp');
  });
});

describe('agent loop — the allowance, the overage, and where it really stops', () => {
  /** The fixture tenant's allowance is 10 credits, so its ceiling is 30. */
  function usageRow(creditsUsed: number) {
    return {
      tenantId,
      month: `${new Date().getUTCFullYear()}-${String(new Date().getUTCMonth() + 1).padStart(2, '0')}`,
      messagesCount: creditsUsed,
      creditsUsed,
    };
  }

  it('keeps answering past the plan allowance, because going quiet mid-sale is the worse failure', async () => {
    // This used to be a hard cap, and the reversal is the point of the test.
    // A store reaches its allowance on the day it is selling most; a shopper
    // who gets "no puedo responderte" at that moment is a lost sale, and the
    // merchant reads it as the shop being broken rather than as a quota.
    // Credits past the allowance are billed as overage instead.
    await prisma.agentUsage.create({ data: usageRow(10) });
    scripted = [textResponse('claro, sí tenemos envío a Cali')];

    const reply = await agent.respond({ tenantId, message: 'hola' });

    expect(reply.budgetExhausted).toBe(false);
    expect(createCalls).toHaveLength(1);
    expect(reply.text).toMatch(/envío a Cali/i);
  });

  it('stops at the overage ceiling, which is what bounds an abuser', async () => {
    // Three times the allowance. Far past any honest month, and the reason the
    // line above is safe: overage is uncapped for a busy store's day, not for
    // a script running all month.
    await prisma.agentUsage.create({ data: usageRow(30) });
    scripted = [textResponse('esto no debería enviarse')];

    const reply = await agent.respond({ tenantId, message: 'hola' });

    expect(reply.budgetExhausted).toBe(true);
    // The assertion that matters is not the text — it is that zero API calls
    // happened. A ceiling that still pays for the model call is not a ceiling.
    expect(createCalls).toHaveLength(0);
    expect(reply.text).toMatch(/no puedo responderte por chat/i);
  });

  it('still records the shopper\'s message when refused, so the merchant sees the demand', async () => {
    await prisma.agentUsage.create({ data: usageRow(30) });

    const reply = await agent.respond({ tenantId, message: '¿tienen envío a Cali?' });

    const messages = await prisma.message.findMany({ where: { conversationId: reply.conversationId } });
    expect(messages.map((m) => m.content)).toContain('¿tienen envío a Cali?');
  });

  it('treats a tenant with no plan row as zero budget, not unlimited', async () => {
    // An unprovisioned store getting free unmetered AI is the failure that
    // costs money and hides itself. Overage does not rescue it: a limit of 0
    // gives a ceiling of 0, so the very first turn is refused.
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
        limits: { create: { productsMax: 10, aiCreditsMonth: 10, staffSeats: 1, humanHandoff: true } },
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
        limits: { create: { productsMax: 10, aiCreditsMonth: 10, staffSeats: 1, humanHandoff: true } },
      },
    });
    scripted = [textResponse('a'), textResponse('b')];

    await agent.respond({ tenantId, message: 'hola' });
    await agent.respond({ tenantId: withHandoff.id, message: 'hola' });

    // `system` is a block array now, not a bare string — it carries the cache
    // breakpoint. The prompt text is the first block's `text`.
    expect(systemText(createCalls[0])).not.toContain('escalate_to_human');
    expect(systemText(createCalls[1])).toContain('escalate_to_human');
  });
});

describe('agent loop — la revelación de experiencia automatizada', () => {
  /**
   * Lo que un revisor de Meta comprueba abriendo una conversación: que el
   * primer mensaje que recibe dice que quien contesta es un sistema
   * automático.
   *
   * Estas pruebas no miran el prompt. Miran lo que SALE del bucle, que es lo
   * único que el comprador ve y lo único que un revisor puede observar — y por
   * eso la revelación la antepone el código y no el modelo: aquí el modelo
   * está guionizado para no decir absolutamente nada sobre sí mismo, y aun así
   * tiene que aparecer.
   */

  /** El texto fijo que le toca a este inquilino de fixture. */
  async function revelacionEsperada() {
    const { buildAutomationDisclosure } = await import('../src/agent/system-prompt');
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    return buildAutomationDisclosure({
      storeName: tenant.name,
      agentConfig: tenant.agentConfig,
      handoffEnabled: false,
    });
  }

  it('abre toda conversación nueva revelando que es automática', async () => {
    scripted = [textResponse('Claro, tenemos camisas.')];

    const reply = await agent.respond({ tenantId, message: 'hola' });

    expect(reply.text.startsWith(await revelacionEsperada())).toBe(true);
    expect(reply.text).toContain('Claro, tenemos camisas.');
  });

  it('la deja escrita en el transcripto, que es la prueba de qué vio el comprador', async () => {
    scripted = [textResponse('Claro que sí.')];

    const reply = await agent.respond({ tenantId, message: 'hola' });

    const assistant = await prisma.message.findFirst({
      where: { conversationId: reply.conversationId, role: 'assistant' },
    });
    expect(assistant?.content).toContain('el asistente virtual de Tienda Loop');
  });

  it('NO la repite en los mensajes siguientes de la misma conversación', async () => {
    // El otro lado del requisito: un aviso en cada mensaje arruina la venta y
    // no añade cumplimiento.
    scripted = [textResponse('primera'), textResponse('segunda'), textResponse('tercera')];

    const uno = await agent.respond({ tenantId, message: 'hola' });
    const dos = await agent.respond({ tenantId, conversationId: uno.conversationId, message: '¿y en talla M?' });
    const tres = await agent.respond({ tenantId, conversationId: uno.conversationId, message: '¿y el envío?' });

    expect(uno.text).toContain('asistente virtual');
    expect(dos.text).toBe('segunda');
    expect(tres.text).toBe('tercera');
  });

  it('la repite cuando el hilo se retoma tras un día entero de silencio', async () => {
    // Meta la exige «tras un lapso significativo de tiempo», y 24 h es la
    // ventana de mensajería que la propia plataforma considera sesión cerrada.
    scripted = [textResponse('primera'), textResponse('al día siguiente')];

    const uno = await agent.respond({ tenantId, message: 'hola' });
    // Se envejece la respuesta del agente, que es el reloj que mira el bucle.
    await prisma.message.updateMany({
      where: { conversationId: uno.conversationId, role: 'assistant' },
      data: { createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) },
    });

    const dos = await agent.respond({ tenantId, conversationId: uno.conversationId, message: 'sigo aquí' });

    expect(dos.text.startsWith(await revelacionEsperada())).toBe(true);
    expect(dos.text).toContain('al día siguiente');
  });

  it('revela aunque el modelo no diga una sola palabra en todo el turno', async () => {
    // Un turno que agota el tope pidiendo herramientas y nunca concluye. Sin
    // esto la conversación quedaría marcada como revelada sin haber enviado
    // nada, y el comprador no vería el aviso nunca.
    scripted = Array.from({ length: 4 }, () => toolUseResponse('search_products', { query: 'x', limit: 1 }));

    const reply = await agent.respond({ tenantId, message: 'busca sin parar' });

    expect(reply.text).toBe(await revelacionEsperada());
  });

  it('revela también en la respuesta fija de presupuesto agotado', async () => {
    // Ese camino no llama al modelo, así que ninguna instrucción del prompt
    // podría haberla puesto: para el comprador sigue siendo un mensaje
    // automático, y puede ser el primero que reciba.
    const month = `${new Date().getUTCFullYear()}-${String(new Date().getUTCMonth() + 1).padStart(2, '0')}`;
    await prisma.agentUsage.create({ data: { tenantId, month, messagesCount: 30, creditsUsed: 30 } });

    const reply = await agent.respond({ tenantId, message: 'hola' });

    expect(reply.budgetExhausted).toBe(true);
    expect(createCalls).toHaveLength(0);
    expect(reply.text).toContain('el asistente virtual de Tienda Loop');
    expect(reply.text).toContain('no puedo responderte por chat');
    // Y sin ofrecer nada que no vaya a poder cumplir: pasado el techo no hay
    // turno siguiente. La vía humana de ese mensaje es el propio texto fijo.
    expect(reply.text).not.toContain('una persona del equipo');
    expect(reply.text).toContain('Escríbele directamente a la tienda');
  });

  it('promete traspaso a una persona solo si el plan lo incluye', async () => {
    // La vía de escalado tiene que ser verdad: la tienda de fixture no tiene
    // `humanHandoff`, así que le ofrece el contacto de la tienda y no un
    // traspaso que nadie va a atender.
    const conHandoff = await prisma.tenant.create({
      data: {
        slug: `agent-revelacion-${Date.now()}`,
        name: 'Con Handoff Rev',
        status: 'live',
        limits: { create: { productsMax: 10, aiCreditsMonth: 10, staffSeats: 1, humanHandoff: true } },
      },
    });
    scripted = [textResponse('a'), textResponse('b')];

    const sin = await agent.respond({ tenantId, message: 'hola' });
    const con = await agent.respond({ tenantId: conHandoff.id, message: 'hola' });

    expect(sin.text).toContain('datos de contacto de la tienda');
    expect(con.text).not.toContain('datos de contacto de la tienda');
    expect(con.text).toContain('una persona del equipo');
  });

  it('revela aunque el comerciante le ponga nombre de persona al agente', async () => {
    const disfrazada = await prisma.tenant.create({
      data: {
        slug: `agent-maria-${Date.now()}`,
        name: 'Tienda María',
        status: 'live',
        agentConfig: { agentName: 'María', tone: 'juvenil' },
        limits: { create: { productsMax: 10, aiCreditsMonth: 10, staffSeats: 1 } },
      },
    });
    scripted = [textResponse('¡claro!')];

    const reply = await agent.respond({ tenantId: disfrazada.id, message: 'hola' });

    expect(reply.text).toContain('Soy María, el asistente virtual de Tienda María');
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
