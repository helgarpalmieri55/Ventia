import { HttpException, Injectable } from '@nestjs/common';
import { tenantDb, type OrderStatus, type PaymentStatus, type WebhookEventReviewAction } from '@ventia/db';
import { projectWebhookLinks } from './webhook-links';

/**
 * The one `WebhookEvent.result` value that means a human must intervene:
 * a fully signature-verified, amount-matching, currency-matching `PAID`
 * event arrived for an order that could no longer be settled — almost always
 * one `stock-reservation.worker.ts` had already cancelled because the payment
 * took longer than the 15-minute hold. The shopper's card was charged and
 * they have no order.
 *
 * Every other `result` this system writes is either a success (`confirmed`,
 * `failed`) or a rejection where NO money moved on our side
 * (`amount_mismatch`, `currency_mismatch`, `currency_unknown`,
 * `order_not_found`, `invalid_reference`, `noop_*`). Those are security /
 * plumbing telemetry for engineers, not merchant work — surfacing them here
 * would bury the one row that is actually a financial discrepancy. So this
 * list is deliberately exactly one string, and widening it should require the
 * same argument: "money moved and a merchant must act".
 *
 * Written by services/api/src/payments/webhooks.controller.ts (read-only
 * here — this module surfaces what that handler already records and never
 * writes to `WebhookEvent`).
 */
export const NEEDS_MERCHANT_ACTION_RESULT = 'paid_order_not_settleable';

/** The projection of the referenced order the merchant needs to act. */
export interface PaymentAlertOrder {
  id: string;
  number: number;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  createdAt: Date;
  /** The shopper to contact. Already visible to this merchant on the order
   * itself — this is their own customer, not third-party data. */
  email: string;
}

export interface PaymentAlertDTO {
  /** `WebhookEvent.id` — a stable React key / support reference. */
  id: string;
  /** `'wompi' | 'mercadopago' | 'epayco'` in practice, typed as a plain
   * string because `WebhookEvent.provider` is one and a future gateway must
   * still list rather than disappear. */
  provider: string;
  /** The GATEWAY's own event id. Load-bearing, not decoration: when the order
   * cannot be resolved this is the only thing the merchant can paste into
   * their gateway dashboard to find the charge. */
  eventId: string;
  /** When the charge was recorded as unsettleable. `processedAt` is stamped
   * by the handler at the moment it gave up; `createdAt` is the fallback for
   * the (unreachable for this result) unprocessed case. */
  occurredAt: Date;
  /** The number of a REAL order of this merchant's that the event resolved
   * to, or `null` when it resolved to none. Never the payload's unmatched
   * claim — that is `referencedOrderNumber`. */
  orderNumber: number | null;
  /** The order number the GATEWAY's payload named, whether or not it matched
   * anything. `null` when the payload carries no usable reference for this
   * provider (always the case for Mercado Pago) — see webhook-links.ts.
   *
   * Displayed only as the gateway's own reference, never as one of the
   * merchant's orders: an unmatched number is a true statement about what the
   * gateway was told, and a false one about this merchant's order book. */
  referencedOrderNumber: number | null;
  /**
   * The amount the shopper was charged, in cents — taken from the resolved
   * ORDER's `totalCents`, not from the payload.
   *
   * That is not a shortcut, it is the more truthful number. This event is
   * only ever recorded AFTER webhooks.controller.ts's unconditional amount
   * check (`event.amountCents === order.totalCents`) and currency check
   * (`event.currency === 'COP'`) have both passed, so the order total is
   * provably the amount the gateway reported — and it is the value the
   * handler actually verified, rather than a second, unverified re-read of
   * the same payload that could disagree with it. `null` when the order
   * could not be resolved: showing an unverified payload amount next to
   * "no pudimos identificar el pedido" would be worse than showing nothing.
   */
  amountCents: number | null;
  order: PaymentAlertOrder | null;
  /**
   * The CURRENT review for this alert, or `null` when it is still pending.
   *
   * Derived, never stored: it is the latest `WebhookEventReview` row for this
   * event, and it is `null` both when no review exists and when the latest
   * one is a `reopened` (an undo). See `WebhookEventReview` in schema.prisma.
   */
  review: PaymentAlertReview | null;
}

export interface PaymentAlertReview {
  action: WebhookEventReviewAction;
  note: string | null;
  /** WHO acted — a snapshot taken when they acted, not a live join. */
  reviewedByEmail: string;
  reviewedAt: Date;
}

/**
 * Which half of the page is being asked for.
 *
 * `pending` is the default and the only thing the shell banner counts: an
 * alert nobody has accounted for yet. `reviewed` is the "Revisados" section —
 * the same rows, still fully visible, just out of the alarm.
 *
 * Anything else falls back to `pending` rather than 400-ing, matching how
 * every other list query param in this codebase treats garbage input. Falling
 * back to `pending` specifically is the fail-loud direction: a typo shows the
 * merchant MORE alerts, never fewer.
 */
export type PaymentAlertStatusFilter = 'pending' | 'reviewed';

export interface PaymentAlertListQuery {
  page?: string;
  pageSize?: string;
  status?: string;
}

export interface PaymentAlertListResult {
  items: PaymentAlertDTO[];
  total: number;
  page: number;
  pageSize: number;
}

export interface PaymentAlertReviewResult {
  review: PaymentAlertReview;
  /** `true` when the action was `reopened`, i.e. the alert is back in the
   * banner count. Lets the admin app refresh the right section without
   * re-deriving the enum's meaning client-side. */
  pending: boolean;
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

/**
 * The one `providerRefSource` value this module will resolve an order
 * through. Mirrors `isGatewayVerifiedRef` in
 * services/api/src/payments/reconciliation.worker.ts, deliberately:
 * schema.prisma states that `'hint'` is written by the unauthenticated hint
 * endpoint and is "attacker-controlled by assumption", and that NULL is
 * "treated exactly like 'hint' (untrusted) by every consumer: fail closed,
 * never open". Comparing against this constant rather than `!== 'hint'` is
 * what makes NULL — and any future third value — fail closed by default.
 */
const VERIFIED_REF_SOURCE = 'verified';

/** The review actions that mean "handled". Everything except the undo. */
function isReviewedAction(action: WebhookEventReviewAction): boolean {
  return action !== 'reopened';
}

@Injectable()
export class PaymentAlertsService {
  /**
   * Lists this tenant's `paid_order_not_settleable` webhook events, newest
   * first, each joined to the order it referenced.
   *
   * ## Tenancy
   *
   * Runs entirely on `tenantDb(tenantId)`, never `platformDb`. Two
   * independent layers scope it:
   *
   *  1. `packages/db/src/tenant-client.ts` AND-scopes every `where` with
   *     `{ tenantId }`, because `WebhookEvent` is now listed in
   *     `TENANT_MODELS`.
   *  2. Postgres RLS (`tenant_isolation` on `"WebhookEvent"`, migration
   *     20260815120000) filters the same rows again inside the database,
   *     under the `ventia_app` role tenantDb switches to.
   *
   * The order lookups below go through the same client, so an event can only
   * ever be joined to an order of the SAME tenant — which matters concretely:
   * `Order.number` is per-tenant (`@@unique([tenantId, number])`), so a
   * cross-tenant read here would not merely leak a row, it would attach
   * another merchant's payment to this merchant's identically-numbered order.
   *
   * ## Query shape
   *
   * Two batched `findMany`s after the page is fetched — never one lookup per
   * row. The alert list is inherently tiny (this event requires a paid
   * webhook to land after an expiry), but a per-row join would still be N+1
   * against a table read on every admin page load via the shell banner.
   *
   * ## Pending vs reviewed
   *
   * `WebhookEventReview` has no Prisma relation to `WebhookEvent` (see that
   * model's comment), and `tenantDb` refuses raw queries, so "events without a
   * current review" cannot be one JOIN. Instead this reads the tenant's review
   * rows first, reduces them to the latest-per-event in memory, and filters
   * the page by `id: { in / notIn }`.
   *
   * That is bounded by the number of alerts this merchant has ever reviewed,
   * not by anything platform-wide, and every one of those rows had to be
   * created by a human clicking a button — so it is small by construction. If
   * a very high-volume PSE merchant ever makes it not small, the fix is to
   * materialize "latest review per event" (a partial index or a view), NOT to
   * add a mutable `reviewed` flag to `WebhookEvent`: the append-only property
   * is the point of the whole design.
   */
  async list(tenantId: string, query: PaymentAlertListQuery): Promise<PaymentAlertListResult> {
    const db = tenantDb(tenantId);

    // Identical clamping to OrdersService.list()/ProductsService.list(): page
    // < 1 clamps to 1, pageSize clamps into [1, MAX_PAGE_SIZE], and a
    // non-numeric value falls back to the default rather than 400-ing.
    const page = Math.max(1, Math.trunc(Number(query.page)) || 1);
    const rawPageSize = Math.trunc(Number(query.pageSize));
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, rawPageSize || DEFAULT_PAGE_SIZE));
    const status: PaymentAlertStatusFilter = query.status === 'reviewed' ? 'reviewed' : 'pending';

    const currentReviews = await this.currentReviews(tenantId);
    const reviewedIds = [...currentReviews.keys()];

    const where = {
      result: NEEDS_MERCHANT_ACTION_RESULT,
      id: status === 'reviewed' ? { in: reviewedIds } : { notIn: reviewedIds },
    } as const;

    const [events, total] = await Promise.all([
      db.webhookEvent.findMany({
        where,
        // `processedAt` is when the charge was found to be unapplicable, which
        // is the moment the merchant cares about.
        //
        // NEITHER `processedAt` NOR `createdAt` is unique — both are stamped
        // within the same request, so a burst can share a millisecond — so
        // `id` is the final, genuinely unique tiebreak. Without it Postgres
        // may order tied rows differently between the page-1 and page-2
        // queries, which silently shows one row twice and drops another
        // entirely. On a list of shoppers who were charged for nothing, a
        // dropped row is a customer nobody refunds.
        orderBy: [{ processedAt: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        // Explicit select, not the default "every column": `payload` is a raw
        // gateway body carrying shopper PII and signature material, and it
        // must never leave this service. Selecting fields explicitly means a
        // future column added to this model is opt-in rather than silently
        // published to the admin app.
        select: { id: true, provider: true, eventId: true, payload: true, processedAt: true, createdAt: true },
      }),
      db.webhookEvent.count({ where }),
    ]);

    // `payload` IS selected above — it is the only place the order link lives
    // (see webhook-links.ts) — but it is consumed here and never escapes into
    // a DTO. `projectWebhookLinks` returns two scalars and nothing else.
    const links = events.map((event) => ({ event, ...projectWebhookLinks(event.provider, event.payload) }));

    const numbers = [...new Set(links.map((l) => l.orderNumber).filter((n): n is number => n !== null))];
    const providerRefs = [...new Set(links.map((l) => l.providerRef).filter((r): r is string => r !== null))];

    const orderSelect = {
      id: true,
      number: true,
      status: true,
      paymentStatus: true,
      totalCents: true,
      createdAt: true,
      email: true,
      providerRef: true,
    } as const;

    const [byNumberRows, byRefRows] = await Promise.all([
      numbers.length > 0
        ? db.order.findMany({ where: { number: { in: numbers } }, select: orderSelect })
        : Promise.resolve([]),
      providerRefs.length > 0
        ? db.order.findMany({
            where: {
              providerRef: { in: providerRefs },
              // ONLY refs the gateway itself vouched for (P3 wave-3 FIX 4).
              //
              // `Order.providerRef` is written from three sources and
              // schema.prisma is explicit that one of them — the deliberately
              // unauthenticated provider-ref-hint endpoint — is
              // "attacker-controlled by assumption", and that a NULL source is
              // "treated exactly like 'hint' (untrusted) by every consumer:
              // fail closed, never open". `reconciliation.worker.ts` already
              // honours that gate before it will settle money; this list must
              // honour it before it shows money.
              //
              // What it protects, concretely: the resolved order's
              // `totalCents` is presented to the merchant as "Monto cobrado" —
              // the amount they are told a shopper was charged — and, since
              // the per-row guidance is derived from the resolved order's
              // OWN status, an attacker who could choose which order an alert
              // resolves to could also choose which instruction the merchant
              // reads. Planting a hint ref onto a DELIVERED/PAID order would
              // render "this customer was probably charged twice — refund the
              // duplicate" against a legitimate, single payment. That is a
              // money-losing instruction assembled from an untrusted link, so
              // an unverified ref must resolve to NOTHING rather than to
              // something with the amount merely suppressed.
              //
              // The cost is real and accepted: Mercado Pago is the only
              // provider resolved this way (its notification body carries no
              // order reference at all), and for MP alerts a ref is only
              // 'verified' when markPaid/markFailed already stamped it on an
              // earlier attempt for this same payment. Every other MP alert
              // now lists with a null order — which is honest, still carries
              // the gateway's own event id to search the dashboard with, and
              // is exactly what this page already renders for an unresolvable
              // event. The order-NUMBER path (Wompi/ePayco, the dominant
              // cases) never consults `providerRef` and is untouched.
              providerRefSource: VERIFIED_REF_SOURCE,
            },
            select: orderSelect,
          })
        : Promise.resolve([]),
    ]);

    // `Order.number` is unique per tenant, so this map is unambiguous.
    const byNumber = new Map(byNumberRows.map((o) => [o.number, o]));

    // `Order.providerRef` carries NO uniqueness constraint (three
    // independent sources write it — see the column's doc comment), so two
    // orders can legitimately share one. An ambiguous ref therefore resolves
    // to NOTHING rather than to an arbitrary winner: naming the wrong order
    // on an alert about money already taken is worse than naming none, and
    // the merchant still gets the gateway event id to look it up with.
    const byRef = new Map<string, (typeof byRefRows)[number] | 'ambiguous'>();
    for (const row of byRefRows) {
      const ref = row.providerRef;
      if (ref === null) continue;
      byRef.set(ref, byRef.has(ref) ? 'ambiguous' : row);
    }

    const items: PaymentAlertDTO[] = links.map(({ event, orderNumber, providerRef }) => {
      const resolvedByNumber = orderNumber !== null ? (byNumber.get(orderNumber) ?? null) : null;
      let resolvedByRef: (typeof byRefRows)[number] | null = null;
      if (resolvedByNumber === null && providerRef !== null) {
        const candidate = byRef.get(providerRef);
        resolvedByRef = candidate !== undefined && candidate !== 'ambiguous' ? candidate : null;
      }
      const order = resolvedByNumber ?? resolvedByRef;

      const review = currentReviews.get(event.id) ?? null;

      return {
        id: event.id,
        provider: event.provider,
        eventId: event.eventId,
        occurredAt: event.processedAt ?? event.createdAt,
        // ONLY a real, resolved order of this merchant's — never the payload's
        // unmatched claim. Previously this fell back to the claimed number,
        // which let one row say "VNT-88888" and "no pudimos identificar el
        // pedido" at the same time, i.e. show a merchant an order number that
        // is not one of their orders. The claim itself is still available, and
        // still useful, as `referencedOrderNumber` below — but under a name
        // that says where it came from.
        orderNumber: order?.number ?? null,
        // What the GATEWAY's payload named, resolved or not. Kept because it
        // is a genuine lead when the lookup fails (Wompi's `reference` is
        // signature-covered, so an unmatched one is still a true statement
        // about what the gateway was told), and kept SEPARATE because it is
        // the gateway's word rather than this merchant's order book.
        referencedOrderNumber: orderNumber,
        amountCents: order?.totalCents ?? null,
        order: order
          ? {
              id: order.id,
              number: order.number,
              status: order.status,
              paymentStatus: order.paymentStatus,
              createdAt: order.createdAt,
              email: order.email,
            }
          : null,
        review,
      };
    });

    return { items, total, page, pageSize };
  }

  /**
   * The CURRENT review of every alert this tenant has ever reviewed, keyed by
   * `WebhookEvent.id`. Events whose latest review is a `reopened` are absent
   * from the map entirely — they are pending again, exactly as if nobody had
   * ever touched them (except that the history says otherwise, permanently).
   *
   * "Current" is derived here rather than stored anywhere, which is what lets
   * `WebhookEventReview` stay strictly append-only: an undo is a new row, so
   * there is never a value to overwrite.
   */
  private async currentReviews(tenantId: string): Promise<Map<string, PaymentAlertReview>> {
    const rows = await tenantDb(tenantId).webhookEventReview.findMany({
      // Ascending, so a later row simply overwrites an earlier one in the map
      // below and the last write wins. `id` is the unique final tiebreak for
      // the same reason the list's ordering needs one: two reviews of one
      // alert can land in the same millisecond, and "which one is current"
      // must not depend on which way Postgres happened to sort a tie.
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        webhookEventId: true,
        action: true,
        note: true,
        reviewedByEmail: true,
        createdAt: true,
      },
    });

    const current = new Map<string, PaymentAlertReview>();
    for (const row of rows) {
      if (isReviewedAction(row.action)) {
        current.set(row.webhookEventId, {
          action: row.action,
          note: row.note,
          reviewedByEmail: row.reviewedByEmail,
          reviewedAt: row.createdAt,
        });
      } else {
        // A `reopened` row un-reviews the alert. The row it supersedes is NOT
        // deleted — nothing here ever deletes anything — it simply stops being
        // the current one.
        current.delete(row.webhookEventId);
      }
    }
    return current;
  }

  /**
   * Records what a merchant did about one alert, by APPENDING a
   * `WebhookEventReview` row. Never updates or deletes anything: `WebhookEvent`
   * stays the system's immutable record (tenants hold SELECT on it and nothing
   * else), and the review history is append-only at the database level too —
   * `ventia_app` has UPDATE/DELETE revoked on `WebhookEventReview` and its RLS
   * policies are SELECT/INSERT only (migration 20260815140000).
   *
   * This is the affordance the original build deliberately left out, and the
   * reasoning has genuinely changed on one half of it. "These events are rare"
   * turned out to be false: ePayco supports PSE, whose `Pendiente` ->
   * `Aceptada` progression is asynchronous by design (packages/payments/src/
   * epayco.ts), while the stock reservation TTL is 15 minutes — so a bank
   * transfer outrunning the hold is structurally expected, not a tail event. A
   * merchant with steady PSE volume therefore accumulates a permanently
   * growing list and a permanent banner, which trains exactly the
   * skip-that-region habit that would make a real alert invisible.
   *
   * The other half of the original reasoning still stands and is what shapes
   * this: nobody may make a financial discrepancy vanish without a trace. So
   * this is not a "dismiss". It records WHO acted and WHAT they did, the alert
   * moves to the page's "Revisados" section rather than disappearing, and the
   * row can never be edited or removed afterwards.
   *
   * 404s — never 403 — when the event is not this tenant's, is not an alert,
   * or does not exist: the lookup goes through `tenantDb`, so another tenant's
   * event is simply not visible, and telling a caller "that id exists but is
   * not yours" would itself be a cross-tenant disclosure.
   */
  async review(
    session: { tenantId: string; userId: string; email: string },
    webhookEventId: string,
    input: { action: WebhookEventReviewAction; note: string | null },
  ): Promise<PaymentAlertReviewResult> {
    const db = tenantDb(session.tenantId);

    // Scoped by tenantDb + RLS, AND restricted to the one result this surface
    // is about — a merchant must not be able to file a "review" against an
    // arbitrary webhook event (a `confirmed` settlement, say) just by knowing
    // its id.
    const event = await db.webhookEvent.findFirst({
      where: { id: webhookEventId, result: NEEDS_MERCHANT_ACTION_RESULT },
      select: { id: true },
    });
    if (!event) throw new HttpException({ error: 'NOT_FOUND' }, 404);

    const row = await db.webhookEventReview.create({
      data: {
        // Passed explicitly, matching staff.service.ts: tenantDb's guard
        // stamps this anyway (and throws CrossTenantError on a mismatch), but
        // stating it keeps the write's tenancy readable at the call site —
        // and the RLS `WITH CHECK` policy is a third, independent check.
        tenantId: session.tenantId,
        webhookEventId: event.id,
        action: input.action,
        note: input.note,
        // The actor, snapshotted. `User`/`Membership` have ALL PRIVILEGES
        // revoked from `ventia_app`, so this genuinely cannot be a join — and
        // an audit row should say who acted even after that person leaves the
        // store.
        reviewedByUserId: session.userId,
        reviewedByEmail: session.email,
      },
      select: { action: true, note: true, reviewedByEmail: true, createdAt: true },
    });

    return {
      review: {
        action: row.action,
        note: row.note,
        reviewedByEmail: row.reviewedByEmail,
        reviewedAt: row.createdAt,
      },
      // `reopened` is the one action that puts the alert BACK in the alarm.
      pending: !isReviewedAction(row.action),
    };
  }
}
