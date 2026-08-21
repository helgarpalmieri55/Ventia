-- Give `AgentUsage` a cost column that is actually written, and keep it away
-- from merchants.
--
-- `costCents` has been in this table since the initial migration and nothing
-- ever wrote it: `AgentBudgetService.record()` increments `messagesCount`,
-- `inputTokens` and `outputTokens`, and stops. Every operator view that read
-- it (`platform.service.ts`) therefore reported every tenant as costing zero,
-- which is the worst kind of broken — it looks like an answer.
--
-- The replacement is micro-dollars rather than cents because one shopper turn
-- costs a fraction of a cent, and rounding each increment to whole cents
-- rounds nearly all of them to zero. See the schema comment for why USD and
-- why BigInt.
ALTER TABLE "AgentUsage" ADD COLUMN "costMicroUsd" BIGINT NOT NULL DEFAULT 0;

-- Keep the two COST columns unreadable by `ventia_app`, while leaving the rest
-- of the row readable exactly as before.
--
-- 20260818090000_agent_usage deliberately kept SELECT on this table so a
-- merchant can see their own month against their plan. A new column inherits
-- that table-level grant, which is right for the token counters and wrong for
-- this one: what the platform PAYS per message is not the merchant's business,
-- and a merchant who can read it can compute the margin on their own plan.
--
-- Done by REVOKING the table-level grant and re-granting per column, NOT by
-- `REVOKE SELECT ("costMicroUsd")`. That form only removes column-level
-- grants; a table-level `GRANT SELECT` covers every column including future
-- ones, and revoking a single column out of it silently does nothing.
-- Verified with `has_column_privilege` rather than assumed — the first version
-- of this migration used the revoke form and left the column fully readable.
--
-- Any column added to this table LATER inherits nothing and must be granted
-- here explicitly, which is the safe direction to fail: a forgotten grant
-- shows up as a merchant-facing read error, not as a silent leak.
REVOKE SELECT ON TABLE "AgentUsage" FROM ventia_app;
GRANT SELECT ("id", "tenantId", "month", "inputTokens", "outputTokens", "messagesCount")
  ON TABLE "AgentUsage" TO ventia_app;

-- The platform writer is unaffected by all of the above: `platformDb` connects
-- as the schema owner, not as `ventia_app`.
