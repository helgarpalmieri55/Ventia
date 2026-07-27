# P2c — Order Lifecycle, Admin Orders UI & Public Tracking: Design

**Date:** 2026-07-26
**Source spec:** `docs/SPEC.md` (M6 Orders, M8 Merchant Admin — Orders, M10 Notifications partial)
**Status:** Approved
**Builds on:** P2a (public storefront), P2b (cart, checkout, order creation — merged into this branch)

## Goal

Close out P2's own DoD ("first complete sale: browse → checkout → COD order →
merchant confirms → shipped → delivered, with emails at each step"): the
merchant can see and act on incoming orders from the admin, a shopper can
track their own order's status without an account, and every status
transition sends the right email. No payment gateways (P3 — this phase is
COD-only, matching P2b), no WhatsApp notifications (P5), no BullMQ-based
retry/dead-letter queue (backlog, same deferral P2b already made for
order-creation emails — this phase's transition emails use the identical
fire-and-forget `Mailer` call, not a new queue).

## Decisions made during brainstorming

1. **Status transitions are owner+staff, not owner-only.** M8 doesn't gate
   order actions behind `owner` the way it explicitly does for
   settings/staff/payments-config — day-to-day order fulfillment (confirm,
   pack, ship, deliver) is operational work, matching the existing
   `CATALOG_ITEMS` (products/categories/import) pattern both roles already
   share. Only **cancel** requires an extra confirmation step per spec's
   AC ("cancelling a paid order requires a confirmation step"), enforced
   client-side as a two-step UI action — not a role restriction.
2. **Stock decrements on `CONFIRMED`, restocks on `CANCELLED`.** P2b's
   checkout deliberately left `Product.stock`/`ProductVariant.stock`
   untouched (documented in that phase's design as "a P2c action"). This
   phase adds the actual decrement: when a COD order transitions
   `PENDING → CONFIRMED`, each line's product/variant stock drops by its
   `qty`. Cancelling ANY order still in a pre-`DELIVERED` state (i.e.
   `CONFIRMED`/`PREPARING`/`SHIPPED`) restocks it back. A `PENDING` order
   being cancelled has nothing to restock yet (stock was never
   decremented) — the cancel action still fires (spec doesn't scope
   cancellation to only-after-confirm), it just skips the restock write
   when nothing was ever decremented.
3. **One allowed-transitions state machine, enforced server-side.** Spec
   lists the actions (confirm, mark preparing, mark shipped, mark
   delivered, cancel) but not their exact graph — the natural reading is
   linear (`PENDING → CONFIRMED → PREPARING → SHIPPED → DELIVERED`) plus
   `CANCELLED` reachable from any non-terminal state, and no transition
   possible out of `DELIVERED`/`CANCELLED` (both terminal). Enforced with
   an explicit `ALLOWED_TRANSITIONS: Record<OrderStatus, OrderStatus[]>`
   map in the service layer — not left to the admin UI to only offer valid
   buttons (a direct API call must be rejected server-side regardless of
   what the UI shows), returning a new typed `INVALID_TRANSITION` code.
4. **"Mark shipped" carries carrier + tracking number, free text v1** (per
   spec — no courier API integration yet, that's the unimplemented
   `ShippingProvider` interface mentioned for a later phase). Writes to the
   existing `Shipment` table (`provider`, `trackingNumber`, `status`) —
   already RLS-protected since P0's migration explicitly lists `Shipment`
   in its tenant-isolation array, `raw Json?` stays unused (courier-webhook
   payload, out of scope). One `Shipment` row per order, created on first
   "mark shipped", not one per status change.
5. **Public tracking is a NEW endpoint, not the existing confirmation
   endpoint reused.** `GET /v1/storefront/checkout/confirmacion/:orderNumber`
   (built in P2b Task 9) is intentionally unauthenticated beyond
   `tenantId` + order number match — that's fine for the one moment right
   after a shopper's own checkout redirect, but wrong for a long-lived,
   bookmarkable, guessable-by-sequential-number tracking URL. The new
   `GET /v1/storefront/orders/track?orderNumber=&contact=` endpoint
   requires the caller to also supply the email **or** phone on the order
   (spec: "order number + email or phone must match") before returning
   anything — a mismatch returns the same generic 404 as a nonexistent
   order number, never a distinct "wrong contact" error (which would leak
   that the order number itself is real).
6. **Order-confirmation DTO shape is the template for tracking's DTO too**:
   city + departamento only, never the full street address — P2b's Task 9
   already established this privacy posture for the confirmation page;
   the tracking endpoint reuses the identical restriction plus adds
   `status`, the `OrderEvent` timeline, and (once shipped) carrier +
   tracking number.
7. **Emails fire on every customer-visible transition** (`CONFIRMED`,
   `SHIPPED`, `DELIVERED`) via the same `Mailer`/fire-and-forget pattern
   P2b already built for order-creation — not a new notification
   subsystem. `PREPARING` has no shopper-facing spec-required email
   (spec's M10 template list has no "order preparing" template) and
   `CANCELLED` likewise has none listed — both transitions still write an
   `OrderEvent`, neither sends mail. Reusing `sendOrderEmails`'s existing
   module (`services/api/src/mailer/order-emails.ts`) by adding new
   exported functions there rather than inventing a second mailer entry
   point.

## Architecture

### 0. Data model — no migration needed

`OrderStatus`, `PaymentStatus`, `OrderEvent`, and `Shipment` all already
exist from P0 with the exact shape spec describes (verified directly against
`packages/db/prisma/schema.prisma` and the RLS migration's tenant-isolation
table array, which already includes `Shipment`). This phase writes to
existing tables/enums only.

### 1. Order status transitions (`services/api/src/orders/`, new module)

- `OrdersService.transition(tenantId, orderId, action, payload?)` — one
  entry point for confirm/preparing/shipped/delivered/cancel, all funneled
  through the `ALLOWED_TRANSITIONS` map (decision #3). Runs inside a
  transaction: validates the current status allows the requested
  transition (`INVALID_TRANSITION` if not), applies the stock
  decrement/restock (decision #2), writes the new `Order.status`, creates
  one `OrderEvent` (`type: 'status_changed'`, `actor: 'staff'`, `data:
  {from, to, ...payload}`), and (for "mark shipped") upserts the
  `Shipment` row.
- `PATCH /v1/admin/orders/:id/confirm`, `.../preparing`, `.../shipped`
  (body: `{carrier, trackingNumber}`), `.../delivered`, `.../cancel` (body:
  `{reason}`) — five small, explicit routes rather than one generic
  `PATCH .../status` with an action-in-body, matching this codebase's
  existing convention of one route per distinct admin action (see
  `staff.controller.ts`'s invite/revoke/accept as precedent) over a
  generic verb.
- `GET /v1/admin/orders` (list, status filter, pagination — mirrors
  `products.controller.ts`'s existing list-endpoint shape) and
  `GET /v1/admin/orders/:id` (detail: items, customer, address, shipment,
  full `OrderEvent` timeline) for the admin UI below.
- After a successful `confirm`/`shipped`/`delivered` transition commits
  (fire-and-forget, same pattern as checkout's own post-commit emails):
  send the matching shopper email via `order-emails.ts`'s new
  `sendOrderConfirmedEmail`/`sendOrderShippedEmail`/`sendOrderDeliveredEmail`
  (decision #7).

### 2. Admin orders UI (`apps/admin/app/(app)/pedidos/`, new)

- `/pedidos` — list (status filter, order number, customer, total, date),
  same table/pagination conventions as `apps/admin/app/(app)/productos/page.tsx`.
- `/pedidos/[id]` — detail: items, customer contact, shipping address
  (full address here — this is the merchant's own admin view, not the
  public tracking page, so the "never leak full address" restriction is a
  shopper-facing-surface rule, not an admin one), current status, action
  buttons gated by `ALLOWED_TRANSITIONS` (only the buttons valid from the
  current status render — the server is still the real enforcement,
  per decision #3), a carrier+tracking-number form for "mark shipped", and
  a two-step confirmation for cancel (decision #1).
- `lib/nav.ts` gains a `{ href: '/pedidos', label: 'Pedidos' }` entry in
  `CATALOG_ITEMS` (both roles), not `OWNER_ONLY_ITEMS` (decision #1).

### 3. Public tracking (`apps/storefront/app/rastrear/`, new)

- A form (order number + email-or-phone), submitting to the new
  `GET /v1/storefront/orders/track` endpoint (decision #5) through a thin
  same-origin proxy route mirroring P2b's `/api/cart`/`/api/checkout`
  proxies (this one has no cookie-forwarding need — the endpoint is
  stateless, identity-verified per-request by the submitted contact value
  — but the same-origin proxy shape is kept for consistency and to keep
  `API_INTERNAL_URL` out of client-side code, matching the established
  convention).
- Result view: status (es-CO label per status, e.g. "Confirmado",
  "Preparando", "Enviado", "Entregado", "Cancelado"), a simple timeline
  from the returned `OrderEvent` list, carrier + tracking number once
  shipped, city + departamento (never the full address).
- Linked from the order-confirmation page (P2b Task 9) and a new footer/nav
  link, matching spec's page list (`/rastrear`).

### 4. Notifications (`services/api/src/mailer/order-emails.ts`, extended)

- Three new exported send functions (confirmed/shipped/delivered), each a
  small es-CO template following the exact structure/tone of P2b's
  existing three (order confirmation, COD confirmation, merchant alert) —
  same `formatCOP`/`VNT-` helpers already in that file, no new pattern.
- `sendOrderShippedEmail` includes the carrier + tracking number.
- No `NotificationLog` write, no BullMQ, no idempotency key — same
  explicit deferral P2b already made and documented for its own three
  emails; this phase doesn't reopen that decision, it just adds more
  sends through the identical mechanism.

## Error handling

New typed codes: `INVALID_TRANSITION` (wrong current status for the
requested action), `ORDER_NOT_FOUND` (admin detail/action on a nonexistent
or cross-tenant id — same code the confirmation endpoint already uses).
Public tracking never distinguishes "no such order" from "order exists but
contact doesn't match" — both collapse to a single generic
`ORDER_NOT_FOUND`-shaped empty result, since a distinct error would let an
attacker enumerate valid order numbers.

## Testing

Integration tests (Testcontainers): the full transition graph (every
allowed edge succeeds, every disallowed edge returns `INVALID_TRANSITION`),
stock decrements exactly once on confirm (not again on preparing/shipped/
delivered), restock on cancel from each restockable state, cancel-from-
`PENDING` doesn't double-restock, cross-tenant order id returns
`ORDER_NOT_FOUND` not another tenant's order, public tracking's email-match
and phone-match both work and a wrong contact value returns the same shape
as a nonexistent order number, shipped/delivered/confirmed emails fire
(spy on `ConsoleMailer`, same convention as P2b's checkout test). Storefront/
admin: vitest for the tracking form's client-side shape and the orders
list/detail pages' status-gated button logic. Playwright e2e: **this
phase's DoD pass covers the FULL vertical slice** (both P2b's and P2c's own
testing sections deferred their e2e pass to here) — browse → add to cart →
checkout → confirm (admin) → mark preparing → mark shipped (with tracking
number) → mark delivered → track the order publicly and see the final
status + timeline, through Caddy against the real dev stack, plus the
Lighthouse budget check spec's P2 DoD requires.

## Out of scope for P2c

Payment gateways + their own status transitions (P3), courier API
integration (`ShippingProvider`, unimplemented interface only), WhatsApp
notifications (P5), BullMQ-based email retry/dead-letter + `NotificationLog`
(backlog, deferred from P2b too), DIAN invoicing (P6+), the `get_order_status`
AI tool itself (P4 — this phase only builds the HTTP endpoint/page a future
tool could call, not the tool).
