-- ventia_app is a non-owner, RLS-subject role reached via SET LOCAL ROLE from
-- tenantDb (see rls migration + src/tenant-client.ts). The earlier
-- `GRANT ... ON ALL TABLES IN SCHEMA public` swept up tables that have no
-- tenantId / RLS policy at all (auth + platform-system tables), leaving them
-- fully readable/writable by tenant-scoped code. Revoke on those explicitly.
--
-- ALTER DEFAULT PRIVILEGES from the rls migration only affects tables created
-- AFTER it ran, so it does not need to change here; it does mean any future
-- non-RLS system table must get an equivalent explicit REVOKE.
REVOKE ALL PRIVILEGES ON TABLE "User", "Session", "Account", "Verification", "Membership", "WebhookEvent", "AuditLog", "_prisma_migrations" FROM ventia_app;
