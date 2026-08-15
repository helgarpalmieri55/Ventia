-- Lets a tenant READ (and only read) its own "WebhookEvent" rows through the
-- tenant-scoped client, so the admin app can surface the one webhook outcome
-- that needs a human: `result = 'paid_order_not_settleable'` (a signature-
-- verified PAID event that landed on an order the expiry worker had already
-- cancelled — the shopper was charged and has no order).
--
-- ## Why this table was unreachable before, and why that had to change
--
-- 20260723205801_revoke_ventia_app_system_tables revoked ALL privileges on
-- "WebhookEvent" from `ventia_app`, on the reasoning that this table is "the
-- system's own record of events, not a tenant-owned row" — the same treatment
-- "AuditLog" gets. That reasoning still holds for WRITES: the only writer is
-- services/api/src/payments/webhooks.controller.ts, which runs on the owner
-- connection (platformDb) and must keep doing so. It does NOT hold for reads
-- any more: a tenant's own `paid_order_not_settleable` rows are the only
-- record anywhere that the tenant's shopper was charged for nothing, and a
-- merchant who cannot see them cannot refund anyone.
--
-- So this grants exactly SELECT — not INSERT/UPDATE/DELETE. A merchant can
-- read this audit trail; nobody but the owner connection can write to it or
-- amend it. That is deliberate: the value of the row is that it is the
-- system's own immutable statement about what happened.
--
-- ## Why RLS, not just a WHERE clause in the service
--
-- packages/db/src/tenant-client.ts injects `AND tenantId = <id>` at the
-- application layer for every model listed in TENANT_MODELS, which this
-- migration's companion change adds "WebhookEvent" to. That is the first
-- layer. RLS is the second, independent one, exactly as it is for every other
-- tenant-owned table: a service that forgets the filter, or reaches the table
-- some other way under `ventia_app`, still cannot see another tenant's rows.
--
-- FOR SELECT only, matching the grant. There is no WITH CHECK clause because
-- there is no write privilege for it to apply to.
--
-- `tenantId` is NULLABLE on this table (some webhook events are genuinely
-- tenant-less — see the column's doc comment in schema.prisma). `NULL = <uuid>`
-- is NULL, not true, so RLS shows a tenant-less row to NOBODY under this
-- policy. That is the correct answer: an event no tenant owns is not any
-- merchant's to see.
--
-- The `nullif(..., '')` guard is copied verbatim from the original RLS
-- migration: a reused pooled connection whose GUC has been set at least once
-- resets it to '' rather than NULL, and ''::uuid raises a cast error instead
-- of yielding "no context => no rows".
--
-- platformDb keeps full access throughout: every policy in this codebase uses
-- plain ENABLE ROW LEVEL SECURITY (never FORCE), which never applies to the
-- table's owner. The webhook controller's inserts/updates are unaffected.
GRANT SELECT ON TABLE "WebhookEvent" TO ventia_app;

ALTER TABLE "WebhookEvent" ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "WebhookEvent"
  FOR SELECT
  USING ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- Supports the admin list query's exact predicate + ordering
-- (`WHERE "tenantId" = $1 AND result = 'paid_order_not_settleable'
--   ORDER BY "processedAt" DESC`). Without it this is a sequential scan over
-- every webhook delivery the platform has ever received, on a page a merchant
-- can load from the shell banner on every request.
CREATE INDEX "WebhookEvent_tenantId_result_processedAt_idx"
  ON "WebhookEvent" ("tenantId", "result", "processedAt" DESC);
