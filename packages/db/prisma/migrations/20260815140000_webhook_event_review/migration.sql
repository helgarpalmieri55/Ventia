-- The merchant's own APPEND-ONLY account of what they did about a
-- `paid_order_not_settleable` alert (see
-- 20260815120000_webhook_event_tenant_read for the alert itself).
--
-- ## Why a new table instead of a column on "WebhookEvent"
--
-- "WebhookEvent" is the system's immutable statement of what a gateway told
-- us. The previous migration deliberately gave `ventia_app` SELECT and
-- nothing else on it, so no tenant-scoped code can amend that audit trail.
-- A `reviewedAt`/`dismissed` column there would have handed back exactly the
-- write privilege that migration withheld, and on the one row that means "a
-- shopper was charged and has no order". So the merchant's claim about what
-- they did is recorded HERE, next to it, and the two never mix: one is the
-- gateway's word, the other is a human's.
--
-- ## Why append-only is enforced in the DATABASE, not the service
--
-- The alarm this record silences is a financial discrepancy. "Nobody can make
-- one disappear without a trace" is only true if it is true even for a
-- service with a bug, a future endpoint written by someone who never read
-- this comment, or a raw query. So:
--
--   * `ventia_app` gets SELECT + INSERT, and UPDATE/DELETE are REVOKEd.
--   * The RLS policies below are `FOR SELECT` and `FOR INSERT` only. Postgres
--     denies any command with no permissive policy, so even if the grants
--     were mistakenly restored later, an UPDATE or DELETE under this role
--     still matches zero rows.
--
-- Both layers point the same way on purpose: the grant is the hard stop, the
-- missing policies are the backstop.
--
-- The REVOKE is necessary rather than decorative: the original RLS migration
-- (20260723182728_rls) ran
-- `ALTER DEFAULT PRIVILEGES ... GRANT SELECT, INSERT, UPDATE, DELETE ON
-- TABLES TO ventia_app`, so every table created after it — including this one
-- — arrives with UPDATE and DELETE already granted. Undoing that here is what
-- makes "append-only" real.
--
-- ## Undo
--
-- There is no "un-review" command, because there is no mutable state to
-- reverse. Marking the wrong row is corrected by APPENDING a row whose
-- `action` is `reopened`; the alert's current state is derived from the
-- latest row per event. That keeps every correction on the record instead of
-- erasing the mistake — and it means the ability to fix a mis-click costs
-- nothing in auditability.

CREATE TYPE "WebhookEventReviewAction" AS ENUM (
  'refunded',
  'order_taken_again',
  'no_action_needed',
  'other',
  'reopened'
);

CREATE TABLE "WebhookEventReview" (
  "id"               UUID NOT NULL,
  "tenantId"         UUID NOT NULL,
  "webhookEventId"   UUID NOT NULL,
  "action"           "WebhookEventReviewAction" NOT NULL,
  "note"             TEXT,
  "reviewedByUserId" UUID NOT NULL,
  "reviewedByEmail"  TEXT NOT NULL,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "WebhookEventReview_pkey" PRIMARY KEY ("id")
);

-- Serves both reads: the list's "latest review per event" batch lookup and
-- the "Revisados" section's ordering.
CREATE INDEX "WebhookEventReview_tenantId_webhookEventId_createdAt_idx"
  ON "WebhookEventReview" ("tenantId", "webhookEventId", "createdAt" DESC);

-- Explicit rather than relying on ALTER DEFAULT PRIVILEGES having applied:
-- this table's whole security posture is which of these four verbs exist.
GRANT SELECT, INSERT ON TABLE "WebhookEventReview" TO ventia_app;
REVOKE UPDATE, DELETE ON TABLE "WebhookEventReview" FROM ventia_app;

ALTER TABLE "WebhookEventReview" ENABLE ROW LEVEL SECURITY;

-- Same guarded-nullif shape as every other tenant_isolation policy in this
-- codebase (a reused pooled connection resets the GUC to '' rather than NULL,
-- and ''::uuid raises instead of yielding "no context => no rows").
--
-- Split into two single-command policies instead of one ALL policy, so the
-- absence of an UPDATE/DELETE policy is a deliberate, readable statement
-- rather than an omission.
CREATE POLICY tenant_isolation_select ON "WebhookEventReview"
  FOR SELECT
  USING ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- WITH CHECK (no USING): an INSERT may only ever write a row belonging to the
-- calling tenant. This is what stops a service bug from filing one merchant's
-- review against another merchant's alert.
CREATE POLICY tenant_isolation_insert ON "WebhookEventReview"
  FOR INSERT
  WITH CHECK ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid);
