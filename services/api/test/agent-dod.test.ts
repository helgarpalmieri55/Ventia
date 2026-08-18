import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import Redis from 'ioredis';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient as PrismaClientType } from '@ventia/db';
import { startTestDb } from './helpers';
import type { AgentToolsService as AgentToolsServiceType } from '../src/agent/agent-tools.service';

/**
 * SPEC.md §11's P4 Definition of Done, the sentence that is not covered
 * anywhere else: "an agent-created cart converts to an order flagged
 * `source=agent`".
 *
 * Each link in that chain is already tested on its own — `create_cart_link`
 * writes `source: 'agent'` (agent-tools.test.ts), the adopt endpoint hands the
 * cart to the shopper (cart.test.ts), checkout inherits the cart's source
 * (checkout.test.ts). None of that proves the chain HOLDS: the adopt endpoint
 * could hand over the right cart while the checkout reads a different one, and
 * every one of those tests would still pass while the KPI silently read zero.
 *
 * So this drives the whole path the way a shopper does — tool, then two HTTP
 * calls with the cookie the server itself issued — and asserts the one field
 * the merchant's "ventas asistidas por IA" number is computed from.
 */

const DOD_DOMAIN = 'agent-dod.ventia.localhost';

let db: Awaited<ReturnType<typeof startTestDb>>;
let prisma: PrismaClientType;
let app: INestApplication;
let tools: AgentToolsServiceType;

let tenantId: string;
let variantId: string;

beforeAll(async () => {
  db = await startTestDb();
  process.env.DATABASE_URL = db.url;
  process.env.REDIS_URL = 'redis://localhost:6379';
  process.env.ANTHROPIC_API_KEY ??= 'sk-ant-test-not-used';

  // DomainResolver caches domain → tenant in the shared dev Redis for 60s.
  const cacheBuster = new Redis(process.env.REDIS_URL);
  await cacheBuster.del(`tenant:domain:${DOD_DOMAIN}`);
  await cacheBuster.quit();

  const { createApp } = await import('../src/main');
  app = await createApp();
  await app.init();

  ({ platformDb: prisma } = (await import('@ventia/db')) as unknown as { platformDb: PrismaClientType });
  const { AgentToolsService } = await import('../src/agent/agent-tools.service');
  tools = app.get(AgentToolsService);

  const tenant = await prisma.tenant.create({
    data: {
      slug: `agent-dod-${Date.now()}`,
      name: 'Tienda DoD',
      status: 'live',
      settings: {
        shipping: {
          methods: [{ id: 'flat-1', type: 'flat', label: 'Envío estándar', priceCents: 12_000, enabled: true }],
        },
      },
      limits: { create: { productsMax: 100, aiMessagesMonth: 500, staffSeats: 2 } },
    },
  });
  tenantId = tenant.id;
  await prisma.tenantDomain.create({ data: { tenantId, domain: DOD_DOMAIN, isPrimary: true } });

  const product = await prisma.product.create({
    data: {
      tenantId,
      name: 'Vestido Fiesta',
      slug: 'vestido-fiesta',
      priceCents: 180_000,
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

describe('P4 DoD — an agent-created cart converts to an order flagged source=agent', () => {
  it('runs the whole path: tool builds the cart, shopper adopts it, checkout attributes the order', async () => {
    // 1. The agent proposes a basket. This is the only step that is not an
    //    HTTP call — it is what the model triggers mid-conversation.
    const toolResult = await tools.execute({ tenantId }, 'create_cart_link', {
      items: [{ variant_id: variantId, qty: 2 }],
    });
    expect(toolResult.ok).toBe(true);
    const cartUrl = (toolResult.data as { cart_url: string }).cart_url;
    // The widget renders this URL verbatim; the key is what the storefront
    // pulls out of it.
    const cookieKey = new URLSearchParams(cartUrl.split('?')[1]).get('c');
    expect(cookieKey).toBeTruthy();

    // 2. The shopper follows the link. The storefront posts the key and the
    //    server decides which cart the browser now owns.
    const adopt = await request(app.getHttpServer())
      .post('/v1/storefront/cart/adopt')
      .set('x-tenant-domain', DOD_DOMAIN)
      .send({ cookieKey });
    expect(adopt.status).toBe(201);
    expect(adopt.body.lines).toHaveLength(1);

    // Deliberately taken from the RESPONSE's Set-Cookie rather than reusing
    // `cookieKey`: that is what a browser would send back, and reusing the
    // variable would hide a server that set the cookie to something else.
    const setCookie = adopt.headers['set-cookie'] as unknown as string[] | undefined;
    const issued = setCookie?.find((c) => c.startsWith('ventia_cart='))?.split(';')[0];
    expect(issued).toBeDefined();

    // 3. Checkout, exactly as any shopper does it.
    const checkout = await request(app.getHttpServer())
      .post('/v1/storefront/checkout')
      .set('x-tenant-domain', DOD_DOMAIN)
      .set('Cookie', issued!)
      .send({
        email: 'dod-shopper@example.com',
        phone: '3001112233',
        address: {
          nombreCompleto: 'Compradora DoD',
          telefono: '3001112233',
          departamentoCode: '11',
          municipioName: 'Bogotá, D.C.',
          direccion: 'Calle 1 # 2-34',
        },
        shippingMethodId: 'flat-1',
        paymentMethod: 'cod',
      });
    expect(checkout.status).toBe(201);

    // 4. The claim itself.
    const order = await prisma.order.findFirstOrThrow({
      where: { tenantId, email: 'dod-shopper@example.com' },
      include: { items: true },
    });
    expect(order.source).toBe('agent');
    // And it is the AGENT's basket that was bought, not an empty cart that
    // happened to check out — 2 units of the variant the tool chose.
    expect(order.items).toHaveLength(1);
    expect(order.items[0].qty).toBe(2);
    expect(order.subtotalCents).toBe(180_000 * 2);
    expect(order.shippingCents).toBe(12_000);
    // SPEC.md §5: prices INCLUDE IVA, so the shopper pays the sticker price
    // plus shipping and nothing else. `taxCents` is the portion of that
    // subtotal which is IVA, recorded for the DIAN breakdown — adding it would
    // charge IVA twice.
    //
    // This assertion is what caught that bug: written as `subtotal + tax +
    // shipping` it disagreed with a hand-computed total by 57.479 pesos, which
    // turned out to be the code over-charging rather than the arithmetic being
    // wrong.
    expect(order.totalCents).toBe(order.subtotalCents + order.shippingCents);
    expect(order.taxCents).toBeGreaterThan(0);
    expect(order.taxCents).toBeLessThan(order.subtotalCents);
  });

  it('shows up in the merchant\'s AI-assisted-sales figure', async () => {
    // The end of the chain the DoD sentence exists for: the attribution is
    // only worth anything if the number the merchant reads moves.
    const { signUpWithTenant } = await import('./admin-helpers');
    const { cookie, tenantId: staffTenantId } = await signUpWithTenant('dod-owner@demo.co', 'owner');

    // Seeded directly rather than replayed through the whole path above: the
    // first test already proved the path produces `source: 'agent'`, and this
    // one is about what the merchant's endpoint does with such an order.
    await prisma.order.create({
      data: {
        tenantId: staffTenantId,
        number: 1,
        reference: `vr_dod${Date.now()}`,
        status: 'CONFIRMED',
        paymentStatus: 'COD',
        email: 'dod-kpi@example.com',
        phone: '3001112233',
        shippingAddress: {},
        shippingMethod: 'flat-1',
        shippingCents: 0,
        subtotalCents: 360_000,
        taxCents: 0,
        totalCents: 360_000,
        source: 'agent',
      },
    });

    const usage = await request(app.getHttpServer()).get('/v1/admin/agent/usage').set('cookie', cookie);

    expect(usage.status).toBe(200);
    expect(usage.body.assistedSales.orders).toBe(1);
    expect(usage.body.assistedSales.revenueCents).toBe(360_000);
  });
});
