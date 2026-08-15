import { Injectable } from '@nestjs/common';
import { tenantDb, type OrderStatus, type PaymentStatus } from '@ventia/db';
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
  /** `null` when the payload carries no usable link for this provider AND no
   * order matches its gateway ref — see webhook-links.ts. */
  orderNumber: number | null;
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
}

export interface PaymentAlertListQuery {
  page?: string;
  pageSize?: string;
}

export interface PaymentAlertListResult {
  items: PaymentAlertDTO[];
  total: number;
  page: number;
  pageSize: number;
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

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
   */
  async list(tenantId: string, query: PaymentAlertListQuery): Promise<PaymentAlertListResult> {
    const db = tenantDb(tenantId);

    // Identical clamping to OrdersService.list()/ProductsService.list(): page
    // < 1 clamps to 1, pageSize clamps into [1, MAX_PAGE_SIZE], and a
    // non-numeric value falls back to the default rather than 400-ing.
    const page = Math.max(1, Math.trunc(Number(query.page)) || 1);
    const rawPageSize = Math.trunc(Number(query.pageSize));
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, rawPageSize || DEFAULT_PAGE_SIZE));

    const where = { result: NEEDS_MERCHANT_ACTION_RESULT } as const;

    const [events, total] = await Promise.all([
      db.webhookEvent.findMany({
        where,
        // `processedAt` is when the charge was found to be unapplicable, which
        // is the moment the merchant cares about; `createdAt` breaks ties
        // deterministically (both are stamped within the same request, so
        // several events can share a millisecond in tests and in bursts).
        orderBy: [{ processedAt: 'desc' }, { createdAt: 'desc' }],
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
        ? db.order.findMany({ where: { providerRef: { in: providerRefs } }, select: orderSelect })
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

      return {
        id: event.id,
        provider: event.provider,
        eventId: event.eventId,
        occurredAt: event.processedAt ?? event.createdAt,
        orderNumber: order?.number ?? orderNumber,
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
      };
    });

    return { items, total, page, pageSize };
  }
}
