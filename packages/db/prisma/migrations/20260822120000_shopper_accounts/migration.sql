-- Shopper accounts: a self-service login at ONE store.
--
-- ## Why new tables instead of better-auth, which this repo already runs
--
-- better-auth owns `User`/`Session`/`Account`/`Verification`, and
-- 20260723205801_revoke_ventia_app_system_tables revokes ALL privileges on
-- those from `ventia_app`. That is deliberate and load-bearing: merchant
-- identity must be unreachable from tenant-scoped code. Shopper identity is
-- the opposite kind of thing — it IS tenant data, it is read under RLS by the
-- storefront, and it is scoped per store. Reusing the merchant tables would
-- mean either reopening those grants or leaving the storefront unable to read
-- its own users.
--
-- ## Per store, not per platform
--
-- `ShopperAccount` is unique on (tenantId, email), so the same person shopping
-- at two Ventia stores has two accounts. Each merchant is the *Responsable del
-- Tratamiento* for their own customers (settings/privacy-policy.template.ts
-- says so in every generated policy); a single identity spanning stores would
-- make the platform a controller and would let one merchant infer that their
-- customer also shops with another.

CREATE TYPE "ShopperTokenPurpose" AS ENUM ('verify_email', 'magic_link', 'password_reset');

CREATE TABLE "ShopperAccount" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT,
    "emailVerifiedAt" TIMESTAMP(3),
    "name" TEXT,
    "customerId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ShopperAccount_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ShopperSession" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ShopperSession_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ShopperToken" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "purpose" "ShopperTokenPurpose" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ShopperToken_pkey" PRIMARY KEY ("id")
);

-- Unique WITHIN a tenant, which is the "per store" decision expressed as a
-- constraint rather than as a convention some future write path can forget.
CREATE UNIQUE INDEX "ShopperAccount_tenantId_email_key" ON "ShopperAccount"("tenantId", "email");
-- One account per CRM row: two logins pointing at the same `Customer` would
-- make "my orders" ambiguous and let one shopper's history reach another.
CREATE UNIQUE INDEX "ShopperAccount_customerId_key" ON "ShopperAccount"("customerId");
CREATE INDEX "ShopperAccount_tenantId_idx" ON "ShopperAccount"("tenantId");

-- The lookup key for a presented credential. Globally unique because the hash
-- of a 256-bit random secret is what identifies the row; the tenant scope is
-- then re-checked by RLS, so a token minted for one store cannot be redeemed
-- at another even though the index spans both.
CREATE UNIQUE INDEX "ShopperSession_tokenHash_key" ON "ShopperSession"("tokenHash");
CREATE INDEX "ShopperSession_tenantId_accountId_idx" ON "ShopperSession"("tenantId", "accountId");
-- For the expiry sweep, which scans by deadline across every tenant.
CREATE INDEX "ShopperSession_expiresAt_idx" ON "ShopperSession"("expiresAt");

CREATE UNIQUE INDEX "ShopperToken_tokenHash_key" ON "ShopperToken"("tokenHash");
CREATE INDEX "ShopperToken_tenantId_accountId_purpose_idx" ON "ShopperToken"("tenantId", "accountId", "purpose");
CREATE INDEX "ShopperToken_expiresAt_idx" ON "ShopperToken"("expiresAt");

-- ON DELETE CASCADE on the tenant: a deleted store must not leave live logins
-- behind. SET NULL on the customer: deleting a CRM row (an anonymisation
-- request under Ley 1581, which privacy/ already implements) must not delete
-- the person's ability to sign in and see nothing.
ALTER TABLE "ShopperAccount" ADD CONSTRAINT "ShopperAccount_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ShopperAccount" ADD CONSTRAINT "ShopperAccount_customerId_fkey"
  FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ShopperSession" ADD CONSTRAINT "ShopperSession_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "ShopperAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ShopperToken" ADD CONSTRAINT "ShopperToken_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "ShopperAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
-- 20260723182728_rls left an `ALTER DEFAULT PRIVILEGES ... GRANT SELECT,
-- INSERT, UPDATE, DELETE ON TABLES TO ventia_app`, so a table created later
-- arrives fully writable by tenant-scoped code unless it says otherwise. All
-- three say otherwise. Revoke everything first and grant back only what is
-- genuinely needed — starting from zero means a future change to those default
-- privileges cannot silently widen these tables.
REVOKE ALL PRIVILEGES ON TABLE "ShopperAccount" FROM ventia_app;
REVOKE ALL PRIVILEGES ON TABLE "ShopperSession" FROM ventia_app;
REVOKE ALL PRIVILEGES ON TABLE "ShopperToken" FROM ventia_app;

-- `ShopperAccount`: column-level SELECT that OMITS `passwordHash`, the same
-- tool and the same reason as `WhatsAppNumber.credentialsEnc`
-- (20260818120000). The storefront legitimately reads a shopper's profile
-- under RLS; nothing legitimately reads their credential through a
-- tenant-scoped query. Password verification runs on `platformDb` through one
-- narrow function, so no merchant-facing query can reach a hash even by
-- accident — including a future `findMany()` with no explicit `select`, which
-- will fail loudly with `permission denied` rather than load credentials into
-- application memory.
--
-- Any column added here LATER inherits nothing and must be granted explicitly.
-- That is the safe direction to fail: a forgotten grant is a visible read
-- error, a forgotten revoke is a silent leak.
GRANT SELECT ("id", "tenantId", "email", "emailVerifiedAt", "name", "customerId", "createdAt", "updatedAt")
  ON TABLE "ShopperAccount" TO ventia_app;

-- `ShopperSession` and `ShopperToken` get NOTHING. They hold only credential
-- material and expiry, they are never merchant-facing, and every path that
-- touches them is authentication — which runs on `platformDb` anyway. A table
-- a tenant connection cannot open is one no injected `where` can be tricked
-- into dumping.

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
-- Enabled on all three even though two of them grant `ventia_app` nothing:
-- the grant is the hard stop and the policy is the backstop, exactly as
-- 20260818090000_agent_usage argues. If a future `GRANT ... ON ALL TABLES IN
-- SCHEMA public` ever re-grants these by accident — which is precisely how
-- `Subscription` ended up mis-classified — RLS still bounds the damage to one
-- tenant's own rows instead of every store's logins.
ALTER TABLE "ShopperAccount" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ShopperSession" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ShopperToken" ENABLE ROW LEVEL SECURITY;

-- SELECT-only policies: there is no tenant-scoped write path to any of these.
-- Postgres denies any command with no permissive policy, so an INSERT or
-- UPDATE under this role matches zero rows even if the grants above were
-- mistakenly restored.
CREATE POLICY tenant_isolation_select ON "ShopperAccount"
  FOR SELECT USING ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_select ON "ShopperSession"
  FOR SELECT USING ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_select ON "ShopperToken"
  FOR SELECT USING ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid);
