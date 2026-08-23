import { Injectable } from '@nestjs/common';
import { tenantDb, type Prisma, type SalesChannel } from '@ventia/db';
import {
  DASHBOARD_COD_METHOD,
  DASHBOARD_SALES_CHANNELS,
  DASHBOARD_TIME_ZONE,
  type DashboardChannelSlice,
  type DashboardPaymentMethodSlice,
  type DashboardQuery,
  type DashboardRange,
  type DashboardResponse,
  type DashboardSalesChannel,
  type DashboardSeriesPoint,
  type DashboardTopProduct,
} from '@ventia/core';
import { addBogotaDays, bogotaDayOf, eachBogotaDay, startOfBogotaDay } from './bogota-day';
import { previousWindow, resolveRange } from './dashboard-range';
import { aiResolution, kpi, sharePct } from './kpi-math';

/**
 * The merchant's tablero: `GET /v1/admin/dashboard` (docs/design-gap.md §5,
 * §7 item 4).
 *
 * Everything here is DERIVED from rows that already exist — `Order`,
 * `OrderItem`, `Conversation`. No new column, no new table, no new write path.
 * What the design asks for and this cannot derive is left out rather than
 * approximated: the live-activity feed (there is no realtime transport in this
 * repo at all), "Insights de tu IA", and the Analítica/Finanzas sections.
 *
 * ## Which orders count
 *
 * `status != CANCELLED`, and nothing else — deliberately the SAME rule as
 * `PlatformService.gmvByTenant`. That is not a coincidence to be maintained by
 * memory: a Ventia operator looking at a merchant's GMV and the merchant
 * looking at their own "ventas" tile must see the same number, because the
 * first conversation that starts with "your dashboard says X but you invoiced
 * me for Y" is one nobody can win. Both include PENDING orders whose online
 * payment has not settled, which slightly overstates cash in hand; the fix, if
 * it is ever wanted, belongs in ONE place that both callers read, not in a
 * divergence introduced here.
 *
 * Cancelled orders are excluded from every panel, not just the sales tile —
 * top products, channels and payment methods all read the same filtered set,
 * so the ring slices always add up to the tile above them.
 *
 * ## Why the window's orders are loaded rather than aggregated in SQL
 *
 * The series has to be bucketed by Colombian civil day (see bogota-day.ts),
 * which needs `date_trunc('day', "createdAt" AT TIME ZONE 'America/Bogota')` —
 * expressible only in raw SQL, and `tenantDb` refuses raw SQL by design so
 * that no query can escape tenant scoping (`RawQueryOnTenantClientError`).
 * Reaching for `platformDb` to get raw SQL would mean hand-writing the tenant
 * predicate that RLS otherwise guarantees, on the read path of the busiest
 * screen in the product. Loading a bounded window (`DASHBOARD_MAX_RANGE_DAYS`)
 * of four columns and bucketing in JavaScript is the cheaper mistake, and it
 * has the side benefit that every panel is computed from one identical set of
 * orders in a single pass.
 *
 * NOTE for whoever grows this: do not wrap these reads in a
 * `platformDb.$transaction` with `tenantDb` calls inside it. That combination
 * deadlocks the connection pool under load — the outer transaction holds a
 * connection while each inner `tenantDb` call waits for one of its own.
 */

/** Rows in "productos más vendidos". The design shows a short list beside
 * two charts; a longer one would just push the charts off the fold. */
const TOP_PRODUCTS = 5;

/**
 * The `Conversation.status` values that mean A PERSON GOT INVOLVED.
 *
 * There is no escalation event log — `Conversation.status` is a single mutable
 * column, written in exactly three places: `escalate_to_human`
 * (agent-tools.service.ts) sets `'escalated'`, the merchant clicking
 * "resolver" (conversations.controller.ts) sets `'resolved'`, y contestar desde
 * el panel (`POST :id/reply`) deja `'human'`. So a conversation the agent
 * handed over and the merchant then answered ends up `'resolved'`, and counting
 * only `'escalated'` as a handover would quietly re-credit every handled
 * escalation to the AI — the rate would climb every time the merchant did the
 * agent's work for it. Los tres estados cuentan como tocados por una persona.
 *
 * `'human'` es el más literal de los tres: significa que el comerciante ESTÁ
 * escribiendo en esa conversación ahora mismo y que el agente está callado.
 * Dejarlo fuera le acreditaría a la IA justo las conversaciones que atendió
 * alguien a mano.
 *
 * Anything else (today: `'open'`, the value every conversation starts at)
 * counts as handled by the agent alone. Two consequences worth stating:
 *
 *  - The rate is PROVISIONAL for recent windows. An open conversation can
 *    still escalate tomorrow, so today's figure can only fall, never rise.
 *    That is a property of the data, not a bug to paper over with a
 *    "conversations older than N hours" cutoff nobody could explain.
 *  - A NEW status added to the product must be classified here. Add it to this
 *    set if it means a person stepped in.
 */
const HUMAN_TOUCHED_STATUSES: ReadonlySet<string> = new Set(['escalated', 'resolved', 'human']);

/** The channel list, checked against Prisma's own enum. If a member is added
 * to `SalesChannel` and not to `DASHBOARD_SALES_CHANNELS`, this line still
 * compiles but the `Record` in `emptyChannelTallies` below stops accepting
 * `order.channel` — which is the error that catches the drift. */
const CHANNELS: readonly SalesChannel[] = DASHBOARD_SALES_CHANNELS;

/** What one pass over the window accumulates per group. */
interface Tally {
  orders: number;
  salesCents: number;
}

/** Products are tallied by UNITS as well as pesos, and never by order count —
 * "in how many orders did this appear" is not a question the tablero asks. */
interface ProductTally {
  productId: string | null;
  name: string;
  units: number;
  salesCents: number;
}

/** The four columns of an order the tablero reads, plus its lines. */
const ORDER_SELECT = {
  createdAt: true,
  totalCents: true,
  channel: true,
  paymentProvider: true,
  items: { select: { productId: true, nameSnapshot: true, priceCentsSnapshot: true, qty: true } },
} satisfies Prisma.OrderSelect;

type WindowOrder = Prisma.OrderGetPayload<{ select: typeof ORDER_SELECT }>;

@Injectable()
export class DashboardService {
  /**
   * @param now injected so tests can pin "today" instead of racing the clock
   *   at a Bogota midnight. Production callers omit it.
   */
  async summary(tenantId: string, query: DashboardQuery, now: Date = new Date()): Promise<DashboardResponse> {
    const range = resolveRange(query, now);
    const previousRange = previousWindow(range);
    const db = tenantDb(tenantId);

    // Four independent reads, in parallel. Each `tenantDb` call opens its own
    // short transaction (see tenant-client.ts), so these do not share one and
    // cannot deadlock each other.
    const [orders, previousOrders, conversations, previousConversations] = await Promise.all([
      // Ordered oldest-first, and that is load-bearing rather than tidy:
      // `buildTopProducts` lets the LATEST `nameSnapshot` win for a product,
      // which is only a defined answer if the rows arrive in a defined order.
      db.order.findMany({ where: soldIn(range), select: ORDER_SELECT, orderBy: { createdAt: 'asc' } }),
      db.order.aggregate({ where: soldIn(previousRange), _sum: { totalCents: true }, _count: { _all: true } }),
      db.conversation.groupBy({ by: ['status'], where: startedIn(range), _count: { _all: true } }),
      db.conversation.groupBy({ by: ['status'], where: startedIn(previousRange), _count: { _all: true } }),
    ]);

    const salesCents = orders.reduce((sum, order) => sum + order.totalCents, 0);
    const current = countConversations(conversations);
    const previous = countConversations(previousConversations);

    return {
      range,
      previousRange,
      timeZone: DASHBOARD_TIME_ZONE,
      kpis: {
        salesCents: kpi(salesCents, previousOrders._sum.totalCents ?? 0),
        orders: kpi(orders.length, previousOrders._count._all),
        conversations: kpi(current.conversations, previous.conversations),
        aiResolution: aiResolution(current, previous),
      },
      series: buildSeries(orders, range),
      topProducts: buildTopProducts(orders),
      salesByChannel: buildChannels(orders),
      paymentMethods: buildPaymentMethods(orders),
    };
  }
}

/** Orders that count toward every panel: not cancelled, created inside the
 * window's Bogota civil days. Half-open on the upper bound so an order created
 * at exactly midnight lands in one day only. */
function soldIn(range: DashboardRange): Prisma.OrderWhereInput {
  return {
    status: { not: 'CANCELLED' },
    createdAt: { gte: startOfBogotaDay(range.from), lt: startOfBogotaDay(addBogotaDays(range.to, 1)) },
  };
}

/** Conversations are dated by `startedAt` — the column the model has. A
 * conversation that began in the window and is still going counts here, which
 * matches how a merchant thinks about "conversaciones de esta semana". */
function startedIn(range: DashboardRange): Prisma.ConversationWhereInput {
  return {
    startedAt: { gte: startOfBogotaDay(range.from), lt: startOfBogotaDay(addBogotaDays(range.to, 1)) },
  };
}

function countConversations(rows: Array<{ status: string; _count: { _all: number } }>) {
  let conversations = 0;
  let handedToHuman = 0;
  for (const row of rows) {
    conversations += row._count._all;
    if (HUMAN_TOUCHED_STATUSES.has(row.status)) handedToHuman += row._count._all;
  }
  return { conversations, handedToHuman };
}

/** Zero-filled, one point per civil day in the range. See
 * {@link eachBogotaDay} for why the empty days are emitted. */
function buildSeries(orders: WindowOrder[], range: DashboardRange): DashboardSeriesPoint[] {
  const byDay = new Map<string, Tally>();
  for (const day of eachBogotaDay(range.from, range.to)) byDay.set(day, { orders: 0, salesCents: 0 });

  for (const order of orders) {
    // Always present: `soldIn` bounded the query to exactly these days.
    const tally = byDay.get(bogotaDayOf(order.createdAt));
    if (!tally) continue;
    tally.orders += 1;
    tally.salesCents += order.totalCents;
  }

  return [...byDay.entries()].map(([date, tally]) => ({ date, ...tally }));
}

/**
 * Ranked by UNITS, not revenue: "más vendidos" is a question about what moves
 * off the shelf, and ranking by revenue answers a different one (the single
 * expensive item beats the everyday one the store actually runs on). Revenue
 * rides along so the merchant can see both.
 *
 * `salesCents` here is line revenue (`priceCentsSnapshot * qty`), so these
 * figures deliberately do NOT sum to the sales tile: that one includes
 * shipping, which belongs to no product. Prices are IVA-incluido throughout
 * this codebase (docs/SPEC.md §5), so this is gross, like every other peso
 * figure on the screen.
 *
 * Grouped by `productId` so a product renamed mid-window stays one row; items
 * whose product was deleted (`productId` null) group by their snapshot name
 * instead, which keeps them visible rather than collapsing every deleted
 * product into one meaningless "null" row.
 */
function buildTopProducts(orders: WindowOrder[]): DashboardTopProduct[] {
  const byProduct = new Map<string, ProductTally>();

  for (const order of orders) {
    for (const item of order.items) {
      const key = item.productId ?? `name:${item.nameSnapshot}`;
      const tally = byProduct.get(key) ?? {
        productId: item.productId,
        name: item.nameSnapshot,
        units: 0,
        salesCents: 0,
      };
      // Latest snapshot wins, so a renamed product shows the name it has now
      // rather than whichever sale happened to be read first.
      tally.name = item.nameSnapshot;
      tally.units += item.qty;
      tally.salesCents += item.priceCentsSnapshot * item.qty;
      byProduct.set(key, tally);
    }
  }

  return [...byProduct.values()]
    // Units first, then revenue, then name — a total order, so two products
    // that sold the same number of units do not swap places between refreshes.
    .sort((a, b) => b.units - a.units || b.salesCents - a.salesCents || a.name.localeCompare(b.name, 'es'))
    .slice(0, TOP_PRODUCTS)
    .map(({ productId, name, units, salesCents }) => ({ productId, name, units, salesCents }));
}

function buildChannels(orders: WindowOrder[]): DashboardChannelSlice[] {
  const tallies = emptyChannelTallies();
  let total = 0;
  for (const order of orders) {
    // `channel` is WHERE the shopper was. Not `source`, which is WHO built the
    // cart ('agent' = the AI assembled it) and answers the AI-assisted-sales
    // question instead. An order the agent closed over WhatsApp is both at
    // once, and using either column for the other's chart loses one of the two
    // facts the schema was split to keep.
    tallies[order.channel].orders += 1;
    tallies[order.channel].salesCents += order.totalCents;
    total += 1;
  }
  return CHANNELS.map((channel) => ({ channel, ...tallies[channel], sharePct: sharePct(tallies[channel].orders, total) }));
}

function emptyChannelTallies(): Record<DashboardSalesChannel, Tally> {
  return {
    web: { orders: 0, salesCents: 0 },
    whatsapp: { orders: 0, salesCents: 0 },
    instagram: { orders: 0, salesCents: 0 },
    other: { orders: 0, salesCents: 0 },
  };
}

/**
 * Share by payment method, ordered by order count (busiest first) so the
 * merchant's actual mix leads.
 *
 * Unlike channels, this list is NOT fixed: `Order.paymentProvider` is a plain
 * nullable string, the set of connected gateways differs per store, and
 * rendering "ePayco: 0" to a merchant who has never connected ePayco is noise.
 * Only methods with at least one order in the window appear.
 */
function buildPaymentMethods(orders: WindowOrder[]): DashboardPaymentMethodSlice[] {
  const byMethod = new Map<string, Tally>();
  for (const order of orders) {
    // Null means contra entrega — checkout writes a provider id only for an
    // online gateway. Reporting it as "sin método" would erase what is often
    // most of a Colombian store's sales.
    const method = order.paymentProvider ?? DASHBOARD_COD_METHOD;
    const tally = byMethod.get(method) ?? { orders: 0, salesCents: 0 };
    tally.orders += 1;
    tally.salesCents += order.totalCents;
    byMethod.set(method, tally);
  }

  return [...byMethod.entries()]
    // Count, then revenue, then name: a total order, so the list does not
    // reshuffle between two refreshes that read the same data.
    .sort(([aMethod, a], [bMethod, b]) => b.orders - a.orders || b.salesCents - a.salesCents || aMethod.localeCompare(bMethod))
    .map(([method, tally]) => ({ method, ...tally, sharePct: sharePct(tally.orders, orders.length) }));
}
