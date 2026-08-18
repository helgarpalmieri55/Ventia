import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateOrderReference } from '@ventia/core';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient as PrismaClientType } from '@ventia/db';
import { startTestDb } from './helpers';
import type { AgentToolsService as AgentToolsServiceType } from '../src/agent/agent-tools.service';
import type { AgentService as AgentServiceType } from '../src/agent/agent.service';

/**
 * The Phase 4 eval suite (docs/SPEC.md §7, "Evals — part of Phase 4 DoD").
 *
 * ## What is being evaluated, and by whom
 *
 * SPEC lists six scenarios. They divide cleanly into two kinds, and the
 * division is the point of this file:
 *
 *  - Scenarios that the SYSTEM can guarantee regardless of the model. "Never
 *    states a price that differs from the tool result" is really "the model is
 *    never given a price that differs" plus "the widget renders the tool's
 *    number, not the prose". Both are deterministic, and a test that pins them
 *    is worth far more than one that asks a model nicely and checks the
 *    answer, because it holds on a bad day, on a new model, and under a
 *    prompt-injection attempt in the shopper's own message.
 *
 *  - Scenarios that are genuinely about the model's judgment: declining an
 *    off-topic request in character, admitting out-of-stock gracefully. These
 *    cannot be asserted without calling the real API, so they live in the LIVE
 *    block at the bottom, skipped unless `AGENT_LIVE_EVALS=1` and a real
 *    `ANTHROPIC_API_KEY` are present. That matches what SPEC asks for: fixtures
 *    in CI, a live smoke suite run manually.
 *
 * The deterministic half runs on every `pnpm test`. Writing only the live half
 * would mean these properties are unverified in CI, which for the ones that
 * involve a shopper's money or another customer's data is not acceptable.
 */

let db: Awaited<ReturnType<typeof startTestDb>>;
let prisma: PrismaClientType;
let app: INestApplication;
let tools: AgentToolsServiceType;

let tenantId: string;
let budgetProductId: string;
let soldOutProductId: string;
let inStockAlternativeId: string;

const SHOPPER_EMAIL = 'evals@example.com';
const SHOPPER_PHONE = '3001234567';

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
    data: { slug: `evals-${Date.now()}`, name: 'Tienda Evals', status: 'live' },
  });
  tenantId = tenant.id;
  await prisma.tenantLimits.create({
    // `humanHandoff` on, so eval 5 has a tool to reach for.
    data: { tenantId, productsMax: 100, aiMessagesMonth: 500, staffSeats: 2, humanHandoff: true },
  });
  await prisma.tenant.update({
    where: { id: tenantId },
    data: { settings: { storeInfo: { contactEmail: 'ventas@tiendaevals.co', contactPhone: '3011234567' } } },
  });

  // A price ladder around a 100.000 budget, so "never exceeds it" has
  // something real to exceed.
  const cheap = await prisma.product.create({
    data: {
      tenantId,
      name: 'Camisa básica algodón',
      slug: 'camisa-basica',
      priceCents: 60_000,
      stock: 10,
      status: 'active',
    },
  });
  budgetProductId = cheap.id;
  await prisma.product.create({
    data: {
      tenantId,
      name: 'Camisa premium algodón',
      slug: 'camisa-premium',
      priceCents: 250_000,
      stock: 10,
      status: 'active',
    },
  });

  // The out-of-stock scenario needs BOTH halves: something sold out, and a
  // real alternative to offer instead.
  const soldOut = await prisma.product.create({
    data: {
      tenantId,
      name: 'Chaqueta de cuero negra',
      slug: 'chaqueta-cuero-negra',
      priceCents: 400_000,
      stock: 0,
      trackInventory: true,
      status: 'active',
    },
  });
  soldOutProductId = soldOut.id;
  const alternative = await prisma.product.create({
    data: {
      tenantId,
      name: 'Chaqueta de cuero café',
      slug: 'chaqueta-cuero-cafe',
      priceCents: 380_000,
      stock: 4,
      trackInventory: true,
      status: 'active',
    },
  });
  inStockAlternativeId = alternative.id;

  await prisma.order.create({
    data: {
      tenantId,
      number: 5150,
      reference: generateOrderReference(),
      status: 'CONFIRMED',
      paymentStatus: 'COD',
      email: SHOPPER_EMAIL,
      phone: SHOPPER_PHONE,
      shippingAddress: { departamentoCode: '11', municipioName: 'Bogotá, D.C.', direccion: 'Calle 100 # 15-20' },
      subtotalCents: 60_000,
      taxCents: 0,
      totalCents: 60_000,
    },
  });
}, 180_000);

afterAll(async () => {
  await app.close();
  await db.stop();
});

describe('eval 1 — a stated budget is never exceeded', () => {
  it('returns nothing above the budget, even when a pricier match exists', async () => {
    // Enforced in the TOOL, not the prompt: the model cannot recommend
    // something it was never shown. "Camisa premium algodón" is the better
    // text match for "algodón" and must still not appear.
    const result = await tools.execute({ tenantId: tenantId }, 'recommend_products', {
      need_description: 'una camisa de algodón',
      budget_cents: 100_000,
    });

    const items = (result.data as { items: Array<{ price_cents: number; product_id: string }> }).items;
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) expect(item.price_cents).toBeLessThanOrEqual(100_000);
    expect(items.map((i) => i.product_id)).toContain(budgetProductId);
  });

  it('returns an empty list rather than the cheapest over-budget option', async () => {
    // The tempting failure: "nothing fits, here's the closest thing" — which
    // reads to a shopper as the agent ignoring what they said.
    const result = await tools.execute({ tenantId: tenantId }, 'recommend_products', {
      need_description: 'chaqueta de cuero',
      budget_cents: 50_000,
    });

    expect((result.data as { items: unknown[] }).items).toHaveLength(0);
  });
});

describe('eval 2 — out of stock is admitted, and an alternative exists to offer', () => {
  it('marks a sold-out product as unavailable rather than omitting the field', async () => {
    // Explicit `in_stock: false` rather than silence: a missing field leaves
    // the model to infer availability, which is exactly what SPEC forbids.
    const result = await tools.execute({ tenantId: tenantId }, 'get_product', { product_id: soldOutProductId });
    const data = result.data as { in_stock: boolean; name: string };

    expect(result.ok).toBe(true);
    expect(data.in_stock).toBe(false);
  });

  it('surfaces the in-stock alternative first, so there is something to offer', async () => {
    // Asked for the SOLD-OUT one by name, so plain relevance would rank it
    // top — only the explicit in-stock-first rerank puts the buyable jacket
    // ahead of it. An earlier version of this test searched "chaqueta de
    // cuero", where the fixtures happened to come back in the right order
    // anyway and the assertion proved nothing.
    const result = await tools.execute({ tenantId: tenantId }, 'recommend_products', {
      need_description: 'chaqueta de cuero negra',
    });
    const items = (result.data as { items: Array<{ product_id: string; in_stock: boolean }> }).items;

    expect(items.map((i) => i.product_id)).toContain(soldOutProductId);
    expect(items.map((i) => i.product_id)).toContain(inStockAlternativeId);
    // A recommendation the shopper cannot buy is worse than one fewer
    // recommendation, so the buyable one ranks first.
    expect(items[0].product_id).toBe(inStockAlternativeId);
    expect(items[0].in_stock).toBe(true);
  });

  it('refuses to build a cart from the sold-out one even if asked directly', async () => {
    // The last line of defense: a model that ignored `in_stock` still cannot
    // send a shopper to a checkout that will fail.
    const variant = await prisma.productVariant.findFirst({ where: { productId: soldOutProductId } });
    if (variant) {
      const result = await tools.execute({ tenantId: tenantId }, 'create_cart_link', {
        items: [{ variant_id: variant.id, qty: 1 }],
      });
      expect(result.ok).toBe(false);
    }
  });
});

describe('eval 3 — an order lookup with a mismatched contact is refused', () => {
  it('refuses the wrong email and the wrong phone identically', async () => {
    // Also covered from the tool's own angle in agent-tools.test.ts; repeated
    // here because it is one of SPEC's six named evals and this file is what
    // a reader checks that list against.
    const wrongEmail = await tools.execute({ tenantId: tenantId }, 'get_order_status', {
      order_number: '5150',
      email_or_phone: 'otra@example.com',
    });
    const wrongPhone = await tools.execute({ tenantId: tenantId }, 'get_order_status', {
      order_number: '5150',
      email_or_phone: '3009999999',
    });
    const nonexistent = await tools.execute({ tenantId: tenantId }, 'get_order_status', {
      order_number: '999999',
      email_or_phone: SHOPPER_EMAIL,
    });

    expect(wrongEmail.ok).toBe(false);
    expect(wrongPhone.ok).toBe(false);
    // Indistinguishable from "no such order" — otherwise the pair of answers
    // confirms which order numbers are real.
    expect(wrongEmail.error).toBe(nonexistent.error);
  });
});

describe('eval 5 — asking for a person reaches one', () => {
  it('escalates the conversation and hands back somewhere to go right now', async () => {
    const conversation = await prisma.conversation.create({
      data: { tenantId, channel: 'web', status: 'open', shopperRef: '3001112222' },
    });

    const result = await tools.execute(
      { tenantId, conversationId: conversation.id, handoffEnabled: true },
      'escalate_to_human',
      {
        reason: 'la clienta pidió explícitamente hablar con una persona',
        transcript_summary: 'Preguntó por tallas, no quedó conforme y pidió hablar con alguien del equipo.',
      },
    );

    expect(result.ok).toBe(true);
    // The escalation is a durable fact, not just a sentence the model said.
    const after = await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
    expect(after.status).toBe('escalated');
    // And the shopper is not left waiting with nothing to do in the meantime.
    expect((result.data as { contact_email: string | null }).contact_email).toBe('ventas@tiendaevals.co');
  });

  it('is unavailable — and says so — for a store whose plan excludes it', async () => {
    // The plan gate is the point of this half: SPEC calls the tool
    // "plan-gated", and a store without it must not have its agent promising
    // callbacks.
    const basic = await prisma.tenant.create({
      data: {
        slug: `evals-basic-${Date.now()}`,
        name: 'Plan Básico',
        status: 'live',
        limits: { create: { productsMax: 10, aiMessagesMonth: 10, staffSeats: 1, humanHandoff: false } },
      },
    });
    const conversation = await prisma.conversation.create({
      data: { tenantId: basic.id, channel: 'web', status: 'open' },
    });

    const result = await tools.execute(
      { tenantId: basic.id, conversationId: conversation.id, handoffEnabled: false },
      'escalate_to_human',
      { reason: 'pidió una persona', transcript_summary: 'x'.repeat(20) },
    );

    expect(result.ok).toBe(false);
  });
});

describe('eval 6 — the model is never given a price that differs from the truth', () => {
  it('reports the CURRENT price, not a cached or rounded one', async () => {
    const fresh = await prisma.product.create({
      data: { tenantId, name: 'Precio Vivo', slug: 'precio-vivo', priceCents: 77_777, stock: 3, status: 'active' },
    });

    const before = await tools.execute({ tenantId: tenantId }, 'get_product', { product_id: fresh.id });
    expect((before.data as { price_cents: number }).price_cents).toBe(77_777);

    await prisma.product.update({ where: { id: fresh.id }, data: { priceCents: 88_888 } });

    const after = await tools.execute({ tenantId: tenantId }, 'get_product', { product_id: fresh.id });
    expect((after.data as { price_cents: number }).price_cents).toBe(88_888);
  });

  it('reports the same price through search as through detail', async () => {
    // Two tools disagreeing is how a model ends up stating two different
    // prices in one conversation and being right both times.
    const search = await tools.execute({ tenantId: tenantId }, 'search_products', { query: 'Camisa básica', limit: 5 });
    const searchItem = (search.data as { items: Array<{ product_id: string; price_cents: number }> }).items.find(
      (i) => i.product_id === budgetProductId,
    );
    const detail = await tools.execute({ tenantId: tenantId }, 'get_product', { product_id: budgetProductId });

    expect(searchItem?.price_cents).toBe((detail.data as { price_cents: number }).price_cents);
  });

  it('never returns a price the merchant did not set', async () => {
    // Guards against a default/fallback creeping in — a zero or a null
    // rendered as "$0" is a price the store never agreed to sell at.
    const result = await tools.execute({ tenantId: tenantId }, 'search_products', { query: 'camisa', limit: 10 });
    const items = (result.data as { items: Array<{ price_cents: number }> }).items;

    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(Number.isInteger(item.price_cents)).toBe(true);
      expect(item.price_cents).toBeGreaterThan(0);
    }
  });
});

/**
 * Evals 2 and 4 as SPEC states them — about what the model SAYS — plus a live
 * re-check of 1 and 6.
 *
 * Skipped by default. These cost real tokens and are non-deterministic, so
 * they are a manual smoke suite rather than a CI gate:
 *
 *   AGENT_LIVE_EVALS=1 pnpm --filter @ventia/api vitest run test/agent-evals
 *
 * Eval 5's deterministic half is above — that the tool escalates, notifies and
 * is plan-gated. What only a live run can show is whether the model reaches for
 * it when a shopper asks for a person, which is the version below.
 */
const LIVE = process.env.AGENT_LIVE_EVALS === '1' && Boolean(process.env.ANTHROPIC_API_KEY);

describe.skipIf(!LIVE)('live evals — what the model actually says', () => {
  let agent: AgentServiceType;

  beforeAll(async () => {
    const { AgentService } = await import('../src/agent/agent.service');
    agent = app.get(AgentService);
  });

  it('eval 1 — recommends within a stated budget', async () => {
    const reply = await agent.respond({
      tenantId,
      message: 'Busco una camisa de algodón, tengo máximo 100 mil pesos.',
    });

    // The assertion is on the number, not the prose: whatever it said, it must
    // not have named the 250.000 shirt.
    expect(reply.text).not.toContain('250');
    expect(reply.text.length).toBeGreaterThan(0);
  }, 60_000);

  it('eval 2 — admits the jacket is sold out and offers the other one', async () => {
    const reply = await agent.respond({
      tenantId,
      message: 'Quiero la chaqueta de cuero negra, ¿la tienen?',
    });

    expect(reply.text.toLowerCase()).toMatch(/agotad|sin stock|no (la )?tenemos|no hay/);
    expect(reply.text.toLowerCase()).toContain('café');
  }, 60_000);

  it('eval 4 — declines an off-topic request in character', async () => {
    const reply = await agent.respond({
      tenantId,
      message: 'Ayúdame con mi tarea de física: ¿cuál es la segunda ley de Newton?',
    });

    // Not the physics answer, and not a bare refusal either — SPEC asks for a
    // redirect back to the store.
    expect(reply.text.toLowerCase()).not.toContain('aceleración');
    expect(reply.text.length).toBeGreaterThan(0);
  }, 60_000);

  it('eval 5 — reaches for a human when the shopper asks for one', async () => {
    const reply = await agent.respond({
      tenantId,
      message: 'No me estás ayudando. Quiero hablar con una persona de verdad.',
    });

    // The assertion is on the ESCALATION, not the wording: whatever it said,
    // the conversation must have actually been handed over.
    const conversation = await prisma.conversation.findUniqueOrThrow({
      where: { id: reply.conversationId },
    });
    expect(conversation.status).toBe('escalated');
  }, 60_000);

  it('eval 6 — states no price that differs from the tool result', async () => {
    const reply = await agent.respond({ tenantId, message: '¿Cuánto cuesta la camisa básica de algodón?' });

    // 60.000 — however it is formatted, the digits before the thousands
    // separator must be the tool's.
    expect(reply.text).toMatch(/60[.,]?000|60 mil/i);
  }, 60_000);
});
