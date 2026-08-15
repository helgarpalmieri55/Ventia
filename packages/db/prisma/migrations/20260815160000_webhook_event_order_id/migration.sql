-- The authoritative "which order was this event about" link on
-- "WebhookEvent", written by the webhook handler at the moment it resolves the
-- order (services/api/src/payments/webhooks.controller.ts).
--
-- ## What this replaces
--
-- Until now the link was re-derived AFTER the fact, by re-reading the stored
-- `payload` per provider (the deleted `payment-alerts/webhook-links.ts`). That
-- worked, but it had to know each gateway's body shape, and it could not
-- resolve Mercado Pago at all: MP's delivered notification is `{type,
-- data:{id}}` and carries no order reference, so those alerts fell back to
-- matching `Order.providerRef` — which in turn had to be gated on
-- `providerRefSource = 'verified'`, leaving most MP alerts showing no order.
--
-- The handler already knows the answer with certainty. Recording it removes
-- the guessing, the per-provider knowledge, and the MP gap together.
--
-- ## Why nullable, and why no backfill
--
-- Three kinds of row have no order by construction: `invalid_reference` (the
-- reference never parsed), `order_not_found` (it parsed and matched nothing),
-- and any future tenant-less writer.
--
-- Existing rows stay NULL. Backfilling them would mean running exactly the
-- payload re-derivation this column exists to retire, and writing its guesses
-- into the column that is supposed to be authoritative — a worse outcome than
-- an honest NULL. A pre-existing alert therefore renders as unidentified,
-- still carrying the gateway's own event id, which is what the merchant had
-- to work with anyway.
--
-- ## No foreign key, deliberately
--
-- Same treatment as "InventoryMovement"."orderId". This table is the system's
-- immutable record of what a gateway told us. A FK would let the state of an
-- Order make a WebhookEvent row un-writable, or cascade-delete the evidence
-- that a shopper was charged. The evidence outranks referential tidiness.

ALTER TABLE "WebhookEvent" ADD COLUMN "orderId" UUID;

-- The payment-alerts list resolves a page of events to their orders with a
-- single batched `WHERE id IN (...)` against "Order", so this index is not for
-- that read. It is for the reverse question — "what did the gateway ever tell
-- us about THIS order?" — which is the natural next support query once the
-- link exists, and which would otherwise scan.
CREATE INDEX "WebhookEvent_tenantId_orderId_idx"
  ON "WebhookEvent" ("tenantId", "orderId");
