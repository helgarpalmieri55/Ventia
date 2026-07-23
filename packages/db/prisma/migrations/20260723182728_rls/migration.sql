-- Extensions used across the platform
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";
CREATE EXTENSION IF NOT EXISTS "vector";

-- Non-owner role subject to RLS. NOLOGIN: reached via SET ROLE from the app connection.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'ventia_app') THEN
    CREATE ROLE ventia_app NOLOGIN;
  END IF;
END $$;
GRANT ventia_app TO CURRENT_USER;
GRANT USAGE ON SCHEMA public TO ventia_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ventia_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ventia_app;

-- Enable RLS + tenant policy on tenant-owned tables
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'TenantDomain','TenantLimits','Category','Product','ProductCategory',
    'ProductVariant','ProductImage','InventoryMovement','Cart','CartItem',
    'Customer','Order','OrderItem','OrderEvent','Payment','Conversation',
    'Message','AgentUsage','TenantContent','NotificationLog','Subscription',
    'Shipment','Invoice'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    -- nullif(...,'') guards against custom GUCs whose reset value on a reused
    -- connection is '' (empty string) rather than NULL once the GUC has been
    -- set at least once in the session; without it, ''::uuid raises a cast
    -- error instead of yielding "no context => no rows".
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING ("tenantId" = nullif(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK ("tenantId" = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)',
      t
    );
  END LOOP;
END $$;

-- Tenant root table: ventia_app may only read its own tenant row
ALTER TABLE "Tenant" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_self ON "Tenant"
  USING ("id" = nullif(current_setting('app.tenant_id', true), '')::uuid);
