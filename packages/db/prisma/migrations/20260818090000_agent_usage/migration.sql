-- Make the AI budget counter tenant-READ-ONLY.
--
-- `AgentUsage` has existed since the initial migration and, like every other
-- tenant table, got the standard treatment from 20260723182728_rls: a
-- `tenant_isolation` policy with both USING and WITH CHECK, plus the
-- ALTER DEFAULT PRIVILEGES grant of SELECT/INSERT/UPDATE/DELETE to
-- `ventia_app`. That is the right default for a catalogue or an order — a
-- merchant owns those rows and edits them.
--
-- It is the wrong default for this table. `AgentUsage` is the meter the plan
-- limit is enforced against (docs/SPEC.md §7: at 100% the agent stops calling
-- the model, hard cap, no exceptions). A cap a tenant can write to is not a
-- cap. Nothing tenant-scoped needs to write it either: the counter is
-- incremented by the agent service on `platformDb`, which is the schema owner
-- and unaffected by these grants.
--
-- The merchant still needs to SEE it — the admin usage meter shows a store
-- their own month against their plan — so SELECT stays.
--
-- Same posture, and the same reasoning, as `WebhookEvent`
-- (20260815120000_webhook_event_tenant_read) and `WebhookEventReview`
-- (20260815140000_webhook_event_review): read your own, never amend the
-- system's own record of what happened.
REVOKE INSERT, UPDATE, DELETE ON TABLE "AgentUsage" FROM ventia_app;

-- The existing `tenant_isolation` policy is an ALL policy (USING + WITH
-- CHECK), so it permits every command for a matching tenant. Replacing it with
-- a SELECT-only policy makes the read-only intent explicit at the policy layer
-- too: Postgres denies any command with no permissive policy, so even if the
-- grants above were mistakenly restored later, an UPDATE or DELETE under this
-- role still matches zero rows.
--
-- Both layers point the same way on purpose: the grant is the hard stop, the
-- missing policies are the backstop.
DROP POLICY IF EXISTS tenant_isolation ON "AgentUsage";

CREATE POLICY tenant_isolation_select ON "AgentUsage"
  FOR SELECT
  USING ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid);
