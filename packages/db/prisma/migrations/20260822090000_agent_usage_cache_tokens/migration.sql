-- Meter the prompt cache separately from ordinary input.
--
-- The agent now marks its system prompt and tool schemas cacheable, which is
-- the largest cost reduction available to that loop: both are byte-identical
-- on every turn of every conversation, and were being re-sent and re-billed at
-- full input price on each of the up-to-four model round-trips one shopper
-- question can make.
--
-- Three counters and not one, because the three are billed at three different
-- rates. Adding cache reads into `inputTokens` would price every hit as a
-- full-price read and hide the saving in the very report that exists to show
-- it.
ALTER TABLE "AgentUsage" ADD COLUMN "cacheWriteTokens" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "AgentUsage" ADD COLUMN "cacheReadTokens" INTEGER NOT NULL DEFAULT 0;

-- Granted explicitly. 20260821200000 revoked the table-level SELECT on this
-- table and re-granted per column so the two COST columns stay unreadable by
-- `ventia_app`; the consequence is that a new column inherits nothing and is
-- invisible to the tenant role until named here. That is the safe direction to
-- fail — a forgotten grant surfaces as a merchant-facing read error rather
-- than as a silent leak — but it does have to be remembered, which is why that
-- migration says so and why this one is two statements instead of one.
--
-- These two are token counts, not money: they belong on the same side of the
-- line as `inputTokens`, which the merchant can already see.
GRANT SELECT ("cacheWriteTokens", "cacheReadTokens") ON TABLE "AgentUsage" TO ventia_app;
