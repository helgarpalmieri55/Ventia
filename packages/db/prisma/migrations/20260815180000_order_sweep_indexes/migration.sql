-- Partial indexes for the two background sweeps over "Order".
--
-- Both run platform-wide, on `platformDb`, with NO tenant filter — they are
-- the system's own jobs, not tenant-scoped reads. The only index on this table
-- that could have helped is `("tenantId", status)`, and a query that does not
-- constrain `tenantId` cannot use an index whose leading column it is. So both
-- sweeps were sequential scans of the whole orders table, every run, forever:
-- the stock-expiry sweep every minute and the reconciliation sweep every two.
--
-- That cost grows with TOTAL orders ever placed across every tenant, while the
-- number of rows either sweep actually wants shrinks toward zero as orders
-- settle. In other words the work per run grows without bound precisely
-- because the platform is succeeding.
--
-- ## Why PARTIAL
--
-- The predicate `status = 'PENDING' AND "stockReservedUntil" IS NOT NULL` is
-- true only for online-payment orders inside their 15-minute hold. That is a
-- tiny, self-draining slice: every row leaves it within 15 minutes, by
-- settlement or by expiry. A partial index therefore stays roughly the size of
-- "orders currently mid-payment" no matter how large the table grows, and —
-- because rows leave the predicate — Postgres removes them from the index
-- rather than accumulating dead entries the way a full index on a
-- mostly-irrelevant column would.
--
-- These are raw SQL rather than Prisma `@@index` attributes because the schema
-- DSL cannot express a WHERE clause on an index. Same reason the RLS policies
-- and role grants in earlier migrations are hand-written: what matters here is
-- not expressible in the model.

-- Serves stock-reservation.worker.ts's `expireReservations()`:
--   WHERE "stockReservedUntil" < now() AND status = 'PENDING'
--   ORDER BY "stockReservedUntil" ASC
-- Leading the index on `stockReservedUntil` serves the range predicate and the
-- ordering with one scan, so the newly-bounded sweep (EXPIRE_BATCH_LIMIT) can
-- take its oldest N without sorting the whole candidate set first.
CREATE INDEX "Order_stock_reservation_sweep_idx"
  ON "Order" ("stockReservedUntil")
  WHERE status = 'PENDING' AND "stockReservedUntil" IS NOT NULL;

-- Serves reconciliation.worker.ts's candidate query:
--   WHERE status = 'PENDING' AND "paymentStatus" IN ('PENDING','FAILED')
--     AND "stockReservedUntil" IS NOT NULL AND "createdAt" < cutoff
--   ORDER BY "createdAt" ASC
-- Same partial predicate, keyed on `createdAt` because that is this sweep's
-- range bound and sort key. `paymentStatus` is deliberately NOT in the
-- predicate: it is the one filter of the four that CHANGES while a row sits in
-- the set (PENDING -> FAILED on a declined attempt, and back into
-- reconciliation range), and putting a mutable column in a partial predicate
-- means every such change moves the row out of and back into the index. It
-- stays an ordinary filter applied to the far smaller set this index returns.
CREATE INDEX "Order_reconciliation_sweep_idx"
  ON "Order" ("createdAt")
  WHERE status = 'PENDING' AND "stockReservedUntil" IS NOT NULL;
