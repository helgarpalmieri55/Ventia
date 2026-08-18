-- `Order.reference` — the globally-unique, unguessable string handed to a
-- payment gateway, and the only identifier a webhook is resolved through.
--
-- Full reasoning:
-- docs/superpowers/specs/2026-08-15-per-order-gateway-references.md
--
-- In short: two tenants may share one gateway merchant account, so one signed
-- delivery verifies at either tenant's webhook URL; `Order.number` is
-- per-tenant, so order 1001 exists in both. The reference being that number
-- meant a delivery about tenant B's order 1001 resolved to tenant A's order
-- 1001 when POSTed to A's URL. Only the amount check stood between that and
-- settling A's order with B's shopper's money — and it stops standing as soon
-- as two same-numbered orders share a total, which is exactly what a shared
-- account with an overlapping catalogue looks like.
--
-- ## Backfill
--
-- Added in three steps rather than as one NOT NULL column, because existing
-- rows have no value and a bare `ADD COLUMN ... NOT NULL UNIQUE` would fail on
-- any non-empty table.
--
-- The backfill uses `gen_random_uuid()` (pgcrypto, already available on the
-- Postgres images this project runs) rather than trying to reproduce the
-- application's own token format. These values only ever need to be unique and
-- non-guessable; nothing parses them. They also identify orders that were
-- created BEFORE gateway references existed, so no gateway has ever been told
-- about them and none can ever arrive in a webhook.
ALTER TABLE "Order" ADD COLUMN "reference" TEXT;

UPDATE "Order" SET "reference" = 'vr_backfill_' || replace(gen_random_uuid()::text, '-', '')
WHERE "reference" IS NULL;

ALTER TABLE "Order" ALTER COLUMN "reference" SET NOT NULL;

-- GLOBAL, not `("tenantId", "reference")`. Cross-tenant ambiguity is the
-- defect; a tenant-scoped constraint would leave it exactly as it was. This
-- unique index is also what the webhook settle path looks the order up by, so
-- it is on the hot path of every delivery.
CREATE UNIQUE INDEX "Order_reference_key" ON "Order" ("reference");
