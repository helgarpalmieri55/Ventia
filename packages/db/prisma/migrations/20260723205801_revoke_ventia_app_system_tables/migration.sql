-- ventia_app is a non-owner, RLS-subject role reached via SET LOCAL ROLE from
-- tenantDb (see rls migration + src/tenant-client.ts). The earlier
-- `GRANT ... ON ALL TABLES IN SCHEMA public` swept up tables that have no
-- tenantId / RLS policy at all (auth + platform-system tables), leaving them
-- fully readable/writable by tenant-scoped code. Revoke on those explicitly.
--
-- ALTER DEFAULT PRIVILEGES from the rls migration only affects tables created
-- AFTER it ran, so it does not need to change here; it does mean any future
-- non-RLS system table must get an equivalent explicit REVOKE.
--
-- Each REVOKE is wrapped in a `to_regclass(...) IS NOT NULL` guard (phase-
-- review amendment): `prisma migrate dev`/`migrate reset` replay every
-- migration in order against a throwaway shadow database, and a bare REVOKE
-- on a table that doesn't exist yet in that replay ordering (or a stray
-- reordering) errors out the whole migrate command. Testcontainers-based
-- test suites always run every migration fresh from empty, so they're
-- unaffected either way — this guard only matters for the shadow-DB replay
-- and doesn't change behavior against a normally-migrated database, where
-- every one of these tables already exists by this point.
DO $$ BEGIN IF to_regclass('"User"') IS NOT NULL THEN EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE "User" FROM ventia_app'; END IF; END $$;
DO $$ BEGIN IF to_regclass('"Session"') IS NOT NULL THEN EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE "Session" FROM ventia_app'; END IF; END $$;
DO $$ BEGIN IF to_regclass('"Account"') IS NOT NULL THEN EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE "Account" FROM ventia_app'; END IF; END $$;
DO $$ BEGIN IF to_regclass('"Verification"') IS NOT NULL THEN EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE "Verification" FROM ventia_app'; END IF; END $$;
DO $$ BEGIN IF to_regclass('"Membership"') IS NOT NULL THEN EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE "Membership" FROM ventia_app'; END IF; END $$;
DO $$ BEGIN IF to_regclass('"WebhookEvent"') IS NOT NULL THEN EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE "WebhookEvent" FROM ventia_app'; END IF; END $$;
DO $$ BEGIN IF to_regclass('"AuditLog"') IS NOT NULL THEN EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE "AuditLog" FROM ventia_app'; END IF; END $$;
DO $$ BEGIN IF to_regclass('"_prisma_migrations"') IS NOT NULL THEN EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE "_prisma_migrations" FROM ventia_app'; END IF; END $$;
