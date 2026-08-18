-- WhatsAppNumber: the inbound routing table for the WhatsApp channel (P5b),
-- per docs/superpowers/specs/2026-08-18-p5-whatsapp-design.md §1.
--
-- CreateEnum
CREATE TYPE "WhatsAppProviderId" AS ENUM ('evolution', 'cloud');

-- CreateTable
CREATE TABLE "WhatsAppNumber" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "provider" "WhatsAppProviderId" NOT NULL,
    "externalId" TEXT NOT NULL,
    "displayPhone" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "credentialsEnc" TEXT,
    "verifyToken" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsAppNumber_pkey" PRIMARY KEY ("id")
);

-- The routing key, and the reason this is a table rather than another key
-- under `Tenant.settings`.
--
-- UNIQUE across the whole platform, deliberately NOT unique-per-tenant. Meta
-- delivers one webhook per app covering every phone number registered under
-- it, so an inbound delivery identifies its tenant with nothing but
-- `entry[].changes[].value.metadata.phone_number_id`. If two tenants could
-- both claim that value the lookup returns two rows and there is no
-- non-arbitrary way to pick one — and "arbitrary" here means one store's
-- customers reaching another store's agent, handing over their conversation
-- and the order data the agent's tools can read.
--
-- So this index is a safety property, not tidiness. The application-layer
-- check the admin connection flow will do ("is this number already
-- registered?") is a check-then-act race; the UNIQUE index is the only part
-- of it that actually holds under concurrency, and it is what makes a
-- fat-fingered or malicious registration of someone else's phone_number_id
-- fail loudly instead of silently stealing traffic.
--
-- Evolution API is per-instance rather than per-app, so its `externalId` is
-- the instance name. Same column, same uniqueness, no special case.
-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppNumber_externalId_key" ON "WhatsAppNumber"("externalId");

-- CreateIndex
CREATE INDEX "WhatsAppNumber_tenantId_idx" ON "WhatsAppNumber"("tenantId");

-- AddForeignKey. ON DELETE CASCADE: a deleted tenant must not leave a live
-- routing entry behind — an orphan here keeps matching inbound deliveries for
-- a store that no longer exists, and (because `externalId` is globally
-- unique) also blocks the number from ever being re-registered.
ALTER TABLE "WhatsAppNumber" ADD CONSTRAINT "WhatsAppNumber_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Privileges: this table holds secrets, so `ventia_app` gets less than the
-- standard tenant-table treatment on BOTH axes.
-- ---------------------------------------------------------------------------
--
-- 20260723182728_rls left an `ALTER DEFAULT PRIVILEGES ... GRANT SELECT,
-- INSERT, UPDATE, DELETE ON TABLES TO ventia_app`, so a table created by a
-- later migration arrives fully writable by tenant-scoped code unless it says
-- otherwise. This one says otherwise. Revoke everything first, then grant back
-- only what the admin UI genuinely needs — starting from zero rather than
-- subtracting from the default means a future change to those default
-- privileges cannot silently widen this table.
REVOKE ALL PRIVILEGES ON TABLE "WhatsAppNumber" FROM ventia_app;

-- ## Why no INSERT/UPDATE/DELETE for ventia_app
--
-- Same posture as `AgentUsage` (20260818090000_agent_usage) and `WebhookEvent`
-- (20260815120000_webhook_event_tenant_read): read your own, never write the
-- system's own routing table.
--
-- It matters more here than it does for a usage counter. `externalId` is the
-- routing key, and the check that a tenant is entitled to a given
-- phone_number_id is not a database constraint — it is the Meta handshake the
-- admin flow performs (P5c). A tenant-scoped INSERT would let a merchant
-- register any *unclaimed* phone_number_id and start receiving another
-- business's conversations the moment that business tried to connect; a
-- tenant-scoped UPDATE would let them repoint an existing row. The UNIQUE
-- index above stops the collision case, and this stops the land-grab case.
--
-- Writes are not blocked, only relocated: the admin connection flow has to run
-- on `platformDb` regardless, because it encrypts credentials with the
-- platform key (services/api/src/payments/encryption.ts) — that key is a
-- platform secret, not a tenant one. So nothing loses a capability here.

-- ## Why SELECT is granted per-COLUMN rather than per-table
--
-- The admin UI has a real need: the WhatsApp tab lists a tenant's numbers with
-- their `displayPhone` and `status` so a merchant can see whether their
-- channel is connected. That is the same argument that reopened SELECT on
-- `WebhookEvent`, and it is a good one.
--
-- But two of these columns are secrets. `credentialsEnc` is an AES-256-GCM
-- blob of the provider token (and the Meta app secret / Evolution base URL);
-- `verifyToken` is the plaintext shared secret Meta's GET handshake is
-- validated against. Neither is ever rendered, and `verifyToken` in
-- particular is exactly what an attacker needs to complete a webhook
-- subscription handshake against this platform's endpoint.
--
-- Three options were on the table:
--
--   (a) No SELECT at all; the API projects the safe columns via `platformDb`.
--       Safest, but it makes the admin read path a cross-tenant query with no
--       RLS behind it — the isolation of a merchant's own list would rest
--       entirely on a hand-written `where: { tenantId }`, with no second layer.
--       This codebase's whole posture (packages/db/src/tenant-client.ts +
--       RLS) is that tenant isolation gets two independent layers.
--   (b) Table-level SELECT plus discipline about never selecting the secret
--       columns. Rejected: `SELECT *` is the default in every ORM, Prisma's
--       `findMany()` with no `select` emits every column, and a property that
--       depends on nobody ever writing the obvious thing is not a property.
--   (c) Column-level SELECT — chosen. The safe columns are readable under
--       tenant context; `credentialsEnc` and `verifyToken` are not readable
--       under `ventia_app` at all, at any point, by any query, and an attempt
--       fails loudly (Postgres answers a query touching a non-granted column
--       with `ERROR: permission denied for table WhatsAppNumber`, code 42501)
--       rather than succeeding quietly.
--
-- (c) keeps both isolation layers AND makes the secret unreachable, and it
-- fails in the right direction: a future `tenantDb(t).whatsAppNumber
-- .findMany()` with no explicit `select` errors instead of loading the token
-- into application memory. Decrypting credentials is `platformDb`'s job (it
-- is the only client that holds the key anyway), so no legitimate caller is
-- inconvenienced.
GRANT SELECT ("id", "tenantId", "provider", "externalId", "displayPhone", "status", "createdAt", "updatedAt")
  ON TABLE "WhatsAppNumber" TO ventia_app;

-- ## Row-level security
--
-- Second, independent layer, exactly as for every other tenant-owned table:
-- even a service that forgets its `where` clause, or reaches this table by
-- some path the client extension does not cover, cannot see another tenant's
-- numbers.
--
-- `FOR SELECT` only, matching the grants. There is no WITH CHECK clause
-- because there is no write privilege for one to apply to; and per the note in
-- 20260818090000_agent_usage, the two layers pointing the same way is
-- deliberate — the grant is the hard stop, the absent write policies are the
-- backstop if the grant were ever mistakenly restored.
--
-- The `nullif(..., '')` guard is copied verbatim from 20260723182728_rls: a
-- reused pooled connection whose GUC has been set at least once resets it to
-- '' rather than NULL, and ''::uuid raises a cast error instead of yielding
-- "no context => no rows".
ALTER TABLE "WhatsAppNumber" ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_select ON "WhatsAppNumber"
  FOR SELECT
  USING ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- ## Why ENABLE and not FORCE
--
-- Called out explicitly because this table is the one place where FORCE would
-- be actively wrong rather than merely unnecessary.
--
-- Every policy in this codebase uses plain ENABLE (see the note in
-- packages/db/src/index.ts, which documents the owner exemption as a load-
-- bearing invariant rather than an incidental detail). FORCE would extend this
-- policy to the table owner — which is `platformDb`, which is the connection
-- that performs the inbound routing lookup.
--
-- That lookup is inherently pre-tenant: a delivery arrives, and resolving
-- `externalId -> tenantId` is *how* the tenant becomes known. There is no
-- `app.tenant_id` to have set yet, so under FORCE the policy would evaluate
-- against NULL, match zero rows, and every inbound WhatsApp message on the
-- platform would be dropped as "unknown number". The channel would be broken
-- in exactly the way that is hardest to notice: silently, and only in
-- production.

-- ---------------------------------------------------------------------------
-- Message.externalId: inbound dedupe for the same channel.
-- ---------------------------------------------------------------------------
--
-- Lives in this migration because it is part of the same routing story: the
-- table above says WHICH tenant a delivery belongs to, and this index says
-- whether we have already acted on it.
--
-- Both WhatsApp providers retry a delivery until they get a 2xx, and both
-- retry carrying the SAME provider message id. Without a uniqueness
-- constraint, a retry becomes a second `Message` row, which becomes a second
-- agent turn: the model is called again, `AgentUsage` is charged again against
-- the merchant's plan cap, and the shopper gets answered twice. That is a
-- money-affecting check, which is why it is a Postgres constraint and not a
-- seen-ids cache — a cache fails open, and failing open here means billing a
-- merchant for a message they never received.
--
-- NULLABLE, and that is load-bearing rather than laxity: every web-widget
-- message has no provider id, and Postgres treats NULLs as distinct in a
-- unique index, so unlimited null rows coexist under this constraint. (Same
-- property `WebhookEvent`'s tenant-less rows rely on — note 4 of
-- 20260814090000_webhook_event_tenant_scoped_unique.)
--
-- SCOPED TO THE TENANT, not globally unique on `externalId`. Provider message
-- ids are namespaced by the provider, not by us, and two tenants can
-- legitimately be reached through one provider account. Under a global key the
-- second tenant's copy of a shared-account delivery is rejected as a duplicate
-- and silently disappears — including when the second tenant is the message's
-- real owner. That is not a hypothetical: it is the exact bug tenant-scoping
-- fixed for `WebhookEvent` (fix 4 in
-- services/api/src/payments/webhooks.controller.ts).
--
-- No data migration and no possibility of failing on existing rows: the column
-- is added NULL, so every pre-existing row gets a NULL and no two of them can
-- collide.
-- AlterTable
ALTER TABLE "Message" ADD COLUMN "externalId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Message_tenantId_externalId_key" ON "Message"("tenantId", "externalId");
