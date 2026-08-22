import { Inject, Injectable } from '@nestjs/common';
import { tenantDb, type OrderStatus, type Prisma } from '@ventia/db';
import {
  businessSummaryInput,
  ordersSnapshotInput,
  productPerformanceInput,
  type CommandToolName,
  type ProductPerformanceSort,
} from '@ventia/core';
import { DashboardService } from '../dashboard/dashboard.service';
import { addBogotaDays, startOfBogotaDay } from '../dashboard/bogota-day';
import { resolveRange } from '../dashboard/dashboard-range';

/**
 * Server-side execution of the MERCHANT assistant's tools
 * (docs/design-gap.md §7 item 6).
 *
 * ## The contract every executor here keeps
 *
 * Deliberately the same four rules as `agent/agent-tools.service.ts`, because
 * they are the rules that make a tool-using model safe rather than rules about
 * shoppers:
 *
 * 1. **Tenant-scoped, always.** Every read goes through `tenantDb(tenantId)`,
 *    where `tenantId` came from the ADMIN SESSION of the request that asked
 *    the question — never from anything the model produced. There is no tool
 *    input here that names a tenant, and there must never be one: this
 *    surface reports a store's takings, its costs and its margins, so a
 *    tenant argument the model could fill in is the one bug that turns an
 *    assistant into a competitor's data feed.
 * 2. **Input is parsed, not trusted.** Tool inputs are model-generated. Each
 *    executor runs its Zod schema (see `@ventia/core`'s
 *    agent-command-schemas.ts) and rejects rather than coercing — a date the
 *    model half-invented must fail loudly, not silently answer about a
 *    different month.
 * 3. **The result is the whole truth the model gets.** The merchant-facing
 *    rule is that every figure comes from a tool and nothing is estimated, and
 *    that rule is only as good as what these return. So each result carries
 *    real current values, and says `null` explicitly where a value is
 *    genuinely unknown (an unset `costCents`, most importantly) rather than
 *    omitting the field and leaving the model to fill the gap with something
 *    plausible.
 * 4. **No customer PII.** Nothing here returns an email, a phone, a name or an
 *    address. The merchant is entitled to that data and can read it on
 *    /pedidos and /clientes; it simply is not needed to answer "¿cuántos
 *    pedidos van hoy?", and shipping every customer's contact details through
 *    a model to answer a counting question widens the blast radius for
 *    nothing.
 *
 * ## Read-only, permanently
 *
 * Every method below is a query. There is no write path in this file and none
 * belongs here — see the header of `agent-command-schemas.ts` for why that is
 * a product decision rather than an unfinished one.
 *
 * ## Why the tablero is reused rather than re-aggregated
 *
 * `get_business_summary` calls the same {@link DashboardService} that serves
 * `GET /v1/admin/dashboard`, and the two order-window helpers below are the
 * dashboard's own. A second set of aggregations would drift — differently
 * bucketed days, a different opinion about cancelled orders — and the failure
 * that produces is the worst one this feature has: the assistant tells a
 * merchant one number, their own tablero shows another, and nothing in the
 * product says which is wrong.
 */

export interface CommandToolResult {
  /** Whether the tool did what was asked. Errors are RETURNED, not thrown: the
   * model is expected to tell the merchant it could not look something up, in
   * its own words, and a thrown exception would kill the whole turn instead. */
  ok: boolean;
  /** Present when `ok` is false — a short, model-facing reason. Never a stack
   * trace or a database message. */
  error?: string;
  data?: unknown;
}

/** Everything an executor may know about the question it is answering. One
 * field, and it is the one that must never come from the model. */
export interface CommandToolContext {
  tenantId: string;
}

function fail(error: string): CommandToolResult {
  return { ok: false, error };
}

/**
 * How many products one ranking pass may scan.
 *
 * The ranking needs the WHOLE catalogue, not a page of it: "which product
 * stopped moving" is only answerable by looking at the products that sold
 * nothing, and those are exactly the ones any sales-ordered query leaves out.
 * A store on the largest plan can still exceed this, so the result says
 * `catalog_truncated` when it does, and the prompt requires the model to pass
 * that caveat on. Reporting a partial ranking as a complete one is precisely
 * the invented-certainty failure this feature must not have.
 */
const PRODUCT_SCAN_LIMIT = 1000;

/** The four product columns a merchant question can be answered from, plus the
 * two that decide whether a stock number means anything. Narrow on purpose: a
 * column added to `Product` later (an internal note, a supplier) does not
 * become something the model can recite by accident. */
const PRODUCT_SELECT = {
  id: true,
  name: true,
  status: true,
  priceCents: true,
  costCents: true,
  stock: true,
  trackInventory: true,
} satisfies Prisma.ProductSelect;

type CatalogProduct = Prisma.ProductGetPayload<{ select: typeof PRODUCT_SELECT }>;

/** Units and pesos a product moved inside the window. */
interface SoldTally {
  units: number;
  revenueCents: number;
}

@Injectable()
export class AgentCommandToolsService {
  // Explicit @Inject: esbuild (vitest's TS transform) emits no
  // `design:paramtypes`, so Nest cannot resolve this by type alone.
  constructor(@Inject(DashboardService) private readonly dashboard: DashboardService) {}

  /**
   * Dispatch by name.
   *
   * `now` is injected so tests can pin "today" rather than race a Bogota
   * midnight, exactly as `DashboardService.summary` takes it. Production
   * callers omit it.
   */
  async execute(
    ctx: CommandToolContext,
    name: string,
    rawInput: unknown,
    now: Date = new Date(),
  ): Promise<CommandToolResult> {
    const { tenantId } = ctx;
    switch (name as CommandToolName) {
      case 'get_business_summary':
        return this.businessSummary(tenantId, rawInput, now);
      case 'get_product_performance':
        return this.productPerformance(tenantId, rawInput, now);
      case 'get_orders_snapshot':
        return this.ordersSnapshot(tenantId, rawInput, now);
      default:
        // An unknown name is an error RESULT rather than a throw: the model can
        // emit one, and one hallucinated tool name should cost the merchant a
        // round-trip, not the whole answer.
        return fail(`herramienta desconocida: ${String(name)}`);
    }
  }

  private async businessSummary(tenantId: string, rawInput: unknown, now: Date): Promise<CommandToolResult> {
    const parsed = businessSummaryInput.safeParse(rawInput);
    if (!parsed.success) return fail('parámetros inválidos para get_business_summary');

    // `summary` resolves and range-caps the window itself and throws a 400
    // HttpException when the model asks for something impossible (from after
    // to, a range longer than a quarter). Converted to an error RESULT here:
    // a 400 escaping this method would fail the merchant's whole question
    // because the model picked a bad pair of dates, when the right outcome is
    // for the model to be told and try again.
    try {
      const summary = await this.dashboard.summary(tenantId, parsed.data, now);
      return { ok: true, data: summary };
    } catch (err) {
      return fail(rangeErrorMessage(err));
    }
  }

  /**
   * The catalogue ranked by what moved, what did not, and what is running out.
   *
   * Each sort answers a different merchant question and filters accordingly —
   * see the per-sort notes in {@link rankProducts}. The window's sales are
   * counted with the tablero's own rule (not cancelled, bucketed by Colombian
   * civil day) so "vendiste 8 camisas" here and on the tablero's top-products
   * panel are the same eight.
   */
  private async productPerformance(tenantId: string, rawInput: unknown, now: Date): Promise<CommandToolResult> {
    const parsed = productPerformanceInput.safeParse(rawInput);
    if (!parsed.success) return fail('parámetros inválidos para get_product_performance');
    const input = parsed.data;

    let range;
    try {
      range = resolveRange({ from: input.from, to: input.to }, now);
    } catch (err) {
      return fail(rangeErrorMessage(err));
    }

    const db = tenantDb(tenantId);
    // Two independent reads in parallel. Each `tenantDb` call opens its own
    // short transaction, so they do not share one and cannot deadlock — and
    // NEITHER is wrapped in a `platformDb.$transaction`, which is the
    // combination that deadlocked this repo's pool once already.
    const [products, soldItems] = await Promise.all([
      db.product.findMany({
        select: PRODUCT_SELECT,
        // A stable, unbiased order, so a truncated scan is an arbitrary slice
        // rather than one skewed toward new or expensive products — and so two
        // identical questions rank identically.
        orderBy: { name: 'asc' },
        // One over the cap: the extra row is never returned, it only tells us
        // the catalogue is bigger than we looked at.
        take: PRODUCT_SCAN_LIMIT + 1,
      }),
      db.orderItem.findMany({
        where: { order: soldIn(range.from, range.to) },
        select: { productId: true, qty: true, priceCentsSnapshot: true },
      }),
    ]);

    const truncated = products.length > PRODUCT_SCAN_LIMIT;
    const scanned = truncated ? products.slice(0, PRODUCT_SCAN_LIMIT) : products;

    const sold = new Map<string, SoldTally>();
    for (const item of soldItems) {
      // A line whose product was deleted has a null `productId` and cannot be
      // attributed to anything in the catalogue. Dropped rather than bucketed
      // under a fake key: this tool ranks products that still exist.
      if (!item.productId) continue;
      const tally = sold.get(item.productId) ?? { units: 0, revenueCents: 0 };
      tally.units += item.qty;
      tally.revenueCents += item.priceCentsSnapshot * item.qty;
      sold.set(item.productId, tally);
    }

    const ranked = rankProducts(scanned, sold, input.sort).slice(0, input.limit);

    return {
      ok: true,
      data: {
        range,
        sort: input.sort,
        // Stated even when false, so the model never has to infer completeness
        // from the absence of a field.
        catalog_truncated: truncated,
        catalog_scanned: scanned.length,
        products: ranked.map((product) => {
          const tally = sold.get(product.id);
          return {
            product_id: product.id,
            name: product.name,
            status: product.status,
            price_cents: product.priceCents,
            /**
             * NULL when the merchant never entered a cost — which is common,
             * and is the single most important honest-unknown in this file.
             * A model handed a missing cost will happily produce a margin from
             * the price alone, and a merchant who prices against an invented
             * margin loses real money. The prompt forbids it; this field being
             * explicitly null rather than absent is what lets the model see
             * there is nothing to work with.
             */
            cost_cents: product.costCents,
            /** Meaningless for a product that does not track inventory — see
             * {@link rankProducts} — so it is reported alongside that flag
             * rather than on its own. */
            stock: product.stock,
            tracks_inventory: product.trackInventory,
            units_sold: tally?.units ?? 0,
            revenue_cents: tally?.revenueCents ?? 0,
          };
        }),
      },
    };
  }

  /**
   * Orders in the window, counted by state.
   *
   * The counts cover the whole window; only the `recent` sample is bounded.
   * That split matters: a merchant asking "¿cuántos pedidos van hoy?" wants a
   * complete count, and a tool that answered with the size of its own page
   * would under-report on exactly the busy day they are asking about.
   */
  private async ordersSnapshot(tenantId: string, rawInput: unknown, now: Date): Promise<CommandToolResult> {
    const parsed = ordersSnapshotInput.safeParse(rawInput);
    if (!parsed.success) return fail('parámetros inválidos para get_orders_snapshot');
    const input = parsed.data;

    let range;
    try {
      range = resolveRange({ from: input.from, to: input.to }, now);
    } catch (err) {
      return fail(rangeErrorMessage(err));
    }

    const db = tenantDb(tenantId);
    // Deliberately NOT filtered to non-cancelled: a breakdown by state whose
    // states exclude one of the states is not a breakdown. The headline total
    // below re-applies the tablero's rule so the two screens still agree.
    const inWindow: Prisma.OrderWhereInput = createdIn(range.from, range.to);

    const [byStatus, byPayment, recent] = await Promise.all([
      db.order.groupBy({ by: ['status'], where: inWindow, _count: { _all: true }, _sum: { totalCents: true } }),
      db.order.groupBy({ by: ['paymentStatus'], where: inWindow, _count: { _all: true } }),
      db.order.findMany({
        where: inWindow,
        // No email, phone, shippingAddress or customerId — see rule 4 in this
        // file's header. `number` is the merchant-facing identifier and is what
        // they will search for on /pedidos.
        select: {
          number: true,
          status: true,
          paymentStatus: true,
          totalCents: true,
          channel: true,
          source: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
        take: input.limit,
      }),
    ]);

    let ordersExcludingCancelled = 0;
    let salesCentsExcludingCancelled = 0;
    for (const row of byStatus) {
      if (row.status === 'CANCELLED') continue;
      ordersExcludingCancelled += row._count._all;
      salesCentsExcludingCancelled += row._sum.totalCents ?? 0;
    }

    return {
      ok: true,
      data: {
        range,
        /**
         * The tablero's rule (`status != CANCELLED`), restated here under a
         * name that says so.
         *
         * Without this, the by-status counts below would be the only total in
         * the result and the model would sum them — producing a number LARGER
         * than the merchant's own dashboard for any window containing a
         * cancellation, with nothing to explain the gap.
         */
        total_orders_excluding_cancelled: ordersExcludingCancelled,
        total_sales_cents_excluding_cancelled: salesCentsExcludingCancelled,
        by_status: countsByStatus(byStatus),
        by_payment_status: Object.fromEntries(byPayment.map((row) => [row.paymentStatus, row._count._all])),
        recent: recent.map((order) => ({
          // Rendered as VNT-#### everywhere the merchant looks; the prefix is
          // added by the UI, so the raw number is what belongs here.
          order_number: order.number,
          status: order.status,
          payment_status: order.paymentStatus,
          total_cents: order.totalCents,
          /** WHERE the shopper was. */
          channel: order.channel,
          /** WHO assembled the cart — `agent` is the AI-assisted sale the
           * merchant's plan is sold on. Two different facts, two columns; see
           * the schema's note on `SalesChannel`. */
          source: order.source,
          created_at: order.createdAt.toISOString(),
        })),
      },
    };
  }
}

/**
 * Ranks the scanned catalogue for one merchant question.
 *
 * Every sort uses a TOTAL ordering (the tiebreakers run down to the name), so
 * asking the same question twice does not reshuffle the list and make the
 * assistant look like it changed its mind.
 */
function rankProducts(
  products: CatalogProduct[],
  sold: Map<string, SoldTally>,
  sort: ProductPerformanceSort,
): CatalogProduct[] {
  const units = (product: CatalogProduct) => sold.get(product.id)?.units ?? 0;
  const revenue = (product: CatalogProduct) => sold.get(product.id)?.revenueCents ?? 0;

  if (sort === 'bestselling') {
    // Draft and archived products are included here: one that sold before
    // being archived is part of the window's history, and hiding it would make
    // the ranking disagree with the tablero's top-products panel.
    return [...products].sort(
      (a, b) => units(b) - units(a) || revenue(b) - revenue(a) || a.name.localeCompare(b.name, 'es'),
    );
  }

  if (sort === 'lowest_stock') {
    return (
      products
        // A product with `trackInventory: false` has no stock number worth
        // reporting — its `stock` column sits wherever it was last left. Listing
        // it as "0 unidades" would send a merchant to restock something that is
        // made to order, so it is excluded rather than ranked at the top.
        .filter((product) => product.trackInventory && product.status === 'active')
        .sort((a, b) => a.stock - b.stock || a.name.localeCompare(b.name, 'es'))
    );
  }

  // 'slowest' — "¿qué se está quedando quieto?"
  return (
    products
      // Only what is actually FOR SALE and actually IN STOCK. A draft product
      // selling nothing is not news, and neither is a sold-out one: the
      // question is about capital sitting on a shelf, so a product with no
      // stock left is the opposite of the answer.
      .filter((product) => product.status === 'active' && (!product.trackInventory || product.stock > 0))
      .sort(
        (a, b) =>
          units(a) - units(b) ||
          // Among equally unsold products, the one with the most stock is the
          // one costing the merchant the most to keep.
          b.stock - a.stock ||
          a.name.localeCompare(b.name, 'es'),
      )
  );
}

/** Every `OrderStatus`, always present, zero-filled.
 *
 * A `groupBy` returns only the states that occurred, so a quiet window would
 * otherwise hand the model a half-empty object and leave it to decide whether
 * a missing `SHIPPED` means zero or means unknown. Naming all six removes the
 * question. */
function countsByStatus(rows: Array<{ status: OrderStatus; _count: { _all: number } }>): Record<OrderStatus, number> {
  const counts: Record<OrderStatus, number> = {
    PENDING: 0,
    CONFIRMED: 0,
    PREPARING: 0,
    SHIPPED: 0,
    DELIVERED: 0,
    CANCELLED: 0,
  };
  for (const row of rows) counts[row.status] = row._count._all;
  return counts;
}

/** Orders that count toward a sales figure: the tablero's rule, imported by
 * copy of intent rather than of code because `dashboard.service.ts` keeps its
 * own `soldIn` private. The DAY BOUNDARIES come from the dashboard's own
 * helpers, which is the part that would actually drift. */
function soldIn(from: string, to: string): Prisma.OrderWhereInput {
  return { status: { not: 'CANCELLED' }, ...createdIn(from, to) };
}

/** The window's Colombian civil days, half-open on the upper bound so an order
 * created at exactly midnight lands in one day only. */
function createdIn(from: string, to: string): Prisma.OrderWhereInput {
  return { createdAt: { gte: startOfBogotaDay(from), lt: startOfBogotaDay(addBogotaDays(to, 1)) } };
}

/**
 * Turns a range rejection into something the MODEL can act on.
 *
 * `resolveRange` throws an `HttpException` whose body is the shape the admin UI
 * renders. Handing that JSON to the model teaches it nothing; a sentence about
 * what it did wrong lets it retry with a window that works. Anything that is
 * not a range complaint is re-thrown, because a database failure is not
 * something the model should paper over with a cheerful retry.
 */
function rangeErrorMessage(err: unknown): string {
  const response = (err as { getResponse?: () => unknown })?.getResponse?.();
  if (response && typeof response === 'object' && (response as { error?: unknown }).error === 'VALIDATION_FAILED') {
    const details = (response as { details?: Record<string, string> }).details ?? {};
    const reason = Object.values(details)[0] ?? 'rango inválido';
    return `rango inválido: ${reason}`;
  }
  throw err;
}
