import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient as PrismaClientType, SalesChannel, OrderStatus } from '@ventia/db';
import {
  DASHBOARD_MAX_RANGE_DAYS,
  dashboardQuerySchema,
  generateOrderReference,
  type DashboardResponse,
} from '@ventia/core';
import { startTestDb } from './helpers';
import type { signUpWithTenant as SignUpWithTenant } from './admin-helpers';
import { addBogotaDays, bogotaDayOf, daysInRange, eachBogotaDay, startOfBogotaDay } from '../src/dashboard/bogota-day';
import { previousWindow, resolveRange } from '../src/dashboard/dashboard-range';
import { aiResolution, changePct, resolutionPct, sharePct } from '../src/dashboard/kpi-math';

/**
 * `GET /v1/admin/dashboard` — the derivable half of the tablero
 * (docs/design-gap.md §5, §7 item 4).
 *
 * The feature is arithmetic over rows that already exist, so most of what can
 * go wrong is a judgement call quietly made wrong rather than an exception.
 * These tests are written against those calls by name:
 *
 *  1. Cancelled orders count nowhere — and "nowhere" includes the product,
 *     channel and payment panels, not only the sales tile.
 *  2. A day is a COLOMBIAN day. The two orders that pin this down are placed
 *     at 04:59 UTC (still yesterday in Bogota) and 04:59 UTC the day after the
 *     window closes (still inside it in Bogota); a UTC-bucketing implementation
 *     puts both in the wrong bucket and passes every other test in this file.
 *  3. The comparison window is the equally long window immediately before, so
 *     "vs ayer" is what a one-day range means and nothing else has to be a
 *     special case.
 *  4. Nothing invents a number for an empty store: no `+100%` off a zero base,
 *     no `Infinity`, no 0% resolution rate for a store nobody has written to.
 */

let db: Awaited<ReturnType<typeof startTestDb>>;
let redisContainer: StartedTestContainer;
let app: INestApplication;
let prisma: PrismaClientType;
let signUpWithTenant: typeof SignUpWithTenant;

/** The window every seeded assertion below is written against. Fixed dates,
 * in the past, so nothing here depends on when the suite runs. */
const FROM = '2026-08-10';
const TO = '2026-08-16';

let shop: { cookie: string; tenantId: string };
let neighbour: { cookie: string; tenantId: string };
let emptyShop: { cookie: string; tenantId: string };
let productIds: { camiseta: string; vestido: string };

beforeAll(async () => {
  db = await startTestDb();
  redisContainer = await new GenericContainer('redis:7-alpine')
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
    .start();

  // Env before the first import of @ventia/db / ../src/main / ./admin-helpers,
  // same pattern as orders-transitions.test.ts.
  process.env.DATABASE_URL = db.url;
  process.env.REDIS_URL = `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`;

  const { createApp } = await import('../src/main');
  app = await createApp();
  await app.init();

  ({ signUpWithTenant } = await import('./admin-helpers'));
  ({ platformDb: prisma } = (await import('@ventia/db')) as unknown as { platformDb: PrismaClientType });

  shop = await signUpWithTenant('tablero@example.com', 'owner');
  neighbour = await signUpWithTenant('vecina@example.com', 'owner');
  emptyShop = await signUpWithTenant('recien-abierta@example.com', 'owner');

  productIds = {
    camiseta: await seedProduct(shop.tenantId, 'Camiseta'),
    vestido: await seedProduct(shop.tenantId, 'Vestido'),
  };

  await seedFixtures();
}, 180_000);

afterAll(async () => {
  await app.close();
  await redisContainer.stop();
  await db.stop();
});

// ---------------------------------------------------------------- fixtures

let orderNumber = 1;

async function seedProduct(tenantId: string, name: string): Promise<string> {
  const product = await prisma.product.create({
    data: { tenantId, name, slug: `${name.toLowerCase()}-${randomUUID()}`, priceCents: 20_000, status: 'active', stock: 100 },
  });
  return product.id;
}

interface SeedItem {
  productId?: string | null;
  name: string;
  priceCents: number;
  qty: number;
}

async function seedOrder(
  tenantId: string,
  opts: {
    at: string;
    totalCents: number;
    status?: OrderStatus;
    channel?: SalesChannel;
    paymentProvider?: string | null;
    items?: SeedItem[];
  },
): Promise<void> {
  const order = await prisma.order.create({
    data: {
      tenantId,
      number: orderNumber++,
      reference: generateOrderReference(),
      status: opts.status ?? 'CONFIRMED',
      paymentStatus: opts.paymentProvider ? 'PAID' : 'COD',
      paymentProvider: opts.paymentProvider ?? null,
      channel: opts.channel ?? 'web',
      email: 'compradora@example.com',
      phone: '3000000000',
      shippingAddress: {},
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
        productId: item.productId ?? null,
        nameSnapshot: item.name,
        priceCentsSnapshot: item.priceCents,
        qty: item.qty,
        taxRateSnapshot: 'NINETEEN',
      },
    });
  }
}

async function seedConversation(tenantId: string, at: string, status: string): Promise<void> {
  await prisma.conversation.create({
    data: { tenantId, channel: 'web', status, startedAt: new Date(at) },
  });
}

async function seedFixtures(): Promise<void> {
  const { camiseta, vestido } = productIds;

  // --- inside the window ------------------------------------------------
  // 05:00Z is exactly 00:00 in Bogota: the window's first instant.
  await seedOrder(shop.tenantId, {
    at: '2026-08-10T05:00:00.000Z',
    totalCents: 100_000,
    channel: 'web',
    paymentProvider: 'wompi',
    items: [
      { productId: camiseta, name: 'Camiseta', priceCents: 20_000, qty: 2 },
      { productId: vestido, name: 'Vestido', priceCents: 60_000, qty: 1 },
    ],
  });
  await seedOrder(shop.tenantId, {
    at: '2026-08-16T23:00:00.000Z',
    totalCents: 50_000,
    channel: 'whatsapp',
    paymentProvider: null, // contra entrega
    items: [{ productId: camiseta, name: 'Camiseta', priceCents: 20_000, qty: 3 }],
  });
  // 04:59Z on the 17th is 23:59 on the 16th in Bogota — the LAST minute of the
  // window. A UTC implementation drops this sale entirely.
  await seedOrder(shop.tenantId, {
    at: '2026-08-17T04:59:00.000Z',
    totalCents: 60_000,
    channel: 'whatsapp',
    paymentProvider: 'wompi',
    // Renamed since the first sale: same product id, newer snapshot. Priced so
    // the vestido out-EARNS the camiseta while selling fewer units — which is
    // what makes "ranked by units" a claim this file can actually check.
    items: [{ productId: vestido, name: 'Vestido largo', priceCents: 60_000, qty: 1 }],
  });
  // Cancelled, and deliberately enormous: if it leaks into any panel the
  // numbers below are unmissably wrong.
  await seedOrder(shop.tenantId, {
    at: '2026-08-12T12:00:00.000Z',
    totalCents: 999_999,
    status: 'CANCELLED',
    channel: 'instagram',
    paymentProvider: 'epayco',
    items: [{ productId: camiseta, name: 'Camiseta', priceCents: 20_000, qty: 50 }],
  });

  // --- the previous window (2026-08-03 .. 2026-08-09) -------------------
  // 04:59:59Z on the 10th is still the 9th in Bogota.
  await seedOrder(shop.tenantId, { at: '2026-08-10T04:59:59.000Z', totalCents: 40_000 });

  // --- after the window --------------------------------------------------
  await seedOrder(shop.tenantId, { at: '2026-08-17T05:00:00.000Z', totalCents: 777_000 });

  // --- another merchant, same days --------------------------------------
  await seedOrder(neighbour.tenantId, {
    at: '2026-08-12T15:00:00.000Z',
    totalCents: 500_000,
    channel: 'other',
    paymentProvider: 'mercadopago',
    items: [{ productId: null, name: 'Producto de la vecina', priceCents: 500_000, qty: 1 }],
  });

  // --- conversations -----------------------------------------------------
  await seedConversation(shop.tenantId, '2026-08-11T14:00:00.000Z', 'open');
  await seedConversation(shop.tenantId, '2026-08-12T14:00:00.000Z', 'open');
  await seedConversation(shop.tenantId, '2026-08-13T14:00:00.000Z', 'open');
  await seedConversation(shop.tenantId, '2026-08-14T14:00:00.000Z', 'escalated');
  // Escalated and then answered by the merchant. Counts as human-handled.
  await seedConversation(shop.tenantId, '2026-08-15T14:00:00.000Z', 'resolved');
  // Previous window: one of each.
  await seedConversation(shop.tenantId, '2026-08-05T14:00:00.000Z', 'open');
  await seedConversation(shop.tenantId, '2026-08-06T14:00:00.000Z', 'escalated');
  // Long before either window — must not be counted anywhere.
  await seedConversation(shop.tenantId, '2026-06-01T14:00:00.000Z', 'open');
}

async function getDashboard(
  auth: { cookie: string },
  query: Record<string, string> = { from: FROM, to: TO },
): Promise<DashboardResponse> {
  const response = await request(app.getHttpServer())
    .get('/v1/admin/dashboard')
    .query(query)
    .set('Cookie', auth.cookie)
    .expect(200);
  return response.body as DashboardResponse;
}

// ------------------------------------------------------- civil-day helpers

describe('días civiles colombianos', () => {
  it('un instante antes de las 05:00 UTC todavía pertenece al día anterior', () => {
    // The whole reason this module exists: 23:59 in Bogota is already tomorrow
    // in UTC, and a sale made then belongs to the merchant's today.
    expect(bogotaDayOf(new Date('2026-08-22T04:59:59.999Z'))).toBe('2026-08-21');
    expect(bogotaDayOf(new Date('2026-08-22T05:00:00.000Z'))).toBe('2026-08-22');
  });

  it('el día civil empieza a las 05:00 UTC', () => {
    expect(startOfBogotaDay('2026-08-21').toISOString()).toBe('2026-08-21T05:00:00.000Z');
  });

  it('la aritmética de días cruza meses y años bisiestos', () => {
    expect(addBogotaDays('2026-08-31', 1)).toBe('2026-09-01');
    expect(addBogotaDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(addBogotaDays('2028-02-28', 1)).toBe('2028-02-29');
  });

  it('un rango de un solo día mide un día, no cero', () => {
    expect(daysInRange('2026-08-21', '2026-08-21')).toBe(1);
    expect(daysInRange('2026-08-21', '2026-08-22')).toBe(2);
    expect(eachBogotaDay('2026-08-30', '2026-09-02')).toEqual([
      '2026-08-30',
      '2026-08-31',
      '2026-09-01',
      '2026-09-02',
    ]);
  });
});

// ------------------------------------------------------------- KPI algebra

describe('aritmética de los KPIs', () => {
  it('no reporta variación cuando no hay base contra la cual comparar', () => {
    // The three tempting wrong answers, one per line: Infinity, +100%, 0%.
    expect(changePct(5, 0)).toBeNull();
    expect(changePct(0, 0)).toBeNull();
    expect(changePct(1_000_000, 0)).toBeNull();
  });

  it('calcula subidas y bajadas en porcentaje entero', () => {
    expect(changePct(150, 100)).toBe(50);
    expect(changePct(50, 100)).toBe(-50);
    expect(changePct(0, 100)).toBe(-100);
    expect(changePct(100, 100)).toBe(0);
  });

  it('la tasa de resolución es nula, no 0%, sin conversaciones', () => {
    expect(resolutionPct(0, 0)).toBeNull();
    expect(resolutionPct(10, 1)).toBe(90);
  });

  it('no redondea 99,6% hasta convertirlo en un 100% que sería mentira', () => {
    expect(resolutionPct(1000, 4)).toBe(99.6);
  });

  it('compara tasas en puntos porcentuales, no en porcentaje de porcentaje', () => {
    const moved = aiResolution({ conversations: 10, handedToHuman: 5 }, { conversations: 10, handedToHuman: 6 });
    expect(moved.ratePct).toBe(50);
    expect(moved.previousRatePct).toBe(40);
    // +10 points. As a percentage change it would be "+25%", which is true of
    // the ratio and useless on a tile.
    expect(moved.changePoints).toBe(10);
  });

  it('no compara contra un período sin conversaciones', () => {
    const fresh = aiResolution({ conversations: 4, handedToHuman: 1 }, { conversations: 0, handedToHuman: 0 });
    expect(fresh.ratePct).toBe(75);
    expect(fresh.previousRatePct).toBeNull();
    expect(fresh.changePoints).toBeNull();
  });

  it('una participación sobre cero no es 0%, es desconocida', () => {
    expect(sharePct(0, 0)).toBeNull();
    expect(sharePct(1, 3)).toBe(33.3);
    expect(sharePct(2, 3)).toBe(66.7);
  });
});

// ------------------------------------------------------------ range policy

describe('resolución del rango', () => {
  const now = new Date('2026-08-21T18:00:00.000Z'); // 13:00 in Bogota

  it('por defecto son los últimos 30 días, terminando HOY', () => {
    // Ending today and not yesterday: a merchant opening the tablero at
    // mid-morning wants this morning's sales in it.
    expect(resolveRange({}, now)).toEqual({ from: '2026-07-23', to: '2026-08-21', days: 30 });
  });

  it('usa el día colombiano para saber cuál es "hoy"', () => {
    // 00:30 on the 22nd in UTC is still the 21st for the merchant.
    expect(resolveRange({}, new Date('2026-08-22T00:30:00.000Z')).to).toBe('2026-08-21');
  });

  it('completa el extremo que falte', () => {
    expect(resolveRange({ from: '2026-08-19' }, now)).toEqual({ from: '2026-08-19', to: '2026-08-21', days: 3 });
    expect(resolveRange({ to: '2026-03-15' }, now)).toEqual({ from: '2026-02-14', to: '2026-03-15', days: 30 });
  });

  it('rechaza un rango más largo que el máximo, en vez de recortarlo en silencio', () => {
    const limit = { from: addBogotaDays('2026-08-21', -(DASHBOARD_MAX_RANGE_DAYS - 1)), to: '2026-08-21' };
    expect(resolveRange(limit, now).days).toBe(DASHBOARD_MAX_RANGE_DAYS);

    const tooLong = { from: addBogotaDays(limit.from, -1), to: '2026-08-21' };
    expect(() => resolveRange(tooLong, now)).toThrowError();
  });

  it('rechaza un "from" en el futuro cuando "to" lo pone el reloj', () => {
    expect(() => resolveRange({ from: '2027-01-01' }, now)).toThrowError();
  });

  it('el período anterior de un solo día ES ayer', () => {
    // This is what makes the design's "vs ayer" fall out of the general rule
    // instead of being a special case.
    expect(previousWindow({ from: '2026-08-21', to: '2026-08-21', days: 1 })).toEqual({
      from: '2026-08-20',
      to: '2026-08-20',
      days: 1,
    });
  });

  it('el período anterior es igual de largo, contiguo y sin solaparse', () => {
    const previous = previousWindow({ from: '2026-07-23', to: '2026-08-21', days: 30 });
    expect(previous).toEqual({ from: '2026-06-23', to: '2026-07-22', days: 30 });
    expect(addBogotaDays(previous.to, 1)).toBe('2026-07-23');
  });
});

describe('esquema de la consulta', () => {
  it('rechaza fechas que no existen en el calendario', () => {
    expect(dashboardQuerySchema.safeParse({ from: '2026-02-31' }).success).toBe(false);
    expect(dashboardQuerySchema.safeParse({ from: '2026-13-01' }).success).toBe(false);
    expect(dashboardQuerySchema.safeParse({ from: '21/08/2026' }).success).toBe(false);
    expect(dashboardQuerySchema.safeParse({ from: '2026-02-28' }).success).toBe(true);
  });

  it('rechaza un rango invertido', () => {
    expect(dashboardQuerySchema.safeParse({ from: '2026-08-16', to: '2026-08-10' }).success).toBe(false);
    expect(dashboardQuerySchema.safeParse({ from: '2026-08-10', to: '2026-08-16' }).success).toBe(true);
  });
});

// ---------------------------------------------------------------- endpoint

describe('GET /v1/admin/dashboard', () => {
  it('exige una sesión de comerciante', async () => {
    await request(app.getHttpServer()).get('/v1/admin/dashboard').expect(401);
  });

  it('devuelve 400 ante una fecha imposible o un rango excesivo', async () => {
    const server = app.getHttpServer();
    await request(server).get('/v1/admin/dashboard').query({ from: '2026-02-31' }).set('Cookie', shop.cookie).expect(400);
    await request(server)
      .get('/v1/admin/dashboard')
      .query({ from: '2026-01-01', to: '2026-08-01' })
      .set('Cookie', shop.cookie)
      .expect(400);
    await request(server)
      .get('/v1/admin/dashboard')
      .query({ from: TO, to: FROM })
      .set('Cookie', shop.cookie)
      .expect(400);
  });

  it('devuelve el rango que realmente usó, y el que comparó', async () => {
    const body = await getDashboard(shop);
    expect(body.range).toEqual({ from: FROM, to: TO, days: 7 });
    expect(body.previousRange).toEqual({ from: '2026-08-03', to: '2026-08-09', days: 7 });
    expect(body.timeZone).toBe('America/Bogota');
  });

  it('suma las ventas del período y las compara con el anterior, sin los pedidos cancelados', async () => {
    const body = await getDashboard(shop);
    // 100.000 + 50.000 + 60.000. The 999.999 cancelled order and the 777.000
    // one placed after the window are both absent.
    expect(body.kpis.salesCents).toEqual({ value: 210_000, previous: 40_000, changePct: 425 });
    expect(body.kpis.orders).toEqual({ value: 3, previous: 1, changePct: 200 });
  });

  it('agrupa la serie por días colombianos, rellenando los vacíos', async () => {
    const body = await getDashboard(shop);
    expect(body.series).toHaveLength(7);
    expect(body.series.map((point) => point.date)).toEqual(eachBogotaDay(FROM, TO));

    const byDate = new Map(body.series.map((point) => [point.date, point]));
    expect(byDate.get('2026-08-10')).toEqual({ date: '2026-08-10', salesCents: 100_000, orders: 1 });
    // Both the 23:00Z sale and the 04:59Z-next-day sale are the merchant's
    // Sunday the 16th.
    expect(byDate.get('2026-08-16')).toEqual({ date: '2026-08-16', salesCents: 110_000, orders: 2 });
    // The cancelled order landed here and left no trace.
    expect(byDate.get('2026-08-12')).toEqual({ date: '2026-08-12', salesCents: 0, orders: 0 });
  });

  it('ordena los más vendidos por unidades y no parte un producto renombrado', async () => {
    const body = await getDashboard(shop);
    expect(body.topProducts).toEqual([
      // First on units (5), even though it earned less than the vestido —
      // "más vendidos" is a question about what moves, not about revenue.
      { productId: productIds.camiseta, name: 'Camiseta', units: 5, salesCents: 100_000 },
      // One row, not two: same product id, and the newer snapshot names it.
      { productId: productIds.vestido, name: 'Vestido largo', units: 2, salesCents: 120_000 },
    ]);
  });

  it('reparte las ventas por canal, con las cuatro tajadas siempre presentes', async () => {
    const body = await getDashboard(shop);
    expect(body.salesByChannel).toEqual([
      { channel: 'web', orders: 1, salesCents: 100_000, sharePct: 33.3 },
      { channel: 'whatsapp', orders: 2, salesCents: 110_000, sharePct: 66.7 },
      // Zero, not missing: `instagram` has no inbound path in the code yet and
      // a permanent zero is the honest answer.
      { channel: 'instagram', orders: 0, salesCents: 0, sharePct: 0 },
      { channel: 'other', orders: 0, salesCents: 0, sharePct: 0 },
    ]);
  });

  it('cuenta el contra entrega como medio de pago propio', async () => {
    const body = await getDashboard(shop);
    expect(body.paymentMethods).toEqual([
      { method: 'wompi', orders: 2, salesCents: 160_000, sharePct: 66.7 },
      // `paymentProvider` is null for COD; reporting it as "sin método" would
      // erase most of a Colombian store's sales.
      { method: 'cod', orders: 1, salesCents: 50_000, sharePct: 33.3 },
    ]);
    // epayco appears nowhere: its only order was cancelled.
    expect(body.paymentMethods.map((slice) => slice.method)).not.toContain('epayco');
  });

  it('cuenta como atendida por una persona tanto la escalada como la ya resuelta', async () => {
    const body = await getDashboard(shop);
    expect(body.kpis.conversations).toEqual({ value: 5, previous: 2, changePct: 150 });
    expect(body.kpis.aiResolution).toEqual({
      // 5 conversations, 2 of which a person touched (one 'escalated', one
      // 'resolved'). Counting only 'escalated' would report 80%.
      ratePct: 60,
      previousRatePct: 50,
      changePoints: 10,
      conversations: 5,
      handedToHuman: 2,
    });
  });

  it('no deja ver los pedidos de otro comercio', async () => {
    const mine = await getDashboard(shop);
    expect(mine.kpis.salesCents.value).toBe(210_000);

    const hers = await getDashboard(neighbour);
    expect(hers.kpis.salesCents.value).toBe(500_000);
    expect(hers.kpis.orders.value).toBe(1);
    expect(hers.salesByChannel.find((slice) => slice.channel === 'other')?.orders).toBe(1);
    // A deleted-or-absent product id still shows the name it was sold under.
    expect(hers.topProducts).toEqual([
      { productId: null, name: 'Producto de la vecina', units: 1, salesCents: 500_000 },
    ]);
  });

  it('una tienda recién abierta recibe un tablero vacío, no uno inventado', async () => {
    const body = await getDashboard(emptyShop, {});

    // The default window, resolved against the server's own Colombian clock.
    expect(body.range.days).toBe(30);
    expect(body.range.to).toBe(bogotaDayOf(new Date()));
    expect(body.series).toHaveLength(30);
    expect(body.series.every((point) => point.salesCents === 0 && point.orders === 0)).toBe(true);

    for (const tile of [body.kpis.salesCents, body.kpis.orders, body.kpis.conversations]) {
      // Not +100%, not Infinity, not 0%.
      expect(tile).toEqual({ value: 0, previous: 0, changePct: null });
    }
    expect(body.kpis.aiResolution).toEqual({
      ratePct: null,
      previousRatePct: null,
      changePoints: null,
      conversations: 0,
      handedToHuman: 0,
    });

    expect(body.topProducts).toEqual([]);
    expect(body.paymentMethods).toEqual([]);
    // The ring keeps its four slices so it can render an empty state rather
    // than four confident zeroes.
    expect(body.salesByChannel).toHaveLength(4);
    expect(body.salesByChannel.every((slice) => slice.sharePct === null)).toBe(true);
  });
});
