import { HttpException, Injectable } from '@nestjs/common';
import { tenantDb, type OrderStatus, type PaymentStatus, type WebhookEventReviewAction } from '@ventia/db';

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
   * to, or `null` when it resolved to none. */
  orderNumber: number | null;
  /**
   * The amount the shopper was charged, in cents — taken from the resolved
   * ORDER's `totalCents`, not from the payload. `null` for a legacy row
   * written before `WebhookEvent.orderId` existed, which resolves to no order.
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
   * One batched `findMany` by primary key after the page is fetched — never
   * one lookup per row. The alert list is inherently tiny (this event requires
   * a paid webhook to land after an expiry), but a per-row join would still be
   * N+1 against a table read on every admin page load via the shell banner.
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
        //
        // `payload` is no longer selected at all. It used to be read here to
        // re-derive the order link; `orderId` now carries that link directly,
        // so the raw gateway body never enters this process's memory on this
        // path — the strongest possible version of "it must never leave this
        // service".
        select: { id: true, provider: true, eventId: true, orderId: true, processedAt: true, createdAt: true },
      }),
      db.webhookEvent.count({ where }),
    ]);

    // One batched lookup by primary key, replacing the previous pair of
    // lookups (by `Order.number` re-parsed from the payload, then by
    // `Order.providerRef` as a fallback).
    //
    // Everything that made those two lookups delicate is gone with them:
    //
    //  - There is no ambiguity to resolve. `providerRef` carries no uniqueness
    //    constraint, so the old ref path had to detect two orders sharing one
    //    ref and deliberately resolve to NOTHING. `id` is the primary key.
    //  - There is no trust gate to apply. The old ref path had to require
    //    `providerRefSource = 'verified'`, because `providerRef` is written by
    //    an unauthenticated hint endpoint that schema.prisma calls
    //    "attacker-controlled by assumption" — and since the per-row guidance
    //    is derived from the resolved order's own status, whoever controlled
    //    the link controlled the instruction the merchant read. `orderId` is
    //    written only by the webhook handler, from its own authenticated
    //    lookup, so there is no untrusted writer to gate against.
    //  - Mercado Pago is no longer a partial case. Its notification body
    //    carries no order reference, so it could only ever be resolved through
    //    that gated ref path, and most MP alerts consequently showed no order
    //    at all. The handler knew the order the whole time; now it says so.
    //
    // Still tenant-scoped twice over (tenantDb's AND-scoping plus RLS), so an
    // `orderId` that somehow named another tenant's order would resolve to
    // nothing rather than across the boundary.
    const orderIds = [...new Set(events.map((e) => e.orderId).filter((id): id is string => id !== null))];

    const orderRows =
      orderIds.length > 0
        ? await db.order.findMany({
            where: { id: { in: orderIds } },
            select: {
              id: true,
              number: true,
              status: true,
              paymentStatus: true,
              totalCents: true,
              createdAt: true,
              email: true,
            },
          })
        : [];

    const byId = new Map(orderRows.map((o) => [o.id, o]));

    const items: PaymentAlertDTO[] = events.map((event) => {
      // `null` for a row written before this column existed, and for the
      // (unreachable for this result) case where the named order has since
      // been deleted. Both render as "no pudimos identificar el pedido".
      const order = event.orderId !== null ? (byId.get(event.orderId) ?? null) : null;

      const review = currentReviews.get(event.id) ?? null;

      return {
        id: event.id,
        provider: event.provider,
        eventId: event.eventId,
        occurredAt: event.processedAt ?? event.createdAt,
        // ONLY a real, resolved order of this merchant's.
        orderNumber: order?.number ?? null,
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
