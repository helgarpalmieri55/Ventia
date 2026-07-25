-- Phase-review amendment: SKU must be unique per tenant (multiple NULLs are
-- still allowed — sku is optional, and Postgres unique indexes treat NULL as
-- distinct from any other NULL). This is what lets products.service.ts's
-- create() discriminate a P2002 on this index from one on the (tenantId,
-- slug) index and return SKU_TAKEN instead of misreporting SLUG_TAKEN.
-- CreateIndex
CREATE UNIQUE INDEX "Product_tenantId_sku_key" ON "Product"("tenantId", "sku");
