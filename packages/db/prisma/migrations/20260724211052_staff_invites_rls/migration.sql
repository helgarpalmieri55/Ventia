-- Extends the tenant-isolation RLS policy set (see the 20260723182728_rls
-- migration) to the new StaffInvite table — same guarded-nullif SQL shape,
-- for one table. No REVOKE step is needed here (unlike
-- 20260723205801_revoke_ventia_app_system_tables): StaffInvite is a
-- genuine tenant-owned table, and ALTER DEFAULT PRIVILEGES from the rls
-- migration already grants ventia_app SELECT/INSERT/UPDATE/DELETE on it
-- (it was created after that migration ran).
ALTER TABLE "StaffInvite" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "StaffInvite"
  USING ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid);
