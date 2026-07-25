# P2b — Cart, Checkout & Orders Backend: Design

**Date:** 2026-07-25
**Source spec:** `docs/SPEC.md` (M4 Cart & Checkout, M6 Orders partial, M10 Notifications partial)
**Status:** Approved
**Builds on:** P2a (public storefront, merged into this branch)

## Goal

A shopper can add products to a cart, complete a single-page checkout (contact →
address → shipping method → COD payment → review), and receive a real order
confirmation email — all without an account. The merchant receives a new-order
alert. No payment gateways (P3), no order-status-transition UI or public
tracking page (P2c), no AI widget (P4).

## Decisions made during brainstorming

1. **P2b/P2c split: P2b = checkout only.** P2b builds cart, checkout, order
   *creation* (`Order`/`OrderItem`/`OrderEvent` writes, not their later
   transitions), and the 3 order-creation-time emails. Merchant status
   transitions (confirm/preparing/shipped/delivered/cancel), their admin UI,
   and the public tracking page/endpoint are P2c's job as one vertical slice
   — matching the task list's own naming.
2. **Cart persists in Postgres**, tenant-scoped like every other domain
   table (RLS + `tenantDb`), keyed by an opaque `cookieKey` cookie — not
   Redis (which stays reserved for the tenant-resolution cache) and not a
   client-only cart (spec requires server-persisted, cookie-keyed, no
   accounts).
3. **All 4 shipping method types + COD department restriction**, per spec's
   M4 AC — not simplified to a subset. This requires a small admin
   settings UI (new "Envíos" tab) since zone-based pricing needs a real way
   to enter a departamento→price table.
4. **Billing-fields toggle (documento/razón social) deferred to backlog.**
   Explicitly optional in spec, no consumer exists before DIAN work (P6+).
   `Order.billingFields Json?` already exists in the schema and stays unused.
5. **Checkout checks current stock and rejects if insufficient, but does
   NOT reserve or decrement it.** Spec's 15-minute reservation TTL is
   described only for online payments (P3, out of scope). For COD (the
   only method here), stock decrements when the merchant confirms — a P2c
   action. P2b's checkout is a point-in-time guard against ordering
   something visibly out of stock, nothing more.

## Architecture

### 0. Data model — mostly already exists

P0's schema already includes `Cart`, `CartItem`, `Customer`, `Order`,
`OrderItem`, `OrderEvent`, `Payment` (all RLS-protected since the P0 RLS
migration's generic tenant-isolation policy already covers them — verified
by reading `packages/db/prisma/migrations/20260723182728_rls/migration.sql`).
`OrderStatus`/`PaymentStatus`/`CartSource` enums already match spec. No new
migration is needed for the core order/cart tables. `Cart.cookieKey` (a
field distinct from `Cart.id`) already anticipates the opaque-cookie
pattern above.

What P2b *does* need to add to the schema: nothing structural — shipping
config lives in `Tenant.settings.shipping` (JSON, same pattern as the
existing `settings.payments`/`settings.storeInfo`), and order numbering
uses `pg_advisory_xact_lock(hashtext(tenantId))` + `MAX(number)+1` inside
the checkout transaction rather than a new counter table.

### 1. Cart API (`services/api/src/checkout/cart.controller.ts`, `.service.ts`)

- A cart guard (mirrors `PublicTenantGuard`'s shape) resolves the tenant
  (404/503 identically to the storefront guard) and separately resolves/
  creates the cart from an httpOnly `cookieKey` cookie — created lazily on
  the first item add, not on a bare `GET`.
- `POST /v1/storefront/cart/items` `{productId, variantId?, qty}` — validates
  the product is `active` and (if given) the variant belongs to it; merges
  quantity into an existing line for the same product+variant. Soft stock
  check here (informational — the hard check is at checkout).
- `PATCH /v1/storefront/cart/items/:id` `{qty}`, `DELETE .../:id`.
- `GET /v1/storefront/cart` — current lines + per-line/cart subtotal and tax
  (reusing the existing price-includes-IVA math from
  `catalog/products.service.ts`), no shipping yet (unknown until an address
  is entered).

### 2. Checkout API (`services/api/src/checkout/checkout.controller.ts`, `.service.ts`)

- `GET /v1/storefront/checkout/shipping-quote?departamento=<code>` — the
  tenant's configured shipping methods with a price computed for that
  departamento (so the storefront can show cost before final submit).
- `POST /v1/storefront/checkout` — single endpoint, one DB transaction:
  1. Re-validate stock for every cart line (reject `INSUFFICIENT_STOCK` if
     any line fails — no partial order).
  2. Validate address (`departamento`/`municipio` pair — reject
     `INVALID_MUNICIPIO` if the municipio doesn't belong to the
     departamento) and the chosen shipping method (reject
     `SHIPPING_METHOD_UNAVAILABLE` if not configured, or if COD is
     departamento-restricted and this departamento isn't in the allowlist).
  3. Compute totals: line subtotal/tax (existing convention) + shipping
     cost from the chosen method.
  4. Allocate the next per-tenant order number
     (`pg_advisory_xact_lock` + `MAX(number)+1`, scoped to this
     transaction only).
  5. Upsert a `Customer` by email/phone; create `Order` (`PENDING`/`COD`)
     + `OrderItem`s (snapshotting name/price/tax-rate, per the existing
     schema) + one `OrderEvent('created')`.
  6. Clear the cart.
- After commit (fire-and-forget, same pattern as P2a's ISR revalidation):
  send order-confirmation + COD-confirmation-request emails to the shopper,
  and a new-order alert to the merchant's contact email. Each attempt
  writes a `NotificationLog` row (existing table) keyed for idempotency;
  full BullMQ retry/backoff (spec's M10 AC) is backlog — introducing a
  queue for 3 fire-and-forget sends isn't justified yet.

### 3. Shipping settings (`services/api/src/settings/`, extended)

- New `shippingSettingsSchema` in `@ventia/core`: an array of configured
  methods (`flat` | `zone` | `free_over` | `pickup`, each with its own
  price fields — a zone method carries a `Record<departamentoCode,
  priceCents>`), plus an optional `codRestrictedDepartamentos: string[]`.
- `PATCH /v1/admin/settings/shipping` (owner-only, mirrors the existing
  payments/theme settings endpoints).
- Admin UI: a new "Envíos" tab in the existing Configuración page
  (alongside Tienda/Marca/Pagos).

### 4. Colombian address (`@ventia/core`)

- New zod schema: nombre completo, teléfono, departamento, municipio,
  dirección, complemento (optional), barrio (optional), notas (optional) —
  no postal code, per spec.
- A static `departamentos`/`municipios` (dependent) dataset, DANE-sourced.
  **Flagging for implementation time** (same convention as P2a's raw-SQL
  Prisma-version caveat): the exact municipio list will be sourced from
  public DANE/DIVIPOLA data during implementation, not fabricated here.

### 5. Mailer (`services/api/src/mailer/`, extended from P1b)

- A `ResendMailer` implementing the existing `Mailer` interface
  (`send(to, subject, body)` or equivalent — matching P1b's shape).
  `RESEND_API_KEY` unset → automatic fallback to the existing
  `ConsoleMailer`, no code change needed later when a real key is added.
- 3 es-CO templates fired at order-creation: order confirmation (shopper),
  COD confirmation request (shopper), new-order alert (merchant's own
  contact email from `settings.storeInfo.contactEmail`).

### 6. Storefront UI (`apps/storefront`)

- Cart drawer (persistent, accessible from every page) + a full `/carrito`
  page — both hitting the cart API above.
- `/checkout` — single page, sectioned (contact → address with
  departamento→municipio dependent dropdown → shipping method with live
  price from the shipping-quote endpoint → review & submit). Client
  component (genuine form state/interactivity, unlike P2a's pages) —
  first client-heavy page in this app; keep JS scope to checkout-essentials
  per spec's own AC ("JavaScript-heavy widget disabled except checkout
  essentials").
- `/checkout/confirmacion/:orderNumber` (or similar) — order number, items,
  total, shipping address (city + departamento only, matching the same
  "never leak full address" posture spec applies to the P2c tracking page).

## Error handling

Typed codes: `CART_EMPTY`, `INSUFFICIENT_STOCK` (per-line), `INVALID_MUNICIPIO`,
`SHIPPING_METHOD_UNAVAILABLE`, plus inherited `TENANT_NOT_FOUND`/
`TENANT_SUSPENDED` from the existing guard. Checkout is one transaction —
any failure rolls back the whole order, never a partial one. Email failures
never fail the checkout response (fire-and-forget, logged).

## Testing

Integration tests (Testcontainers): cart CRUD + cross-tenant isolation
(another tenant's cart never reachable via a guessed cookie), checkout
happy path, stock-insufficient rejection, municipio/departamento mismatch,
each shipping method type's price calculation, COD department restriction,
order-number allocation under concurrent checkouts (no duplicate numbers).
Storefront: vitest for the departamento→municipio filter helper and cart
total formatting. Playwright e2e deferred to P2c's DoD pass (same
precedent as P2a).

## Out of scope for P2b

Payment gateways (P3), order status transitions + their admin UI + public
tracking page (P2c), AI widget (P4), billing-fields toggle (backlog),
BullMQ-based email retry (backlog — logged via `NotificationLog` instead),
WhatsApp notifications (P5).
