import { Prisma, platformDb } from '@ventia/db';
import type { NormalizedStatus, PaymentProviderId } from '@ventia/payments';

/**
 * The single writer of the `Payment` ledger — the append-only, per-ATTEMPT
 * record of what a payment gateway said about money for one order (see the
 * model's doc comment in packages/db/prisma/schema.prisma for why it exists
 * given `Order` already carries payment state, and migration
 * 20260819120000_payment_ledger for why it is append-only).
 *
 * ## The two rules this module exists to keep
 *
 * **1. BOTH settle paths write it.** `webhooks.controller.ts` and
 * `reconciliation.worker.ts` are the only two things in this system that ever
 * learn what a gateway decided about a payment, and they learn it by
 * completely different means (a signed push vs. an authenticated pull). A
 * ledger only one of them wrote would be worse than no ledger at all: it would
 * be silently incomplete while looking authoritative, and the missing rows
 * would be exactly the ones from whichever path recovered a payment the other
 * path lost — i.e. the interesting ones. Hence one shared function rather than
 * two inline `platformDb.payment.create` calls that can drift.
 *
 * **2. It records what the gateway SAID, never what this system DID.**
 * `Order.paymentStatus` remains the single authority on an order's current
 * state, and nothing may read this table to decide that state. Two concrete
 * consequences, both deliberate:
 *
 *  - Callers write the ledger row BEFORE attempting the settle, not after. The
 *    gateway's statement is a fact the moment it is verified; whether
 *    `markPaid`/`markFailed` then transitions the order depends on their own
 *    preconditions and is a different question, recorded elsewhere (the
 *    `WebhookEvent.result` string, the `OrderEvent` rows). So a `PAID` row can
 *    legitimately sit next to an order that was never settled — that pairing
 *    is the truth, and it is precisely the `paid_order_not_settleable` case a
 *    human needs to see.
 *  - Ordering it before the settle is also the fail-safe direction. On the
 *    webhook path a throw here happens with the order untouched and the
 *    `WebhookEvent` row still unstamped, so the gateway's retry reprocesses
 *    the delivery cleanly (fix 5). Writing AFTER the settle would mean a
 *    failed insert 500s a request whose order was already settled, and the
 *    retry would then find `markPaid` no-op and record a FALSE
 *    `paid_order_not_settleable` alarm.
 */
export interface PaymentAttempt {
  tenantId: string;
  orderId: string;
  provider: PaymentProviderId;
  /** The gateway's own transaction id — the identity of this ATTEMPT, and part
   * of the ledger's dedupe key. Non-optional here even though the column is
   * nullable: both settle paths have one in hand before they reach this
   * function, and a row without one gets no dedupe protection at all (Postgres
   * treats NULLs as distinct in a unique index). Requiring it in the type is
   * what keeps that hole closed for today's writers. */
  providerRef: string;
  /** What the GATEWAY said moved, in minor units — never `Order.totalCents`.
   * Both callers have already proven the two are equal before they get here
   * (the webhook amount check; `checkOrderBinding` on the reconciliation
   * path), so passing the order total instead would look identical today and
   * would silently start lying the first time a gateway reports a partial
   * amount. */
  amountCents: number;
  status: NormalizedStatus;
  /** The evidence, and how it was obtained. See the `raw` field's doc comment
   * in schema.prisma: the webhook path stores a POINTER to the `WebhookEvent`
   * row that already holds the verified payload, while the reconciliation path
   * stores the normalized lookup result itself, because that path produces no
   * `WebhookEvent` row and this is the only place its answer is persisted. */
  raw: Prisma.InputJsonValue;
}

/**
 * Appends one row to the ledger, or does nothing if this exact gateway
 * statement was already recorded.
 *
 * ## `platformDb`, not `tenantDb`
 *
 * Migration 20260819120000_payment_ledger revoked INSERT/UPDATE/DELETE on
 * `Payment` from `ventia_app` and granted back SELECT alone, so a
 * `tenantDb(...)` write here would fail with `permission denied` — by design,
 * and for the same reason `webhooks.controller.ts` explains at length for its
 * own `WebhookEvent` inserts: a merchant may read this evidence, and nothing
 * running under tenant credentials may write or amend it. `tenantId` is
 * therefore passed explicitly rather than injected by the tenant client.
 *
 * ## `skipDuplicates`, not a try/catch on P2002
 *
 * The unique key is `(tenantId, provider, providerRef, status, amountCents)`.
 * Re-observation of one statement is ROUTINE on both paths — a gateway retry
 * the webhook controller reprocesses, and a reconciliation sweep that re-asks
 * about the same order every 2 minutes — so a duplicate is an expected no-op,
 * not an exceptional condition, and `ON CONFLICT DO NOTHING` says that in one
 * statement instead of leaving a swallow-this-error branch at every call site.
 *
 * Any OTHER failure is deliberately left to propagate. Both callers are
 * positioned so that a throw is safe (see rule 2 above), and silently
 * swallowing a write failure would produce exactly the "looks complete, isn't"
 * ledger this module is built to avoid.
 */
export async function recordPaymentAttempt(attempt: PaymentAttempt): Promise<void> {
  await platformDb.payment.createMany({
    data: [
      {
        tenantId: attempt.tenantId,
        orderId: attempt.orderId,
        provider: attempt.provider,
        providerRef: attempt.providerRef,
        amountCents: attempt.amountCents,
        status: attempt.status,
        raw: attempt.raw,
      },
    ],
    skipDuplicates: true,
  });
}
