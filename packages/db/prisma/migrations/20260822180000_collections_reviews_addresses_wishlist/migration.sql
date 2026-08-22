-- Four features that the design shows and the shopper-accounts decision
-- unblocked: curated collections, product reviews, saved addresses, wishlist.
--
-- One migration because they land together and share one review of the RLS and
-- grant posture, which is the part worth getting right in one sitting rather
-- than four.

CREATE TYPE "ReviewStatus" AS ENUM ('published', 'hidden');

CREATE TABLE "Collection" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "descriptionMd" TEXT NOT NULL DEFAULT '',
    "position" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Collection_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CollectionProduct" (
    "tenantId" UUID NOT NULL,
    "collectionId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "CollectionProduct_pkey" PRIMARY KEY ("collectionId", "productId")
);

CREATE TABLE "Review" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "rating" INTEGER NOT NULL,
    "title" TEXT,
    "bodyMd" TEXT NOT NULL DEFAULT '',
    "status" "ReviewStatus" NOT NULL DEFAULT 'published',
    "replyMd" TEXT,
    "repliedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Review_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ShopperAddress" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "label" TEXT,
    "address" JSONB NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ShopperAddress_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WishlistItem" (
    "tenantId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WishlistItem_pkey" PRIMARY KEY ("accountId", "productId")
);

-- A rating outside 1..5 would quietly skew every average a shopper reads, and
-- an average is the one number on a product page nobody re-derives by eye.
-- Enforced here as well as in Zod because a CHECK is the only layer a future
-- import script, admin tool or hand-written UPDATE cannot route around.
ALTER TABLE "Review" ADD CONSTRAINT "Review_rating_range" CHECK ("rating" BETWEEN 1 AND 5);

CREATE UNIQUE INDEX "Collection_tenantId_slug_key" ON "Collection"("tenantId", "slug");
CREATE INDEX "Collection_tenantId_isActive_idx" ON "Collection"("tenantId", "isActive");
CREATE INDEX "CollectionProduct_tenantId_collectionId_position_idx"
  ON "CollectionProduct"("tenantId", "collectionId", "position");

-- One review per shopper per product. The rule that makes review bombing cost
-- a purchase each time rather than a loop.
CREATE UNIQUE INDEX "Review_tenantId_productId_accountId_key" ON "Review"("tenantId", "productId", "accountId");
CREATE INDEX "Review_tenantId_productId_status_idx" ON "Review"("tenantId", "productId", "status");

CREATE INDEX "ShopperAddress_tenantId_accountId_idx" ON "ShopperAddress"("tenantId", "accountId");
CREATE INDEX "WishlistItem_tenantId_accountId_createdAt_idx"
  ON "WishlistItem"("tenantId", "accountId", "createdAt");

-- At most ONE default address per shopper, as a PARTIAL unique index.
--
-- Prisma cannot express this, so it is written by hand — and it is worth the
-- hand-writing: "which address does checkout pre-fill" must not have two
-- answers, and the application-layer version of this rule (clear the old
-- default, then set the new one) is a check-then-act that two tabs can
-- interleave. The index is what actually holds.
CREATE UNIQUE INDEX "ShopperAddress_one_default_per_account"
  ON "ShopperAddress"("accountId") WHERE "isDefault";

ALTER TABLE "Collection" ADD CONSTRAINT "Collection_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CollectionProduct" ADD CONSTRAINT "CollectionProduct_collectionId_fkey"
  FOREIGN KEY ("collectionId") REFERENCES "Collection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CollectionProduct" ADD CONSTRAINT "CollectionProduct_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Review" ADD CONSTRAINT "Review_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Review" ADD CONSTRAINT "Review_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Review" ADD CONSTRAINT "Review_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "ShopperAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- CASCADE from the order too: an order deleted under a data-erasure request
-- must not leave a review claiming a purchase that no longer exists.
ALTER TABLE "Review" ADD CONSTRAINT "Review_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ShopperAddress" ADD CONSTRAINT "ShopperAddress_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "ShopperAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WishlistItem" ADD CONSTRAINT "WishlistItem_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "ShopperAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WishlistItem" ADD CONSTRAINT "WishlistItem_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Privileges and row-level security
-- ---------------------------------------------------------------------------
-- All five are ordinary tenant tables: the merchant owns collections and
-- moderates reviews, and the storefront writes reviews, addresses and wishlist
-- rows on behalf of a signed-in shopper — all of that runs through
-- `tenantDb()`. So unlike `ShopperSession`/`ShopperToken` (credential material,
-- no grants at all) these keep the standard SELECT/INSERT/UPDATE/DELETE that
-- 20260723182728_rls's ALTER DEFAULT PRIVILEGES already grants a new table.
--
-- Nothing here is a credential and nothing here is an enforcement input, which
-- is what the narrower postures elsewhere in this schema exist to protect.
--
-- What RLS does NOT give us, stated so nobody assumes otherwise: it isolates by
-- TENANT, not by shopper. One shopper reading another shopper's saved address
-- inside the same store is prevented by the application filtering on the
-- account id from the session — the same way the order-history route already
-- works. The database cannot help there, because both rows legitimately belong
-- to the same tenant.
ALTER TABLE "Collection" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CollectionProduct" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Review" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ShopperAddress" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WishlistItem" ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "Collection"
  USING ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON "CollectionProduct"
  USING ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON "Review"
  USING ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON "ShopperAddress"
  USING ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON "WishlistItem"
  USING ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = nullif(current_setting('app.tenant_id', true), '')::uuid);
