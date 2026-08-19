-- Subscription tracking, v1 manual (docs/SPEC.md §6 M9, §8, phase P6).
--
-- The table itself has existed since `20260723182106_init` and nothing has
-- ever written to it. This migration is what makes it usable — and, more
-- importantly, decides who may read it. That second question is the reason
-- this file is long.
--
-- ============================================================================
-- 1. WHOSE DATA IS THIS?  (the RLS / grant decision)
-- ============================================================================
--
-- Two precedents in this repo, and this table has to pick one:
--
--   a) `20260723182728_rls` — tenant-owned tables. RLS on, `tenant_isolation`
--      policy, `ventia_app` holds SELECT/INSERT/UPDATE/DELETE and sees exactly
--      its own rows. Products, orders, conversations: things a merchant OWNS
--      and their own storefront reads on every request.
--
--   b) `20260723205801_revoke_ventia_app_system_tables` — the seven auth /
--      platform tables (`User`, `Session`, `Account`, `Verification`,
--      `Membership`, `WebhookEvent`, `AuditLog`). `ventia_app` has ALL
--      PRIVILEGES REVOKED; they are reachable only through `platformDb`.
--      Things ABOUT a merchant that a merchant is not a party to writing.
--
-- `Subscription` was swept into (a) by that first migration, because it has a
-- `tenantId` column and the loop was written over "tables with a tenantId".
-- That is the wrong bucket, and this migration moves it to (b):
--
--   * It is not tenant data. It records what VENTIA charges this merchant and
--     until when they have paid — a fact about the platform's commercial
--     relationship with them, authored solely by a Ventia operator. No
--     storefront request, no merchant admin screen, and no agent tool reads
--     it. Nothing in `/v1/admin/*` has any business touching it.
--
--   * `paidUntil` is an ENFORCEMENT input. The auto-suspend sweep
--     (services/api/src/platform/subscription-sweep.worker.ts) takes a store
--     offline N days past that date. Under bucket (a), `ventia_app` held
--     UPDATE on it — so any tenant-scoped code path that could be tricked into
--     writing this table (a `...body` spread, a future generic "update my
--     settings" endpoint) would let a merchant set their own paid-until to
--     2099 and never pay again. A privilege a merchant-facing write path could
--     ever produce is not a platform privilege — the same argument
--     `platform-admin.guard.ts` makes about `Membership`.
--
--   * `priceCents` is commercially sensitive per merchant. Getting the
--     permissive direction wrong here leaks one merchant's negotiated price to
--     another. Revoking is the direction whose failure mode is a
--     `permission denied` in a log, not a disclosure nobody notices.
--
-- What is NOT dropped: the RLS enable + `tenant_isolation` policy from
-- `20260723182728_rls` stay exactly as they are. They are now belt to the
-- grant's braces, and cost nothing: the owner connection (`platformDb`) is
-- exempt from a non-FORCE policy anyway, and if a future
-- `GRANT ... ON ALL TABLES IN SCHEMA public` ever re-grants `ventia_app` by
-- accident — which is precisely how this table ended up in bucket (a) — the
-- policy still bounds the damage to a tenant's own row instead of the whole
-- platform's price list. Two independent controls, same posture as the
-- allowlist-AND-column pair on the operator guard.
--
-- The application-layer half of this decision is `packages/db/src/tenant-models.ts`,
-- where `Subscription` is removed from `TENANT_MODELS` — so a `tenantDb(t)
-- .subscription.*` call no longer gets a `tenantId` injected and instead
-- fails loudly on the missing grant, which is the intended way to find out
-- that you reached for the wrong client.
DO $$ BEGIN
  IF to_regclass('"Subscription"') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE "Subscription" FROM ventia_app';
  END IF;
END $$;

-- ============================================================================
-- 2. ONE ROW PER TENANT
-- ============================================================================
--
-- `Subscription` is current state, not a ledger: an operator records that a
-- merchant paid and moves `paidUntil` forward. The history of those moves is
-- already captured in `AuditLog` by every mutation on the operator API
-- (`platform.tenant.subscription_recorded`, with previous and new values), so
-- a second row per tenant would buy no history that is not already kept — and
-- would cost the one thing this table cannot afford: ambiguity about WHICH row
-- governs. The auto-suspend sweep reads this table to decide whether to take a
-- store offline. "Whichever row sorts last" is not an acceptable answer to
-- that question, and it was the previous answer (`platform.service.ts` ordered
-- by `id DESC` — a random v4 UUID, i.e. no order at all).
--
-- The de-duplication below is defensive rather than expected: no code path has
-- ever inserted into this table, so every real database has zero rows here.
-- It exists so that a hand-seeded or fixture database cannot fail the CREATE
-- UNIQUE INDEX mid-deploy. It keeps the row with the LATEST `paidUntil`
-- (`NULLS LAST`, then newest id) — deliberately the most favourable row to the
-- merchant, because the failure this whole feature must never produce is
-- taking a paying store offline.
DELETE FROM "Subscription"
 WHERE "id" IN (
   SELECT "id" FROM (
     SELECT "id",
            row_number() OVER (
              PARTITION BY "tenantId"
              ORDER BY "paidUntil" DESC NULLS LAST, "id" DESC
            ) AS rn
       FROM "Subscription"
   ) ranked
    WHERE rn > 1
 );

-- `createdAt` / `updatedAt`: an operator looking at a subscription needs to
-- know when it was last touched, and the sweep's logs are far easier to read
-- back against a row that says when it changed. `updatedAt` is added WITH a
-- default so the statement succeeds against existing rows, then has the
-- default dropped — Prisma's `@updatedAt` is an application-level default, and
-- leaving a database-level one in place would show up forever as schema drift.
ALTER TABLE "Subscription" ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "Subscription" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "Subscription" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- The unique index replaces the plain one on the same column: a unique index
-- serves every lookup the non-unique one served, so keeping both would be
-- paying twice for one capability.
DROP INDEX "Subscription_tenantId_idx";
CREATE UNIQUE INDEX "Subscription_tenantId_key" ON "Subscription"("tenantId");

-- ============================================================================
-- 3. THE SWEEP'S INDEX
-- ============================================================================
--
-- The hourly auto-suspend sweep asks, platform-wide with no tenant filter:
--
--   WHERE "paidUntil" < cutoff ORDER BY "paidUntil" ASC LIMIT n
--
-- Honest about magnitude, unlike `20260819150000_conversation_retention_indexes`:
-- that one rescued a query that was scanning every conversation ever held.
-- This table holds at most one row per tenant, so a sequential scan of it is
-- cheap today and would stay cheap for a long time. The index is here because
-- the sweep's predicate and its ORDER BY are the same column — so the bounded
-- batch is taken without sorting the candidate set — and because this is the
-- one query on this table that runs on a schedule forever, whether or not an
-- operator is looking. It is not a partial index: rows do not leave the
-- "overdue" slice on their own (only an operator recording a payment moves
-- one), so a mutable predicate would just churn.
CREATE INDEX "Subscription_paidUntil_idx" ON "Subscription"("paidUntil");
