-- Wires up the "Payment" table: from a declared-but-dead table (created by
-- 20260723182106_init, given the standard tenant treatment by
-- 20260723182728_rls, and then never read or written by a single line of
-- application code) into the APPEND-ONLY, per-ATTEMPT payment ledger
-- docs/SPEC.md §8 specifies.
--
-- The full rationale for the table's existence and its grain lives on the
-- model's doc comment in schema.prisma. The short version, because it is what
-- justifies the privilege changes below: `Order.paymentStatus` /
-- `paymentProvider` / `providerRef` are ONE SLOT holding the order's CURRENT
-- payment state, and a single slot cannot represent a shopper whose first card
-- declined and whose second succeeded, nor a partial refund. This table is the
-- HISTORY — one row per statement a gateway made about money — and it is
-- written by both settle paths (services/api/src/payments/webhooks.controller.ts
-- and services/api/src/payments/reconciliation.worker.ts, through the single
-- writer services/api/src/payments/payment-ledger.ts).
--
-- No column changes and no data migration: every column this ledger needs was
-- already created by the init migration in exactly the spec'd shape. What
-- changes is (1) two indexes, and (2) the privilege/RLS posture, which the
-- init-era blanket grant got wrong for a table of this kind.

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
--
-- The order-history read path: "what has every gateway ever said about this
-- order's money, newest first". `tenantId` leads so the index is usable under
-- the RLS predicate below (which is a `tenantId` equality) and so it also
-- serves the tenant-wide variant of the same question. Without it this is a
-- sequential scan over every payment statement the platform has ever recorded.
-- CreateIndex
CREATE INDEX "Payment_tenantId_orderId_createdAt_idx" ON "Payment"("tenantId", "orderId", "createdAt" DESC);

-- The idempotency key — the reason repeated observation of one gateway
-- statement does not grow this table without bound, and NOT merely a
-- uniqueness nicety.
--
-- Both writers legitimately re-observe the same statement. The webhook
-- controller REPROCESSES a delivery whose "WebhookEvent" row exists but was
-- never stamped `processedAt` (fix 5 in webhooks.controller.ts — a settle that
-- threw must not leave a genuinely paid order stuck behind its own idempotency
-- row). And the reconciliation sweep re-asks the gateway about the same order
-- every 2 minutes for as long as it remains a candidate: an order sitting in
-- PENDING/FAILED whose gateway answer is still FAILED is queried on EVERY
-- pass, deliberately (wave-2 FIX 1 put FAILED back in the candidate set so a
-- lost retry webhook can still be recovered). Unbounded, that is one row every
-- two minutes, forever, for an order nothing is happening to.
--
-- The key is "one row per distinct thing the gateway said", so a genuine state
-- change on the same transaction (PENDING then PAID) is a different statement
-- and still gets its own row — which is exactly the per-attempt history this
-- table exists for. `amountCents` is in the key for the same reason: two
-- partial refunds of one payment are two different statements about money.
--
-- `providerRef` is NULLABLE and Postgres treats NULLs as DISTINCT in a unique
-- index, so a row without one gets NO protection here — the same property, and
-- the same caveat, as "WebhookEvent"'s tenant-less rows (note 4 of
-- 20260814090000_webhook_event_tenant_scoped_unique). Acceptable because both
-- of today's writers always hold a gateway transaction id before they reach
-- the ledger; a future writer that does not must bring its own dedupe.
--
-- Cannot fail on existing rows: nothing has ever written to this table.
-- CreateIndex
CREATE UNIQUE INDEX "Payment_tenantId_provider_providerRef_status_amountCents_key" ON "Payment"("tenantId", "provider", "providerRef", "status", "amountCents");

-- ---------------------------------------------------------------------------
-- Append-only: `ventia_app` gets SELECT and nothing else
-- ---------------------------------------------------------------------------
--
-- 20260723182728_rls granted `ventia_app` SELECT, INSERT, UPDATE, DELETE on
-- every table then in the schema (plus an ALTER DEFAULT PRIVILEGES that does
-- the same for later ones), and gave "Payment" the standard tenant policy with
-- both USING and WITH CHECK. That was the right default for a table nothing
-- used; it is the wrong posture for what this table now is.
--
-- Every row here is EVIDENCE OF WHAT A GATEWAY SAID ABOUT MONEY. It is the
-- same class of record as "WebhookEvent", and it gets the same treatment
-- 20260815120000_webhook_event_tenant_read gave that table, for the same
-- reason spelled out there: a merchant must be able to READ their own payment
-- history (they cannot refund a shopper they cannot see was charged), and
-- nobody operating under tenant credentials may write, amend, or delete it. A
-- ledger a tenant can UPDATE is not a ledger — the whole value of the row is
-- that it is the system's own immutable statement of what happened, and the
-- rows most worth tampering with are precisely the ones that record a charge
-- someone would rather forget.
--
-- Revoke everything first, then grant back only SELECT. Starting from zero
-- rather than subtracting from the init-era grants means a future change to
-- those grants (or to ALTER DEFAULT PRIVILEGES) cannot silently re-widen this
-- table — same construction as 20260818120000_whatsapp_numbers.
--
-- Nothing loses a capability: there was no writer to break, and the writer
-- being added in this change (payment-ledger.ts) runs on `platformDb`, the
-- owner connection, exactly as webhooks.controller.ts's own "WebhookEvent"
-- inserts already do.
REVOKE ALL PRIVILEGES ON TABLE "Payment" FROM ventia_app;

GRANT SELECT ON TABLE "Payment" TO ventia_app;

-- ---------------------------------------------------------------------------
-- Row-level security: replace the FOR ALL policy with a FOR SELECT one
-- ---------------------------------------------------------------------------
--
-- The grant above is the hard stop. This is the second, independent layer, and
-- it is narrowed to match the grant rather than left as-is so that the two
-- point the same way: if the write grant were ever mistakenly restored (a
-- careless `GRANT ALL`, a future default-privileges change), the absence of
-- any INSERT/UPDATE/DELETE policy still refuses the write. That is the same
-- belt-and-braces argument made in 20260818090000_agent_usage and repeated in
-- 20260818120000_whatsapp_numbers.
--
-- Dropping the init policy is safe and is not a widening: a table with RLS
-- enabled and no policy at all denies everything to non-owners, so there is no
-- window in this transaction where the table is more visible than before.
--
-- The `nullif(..., '')` guard is copied verbatim from 20260723182728_rls: a
-- reused pooled connection whose GUC has been set at least once resets it to
-- '' rather than NULL, and ''::uuid raises a cast error instead of yielding
-- "no context => no rows".
DROP POLICY tenant_isolation ON "Payment";

CREATE POLICY tenant_isolation_select ON "Payment"
  FOR SELECT
  USING ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- ## Why ENABLE (already set by 20260723182728_rls) and not FORCE
--
-- Left as plain ENABLE, like every policy in this codebase — see the note in
-- packages/db/src/index.ts, which documents the owner exemption as a
-- load-bearing invariant. FORCE would extend this policy to the table owner,
-- which is `platformDb`, which is the connection that WRITES this ledger. The
-- reconciliation sweep in particular is inherently cross-tenant (one pass over
-- every tenant's candidate orders, with no `app.tenant_id` set — see
-- `reconcilePendingPayments`'s own doc comment), so under FORCE its ledger
-- inserts would evaluate the policy against NULL and be rejected for every
-- tenant. The result would be the failure mode this whole change exists to
-- prevent: a ledger that only one settle path writes, which looks complete and
-- is not.
