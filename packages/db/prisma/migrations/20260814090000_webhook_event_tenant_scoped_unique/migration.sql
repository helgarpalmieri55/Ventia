-- Tenant-scope WebhookEvent's idempotency key: (provider, eventId) -> (provider, tenantId, eventId).
--
-- Safety notes (checked, not assumed):
--
--  1. NO DATA MIGRATION IS NEEDED, and this cannot fail on existing rows. The
--     new key is a strict SUPERSET of the old one's columns, so any row set
--     that satisfied UNIQUE(provider, eventId) also satisfies
--     UNIQUE(provider, tenantId, eventId) — widening a unique key can only
--     ever admit more rows, never reject rows that already exist. (The
--     reverse direction would have needed a duplicate check first; this
--     direction does not.)
--
--  2. The NEW index is created BEFORE the old one is dropped, so there is no
--     instant at which the table is unprotected. Both statements run inside
--     the single transaction Prisma wraps each migration in, so a failure of
--     either leaves the pre-migration index in place.
--
--  3. The old index MUST be dropped rather than left in place: keeping
--     UNIQUE(provider, eventId) would still reject the second tenant's copy of
--     a shared-merchant-account delivery, which is precisely the defect this
--     migration exists to fix.
--
--  4. Rows with a NULL "tenantId" are unaffected in practice (Postgres treats
--     NULLs as distinct in a unique index, so they simply are not deduped by
--     this constraint) — see the schema.prisma comment on this model. The only
--     writer today always supplies a tenantId.
CREATE UNIQUE INDEX "WebhookEvent_provider_tenantId_eventId_key" ON "WebhookEvent"("provider", "tenantId", "eventId");

DROP INDEX "WebhookEvent_provider_eventId_key";
