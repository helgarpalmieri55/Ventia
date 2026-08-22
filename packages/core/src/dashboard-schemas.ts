import { z } from 'zod';

/**
 * Contract for `GET /v1/admin/dashboard` — the merchant's tablero
 * (docs/design-gap.md §5 and §7 item 4).
 *
 * Only the DERIVABLE half of that design lives here. The live-activity feed
 * needs a transport this repo does not have (there is no WebSocket or SSE
 * anywhere in it), and "Insights de tu IA", Analítica and Finanzas are
 * product surfaces nobody has specified yet — so this file deliberately has
 * no shape for any of them. An empty field is a promise; an absent one is
 * honest.
 *
 * The response types are exported alongside the request schema because three
 * parties have to agree on them: the service that builds the payload, the
 * admin page that renders it, and anyone reading this to find out what the
 * tablero can actually answer.
 */

/**
 * Colombia keeps `America/Bogota` = UTC-5 all year and has never observed DST,
 * so every civil-day boundary in this contract is a fixed offset rather than a
 * zone lookup. Exported so a caller can label an axis with the zone the
 * numbers are actually bucketed in — a merchant comparing this screen against
 * their own till needs to know whose midnight was used.
 */
export const DASHBOARD_TIME_ZONE = 'America/Bogota';

/** Days in the window when the caller asks for neither `from` nor `to`. Wide
 * enough that the sales chart has a shape and the previous-period comparison
 * is not one slow Tuesday, short enough to stay a cheap query. */
export const DASHBOARD_DEFAULT_RANGE_DAYS = 30;

/**
 * The longest window this endpoint will answer, in days (a quarter, inclusive).
 *
 * The cap is not arbitrary politeness: the service loads the window's orders
 * and their items and buckets them into Colombian civil days in JavaScript,
 * because `tenantDb` refuses raw SQL by design (see
 * `RawQueryOnTenantClientError`) and Prisma cannot `GROUP BY (createdAt AT
 * TIME ZONE 'America/Bogota')::date` through the typed API. That is a fine
 * trade for a quarter of one store's orders and a bad one for five years of
 * them. A longer horizon is the Analítica surface §5 leaves unbuilt, and it
 * will want a pre-aggregated table rather than a bigger `findMany`.
 */
export const DASHBOARD_MAX_RANGE_DAYS = 92;

/** A civil date in `America/Bogota`, `YYYY-MM-DD`.
 *
 * The `refine` rejects `2026-02-31` and `2026-13-01`, which the regex alone
 * happily accepts. Without it those round-trip through `Date` into a
 * neighbouring month and the endpoint would silently answer about a range
 * nobody asked for. */
export const dashboardDaySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'usa el formato AAAA-MM-DD')
  .refine((day) => {
    const [y, m, d] = day.split('-').map(Number);
    const probe = new Date(Date.UTC(y, m - 1, d));
    return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
  }, 'esa fecha no existe en el calendario');

/**
 * `GET /v1/admin/dashboard` query string.
 *
 * Both bounds are optional and INCLUSIVE, and both are civil dates rather
 * than instants: a merchant asking for "el 21 de agosto" means their whole
 * Tuesday, not 24 hours starting at some UTC midnight that is 7 p.m. Monday
 * for them.
 *
 * Defaulting happens in the service, not here, because it needs a clock and
 * this package stays pure — the same split `terms.template.ts` keeps. The
 * span limit is enforced there too, for the same reason: a caller who sends
 * `from` alone has a span that only a clock can measure.
 */
export const dashboardQuerySchema = z
  .object({
    from: dashboardDaySchema.optional(),
    to: dashboardDaySchema.optional(),
  })
  .refine((q) => !(q.from && q.to) || q.from <= q.to, {
    // ISO-8601 dates compare correctly as strings, which is most of why this
    // contract carries them as strings rather than as parsed Dates.
    message: 'from no puede ser posterior a to',
    path: ['from'],
  });

export type DashboardQuery = z.infer<typeof dashboardQuerySchema>;

/**
 * The `SalesChannel` enum from `packages/db/prisma/schema.prisma`, in the
 * order the tablero's ring renders it. Restated here rather than imported
 * because `@ventia/core` does not depend on `@ventia/db`; the API service
 * asserts at compile time that the two lists still agree, so drift breaks the
 * build instead of quietly dropping a slice.
 *
 * All four are always present in a response, including the ones with no
 * orders. A ring whose slices appear and disappear between refreshes is
 * unreadable, and "Instagram: 0" is a real answer — `instagram` has no
 * inbound path in the code yet, and a merchant seeing a permanent zero there
 * is seeing the truth.
 */
export const DASHBOARD_SALES_CHANNELS = ['web', 'whatsapp', 'instagram', 'other'] as const;
export type DashboardSalesChannel = (typeof DASHBOARD_SALES_CHANNELS)[number];

/** The sentinel this contract uses for `Order.paymentProvider === null`.
 *
 * Null on that column means contra entrega — checkout only writes a provider
 * id when the shopper picked an online gateway (checkout.service.ts). Passing
 * the null through as "sin método" would hide cash-on-delivery, which in
 * Colombia is frequently the majority of a small store's sales. */
export const DASHBOARD_COD_METHOD = 'cod';

/**
 * One KPI: the window's number, the previous equivalent window's number, and
 * the change between them.
 *
 * `changePct` is `null`, never `Infinity` and never `100`, when `previous` is
 * zero. There is no honest percentage change from nothing — a store's first
 * sale is not "+100%", it is its first sale — and a UI that receives `null`
 * can say "sin base de comparación" instead of drawing a green arrow that
 * means nothing. It is also `null` when the previous window falls entirely
 * before the store existed, which is the same case.
 */
export interface DashboardKpi {
  value: number;
  previous: number;
  /** Whole percent, rounded. Negative for a fall. Null when `previous` is 0. */
  changePct: number | null;
}

/**
 * The AI-resolution KPI, which is a RATE and so does not fit {@link DashboardKpi}.
 *
 * Two deliberate differences:
 *
 *  - The comparison is in percentage POINTS, not percent. "Resolution went
 *    from 40% to 50%" is +10 points; calling it "+25%" is a sentence nobody
 *    reads correctly on a dashboard tile.
 *  - `ratePct` is null, not 0, when the window held no conversations at all.
 *    A store nobody wrote to has not failed to resolve anything.
 *
 * `conversations` and `handedToHuman` ride along so the UI can show the raw
 * counts under the percentage. "89% resolved" over nine conversations is a
 * very different claim from the same figure over nine hundred, and rounding
 * hides which one the merchant is looking at.
 */
export interface DashboardAiResolution {
  ratePct: number | null;
  previousRatePct: number | null;
  changePoints: number | null;
  conversations: number;
  handedToHuman: number;
}

/** One day of the sales chart, in `America/Bogota` civil days. Every day in
 * the requested range is present, including the ones with no sales — a chart
 * that skips empty days draws a busy week and a dead week identically. */
export interface DashboardSeriesPoint {
  /** `YYYY-MM-DD`. */
  date: string;
  salesCents: number;
  orders: number;
}

/** A row of "productos más vendidos", ranked by units sold. */
export interface DashboardTopProduct {
  /** Null when the product row was deleted after the sale; the name survives
   * because `OrderItem` snapshots it. */
  productId: string | null;
  /** The name AS SOLD (`OrderItem.nameSnapshot`), taken from the most recent
   * sale in the window. A product renamed mid-window shows its current name
   * and still counts every unit, because rows are grouped by product id. */
  name: string;
  units: number;
  salesCents: number;
}

/** One slice of a share-of-total ring. `sharePct` is null — not 0 — when the
 * window has no orders at all, so an empty store gets an empty state instead
 * of four slices each confidently reporting 0%. */
export interface DashboardShare {
  orders: number;
  salesCents: number;
  sharePct: number | null;
}

export interface DashboardChannelSlice extends DashboardShare {
  channel: DashboardSalesChannel;
}

export interface DashboardPaymentMethodSlice extends DashboardShare {
  /** A `PaymentProviderId` (`wompi` / `mercadopago` / `epayco`), or
   * {@link DASHBOARD_COD_METHOD}. Unrecognised values are passed through
   * rather than bucketed into "otros": the column is a plain string, and a
   * value nobody expected is something the merchant should see, not something
   * this endpoint should hide. */
  method: string;
}

/** The inclusive civil-day bounds of a window, echoed back so the UI labels
 * its axis and its "vs" caption with the range the server actually used —
 * never with one it recomputed from its own clock. */
export interface DashboardRange {
  from: string;
  to: string;
  days: number;
}

export interface DashboardResponse {
  range: DashboardRange;
  /** The window the KPIs compare against: the same number of days,
   * immediately before `range`. See the service for why. */
  previousRange: DashboardRange;
  timeZone: typeof DASHBOARD_TIME_ZONE;
  kpis: {
    salesCents: DashboardKpi;
    orders: DashboardKpi;
    conversations: DashboardKpi;
    aiResolution: DashboardAiResolution;
  };
  series: DashboardSeriesPoint[];
  topProducts: DashboardTopProduct[];
  salesByChannel: DashboardChannelSlice[];
  paymentMethods: DashboardPaymentMethodSlice[];
}
