import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateOrderReference } from '@ventia/core';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient as PrismaClientType } from '@ventia/db';
import { startTestDb } from './helpers';
import type { AgentToolsService as AgentToolsServiceType } from '../src/agent/agent-tools.service';

let db: Awaited<ReturnType<typeof startTestDb>>;
let prisma: PrismaClientType;
let app: INestApplication;
let tools: AgentToolsServiceType;

let tenantAId: string;
let tenantBId: string;
/** Tenant A's active product variant. */
let variantAId: string;
/** Tenant B's product — the cross-tenant probe. */
let productBId: string;
let variantBId: string;
let archivedProductId: string;
let archivedVariantId: string;

const SHOPPER_EMAIL = 'compradora@example.com';
const SHOPPER_PHONE = '3001112233';
const STREET = 'Carrera 7 # 71-52 apto 901';

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

  const tenantA = await prisma.tenant.create({
    data: { slug: `agent-a-${Date.now()}`, name: 'Tienda Agente A', status: 'live' },
  });
  const tenantB = await prisma.tenant.create({
    data: { slug: `agent-b-${Date.now()}`, name: 'Tienda Agente B', status: 'live' },
  });
  tenantAId = tenantA.id;
  tenantBId = tenantB.id;

  const productA = await prisma.product.create({
    data: {
      tenantId: tenantAId,
      name: 'Camisa Lino Blanca',
      slug: 'camisa-lino-blanca',
      priceCents: 120_000,
      stock: 10,
      status: 'active',
      variants: { create: [{ tenantId: tenantAId, option1: 'M', stock: 5 }] },
    },
    include: { variants: true },
  });
  variantAId = productA.variants[0].id;

  const productB = await prisma.product.create({
    data: {
      tenantId: tenantBId,
      name: 'Producto Secreto de B',
      slug: 'producto-secreto-b',
      priceCents: 999_000,
      stock: 10,
      status: 'active',
      variants: { create: [{ tenantId: tenantBId, option1: 'U', stock: 5 }] },
    },
    include: { variants: true },
  });
  productBId = productB.id;
  variantBId = productB.variants[0].id;

  const archived = await prisma.product.create({
    data: {
      tenantId: tenantAId,
      name: 'Descontinuado',
      slug: 'descontinuado',
      priceCents: 50_000,
      stock: 10,
      status: 'archived',
      variants: { create: [{ tenantId: tenantAId, option1: 'U', stock: 10 }] },
    },
    include: { variants: true },
  });
  archivedProductId = archived.id;
  archivedVariantId = archived.variants[0].id;

  await prisma.order.create({
    data: {
      tenantId: tenantAId,
      number: 4242,
      reference: generateOrderReference(),
      status: 'CONFIRMED',
      paymentStatus: 'COD',
      email: SHOPPER_EMAIL,
      phone: SHOPPER_PHONE,
      shippingAddress: { departamentoCode: '11', municipioName: 'Bogotá, D.C.', direccion: STREET },
      subtotalCents: 120_000,
      taxCents: 0,
      totalCents: 120_000,
    },
  });

  await prisma.tenantContent.create({
    data: { tenantId: tenantAId, type: 'policy_shipping', title: 'Envíos', bodyMd: 'Enviamos a todo el país en 3 días.' },
  });
}, 180_000);

afterAll(async () => {
  await app.close();
  await db.stop();
});

describe('agent tools — tenant scoping', () => {
  it('cannot read another tenant\'s product by id', async () => {
    // The whole trust model: `tenantId` comes from the conversation, never
    // from the model. A tool input naming another store's product finds
    // nothing rather than describing it.
    const res = await tools.execute({ tenantId: tenantAId }, 'get_product', { product_id: productBId });

    expect(res.ok).toBe(false);
    expect(JSON.stringify(res)).not.toContain('Producto Secreto de B');
    expect(JSON.stringify(res)).not.toContain('999');
  });

  it('cannot search up another tenant\'s catalogue', async () => {
    const res = await tools.execute({ tenantId: tenantAId }, 'search_products', { query: 'Secreto', limit: 5 });

    expect(res.ok).toBe(true);
    expect(JSON.stringify(res)).not.toContain('Producto Secreto de B');
  });

  it('cannot build a cart from another tenant\'s variant', async () => {
    const res = await tools.execute({ tenantId: tenantAId }, 'create_cart_link', {
      items: [{ variant_id: variantBId, qty: 1 }],
    });

    expect(res.ok).toBe(false);
    const carts = await prisma.cart.findMany({ where: { tenantId: tenantAId } });
    expect(carts).toHaveLength(0);
  });
});

describe('agent tools — get_order_status double factor', () => {
  it('returns the order for the right number AND contact', async () => {
    const res = await tools.execute({ tenantId: tenantAId }, 'get_order_status', {
      order_number: '4242',
      email_or_phone: SHOPPER_EMAIL,
    });

    expect(res.ok).toBe(true);
    expect((res.data as { order_number: number }).order_number).toBe(4242);
  });

  it('accepts the phone as the second factor too', async () => {
    const res = await tools.execute({ tenantId: tenantAId }, 'get_order_status', {
      order_number: '4242',
      email_or_phone: SHOPPER_PHONE,
    });

    expect(res.ok).toBe(true);
  });

  it('gives the SAME answer for a wrong contact as for a nonexistent order', async () => {
    // The property that stops an order-number sweep through the chat widget
    // from revealing which numbers are real. If these two diverged — different
    // wording, different shape — the agent would happily narrate the
    // difference to whoever asked.
    const wrongContact = await tools.execute({ tenantId: tenantAId }, 'get_order_status', {
      order_number: '4242',
      email_or_phone: 'noesmio@example.com',
    });
    const noSuchOrder = await tools.execute({ tenantId: tenantAId }, 'get_order_status', {
      order_number: '999999',
      email_or_phone: SHOPPER_EMAIL,
    });

    expect(wrongContact.ok).toBe(false);
    expect(noSuchOrder.ok).toBe(false);
    expect(wrongContact.error).toBe(noSuchOrder.error);
  });

  it('never returns the street address, email or phone', async () => {
    // SPEC.md §7: the agent does not echo a full address even to someone who
    // passed the double factor — a chat transcript is a leakier surface than
    // the order page, and it can be screenshotted, forwarded, or read over a
    // shoulder.
    const res = await tools.execute({ tenantId: tenantAId }, 'get_order_status', {
      order_number: '4242',
      email_or_phone: SHOPPER_EMAIL,
    });

    const serialized = JSON.stringify(res);
    expect(res.ok).toBe(true);
    expect(serialized).not.toContain(STREET);
    expect(serialized).not.toContain(SHOPPER_EMAIL);
    expect(serialized).not.toContain(SHOPPER_PHONE);
    // The city IS returned — a shopper asking "where is my order going"
    // deserves that much, and it is not identifying on its own.
    expect(serialized).toContain('Bogotá');
  });

  it('cannot read an order belonging to another tenant', async () => {
    const res = await tools.execute({ tenantId: tenantBId }, 'get_order_status', {
      order_number: '4242',
      email_or_phone: SHOPPER_EMAIL,
    });

    expect(res.ok).toBe(false);
  });
});

describe('agent tools — what the model may not sell', () => {
  it('refuses to describe a non-active product', async () => {
    const res = await tools.execute({ tenantId: tenantAId }, 'get_product', { product_id: archivedProductId });
    expect(res.ok).toBe(false);
  });

  it('refuses to build a cart from an archived product', async () => {
    // Reachable for real: a product can be archived mid-conversation, after
    // the agent already mentioned it.
    const res = await tools.execute({ tenantId: tenantAId }, 'create_cart_link', {
      items: [{ variant_id: archivedVariantId, qty: 1 }],
    });

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/disponible/i);
  });

  it('refuses to build a cart beyond available stock', async () => {
    // qty 10 against a variant holding 5: inside the schema's per-line cap, so
    // this genuinely reaches the stock check rather than being turned away as
    // malformed input (which is what a larger number would do, and did).
    const res = await tools.execute({ tenantId: tenantAId }, 'create_cart_link', {
      items: [{ variant_id: variantAId, qty: 10 }],
    });

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/stock/i);
  });

  it('says so when the merchant has not published a policy, rather than inventing one', async () => {
    // The failure this prevents is the agent confabulating a returns policy.
    // An explicit "not published" is something the model can repeat honestly.
    const res = await tools.execute({ tenantId: tenantAId }, 'get_store_info', { topic: 'returns' });

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/todavía no/i);
  });

  it('returns the merchant\'s own words when they HAVE published', async () => {
    const res = await tools.execute({ tenantId: tenantAId }, 'get_store_info', { topic: 'shipping' });

    expect(res.ok).toBe(true);
    expect((res.data as { body: string }).body).toContain('3 días');
  });
});

describe('agent tools — cart creation', () => {
  it('creates an agent-sourced cart, which is what the AI-assisted-sales KPI counts', async () => {
    const res = await tools.execute({ tenantId: tenantAId }, 'create_cart_link', {
      items: [{ variant_id: variantAId, qty: 2 }],
    });

    expect(res.ok).toBe(true);
    const data = res.data as { cart_url: string; item_count: number; subtotal_cents: number };
    expect(data.item_count).toBe(2);
    expect(data.subtotal_cents).toBe(240_000);

    const key = new URL(`http://x${data.cart_url}`).searchParams.get('c');
    const cart = await prisma.cart.findFirst({ where: { tenantId: tenantAId, cookieKey: key! }, include: { items: true } });
    expect(cart?.source).toBe('agent');
    expect(cart?.items).toHaveLength(1);
    expect(cart?.items[0].qty).toBe(2);
  });

  it('does not touch a cart the shopper already built', async () => {
    // The agent proposes a basket; it does not get to overwrite or merge into
    // one someone assembled by hand on the storefront.
    const existing = await prisma.cart.create({
      data: { tenantId: tenantAId, cookieKey: `shopper-own-${Date.now()}`, source: 'web' },
    });

    await tools.execute({ tenantId: tenantAId }, 'create_cart_link', { items: [{ variant_id: variantAId, qty: 1 }] });

    const after = await prisma.cart.findUnique({ where: { id: existing.id }, include: { items: true } });
    expect(after?.source).toBe('web');
    expect(after?.items).toHaveLength(0);
  });
});

describe('agent tools — input handling', () => {
  it('rejects malformed input instead of coercing it', async () => {
    // Tool inputs are model-generated text reacting to whatever a shopper
    // typed. Every executor parses before it queries.
    const badUuid = await tools.execute({ tenantId: tenantAId }, 'get_product', { product_id: 'not-a-uuid' });
    const negativeQty = await tools.execute({ tenantId: tenantAId }, 'create_cart_link', {
      items: [{ variant_id: variantAId, qty: -5 }],
    });
    const missingField = await tools.execute({ tenantId: tenantAId }, 'get_order_status', { order_number: '4242' });

    expect(badUuid.ok).toBe(false);
    expect(negativeQty.ok).toBe(false);
    expect(missingField.ok).toBe(false);
  });

  it('returns an error result for an unknown tool rather than throwing', async () => {
    // The model can emit a name that does not exist; the conversation should
    // survive that, not 500.
    const res = await tools.execute({ tenantId: tenantAId }, 'delete_everything', {});
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/desconocida/i);
  });

  it('never leaks a raw database error into a model-facing string', async () => {
    const res = await tools.execute({ tenantId: tenantAId }, 'get_product', { product_id: 'not-a-uuid' });
    expect(res.error).not.toMatch(/prisma|invalid `|postgres|column/i);
  });
});
