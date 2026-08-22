-- Let a cart belong to a signed-in shopper.
--
-- The product requirement is that signing in DURING CHECKOUT must not lose the
-- basket. Without this column there is no way to find the cart a shopper left
-- on another device, so "merge" would have nothing to merge and the only
-- honest behaviour would be "keep whatever the cookie points at".
--
-- NULL for every guest cart, which is the common path — guest checkout stays
-- supported (that was an explicit product decision, because requiring an
-- account before a first purchase costs measurable conversion).
ALTER TABLE "Cart" ADD COLUMN "shopperAccountId" UUID;

CREATE INDEX "Cart_tenantId_shopperAccountId_idx" ON "Cart"("tenantId", "shopperAccountId");

-- Deliberately NOT unique on (tenantId, shopperAccountId). A shopper signing
-- in on a second device legitimately produces a second row for an instant, and
-- `CartService.mergeOnSignIn` collapses it. A UNIQUE constraint would turn that
-- ordinary moment into a 500 at the worst point in the funnel.
--
-- ON DELETE SET NULL: deleting an account must not delete the merchant's
-- record of a basket. The cart is the store's data as much as the shopper's,
-- and an order that came out of it still refers to what was in it.
ALTER TABLE "Cart" ADD CONSTRAINT "Cart_shopperAccountId_fkey"
  FOREIGN KEY ("shopperAccountId") REFERENCES "ShopperAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- No GRANT statement needed. `Cart` keeps the standard tenant-table treatment
-- from 20260723182728_rls (table-level SELECT/INSERT/UPDATE/DELETE for
-- ventia_app), and a table-level grant covers columns added later — unlike
-- `AgentUsage` and `ShopperAccount`, where the table grant was replaced by
-- per-column grants and every new column has to be named explicitly.
