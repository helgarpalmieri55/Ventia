# P2c — Order Lifecycle, Admin Orders UI & Public Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close out P2's own DoD — a merchant can see incoming COD orders in
the admin, move them through confirm → preparing → shipped → delivered (or
cancel), a shopper can track their own order's status without an account, and
the right email fires at each customer-visible transition. This is the last
piece before a P2 PR (P2a + P2b + P2c together satisfy spec's P2 phase).

**Architecture:** A new NestJS module `services/api/src/orders/` (status
transitions + admin list/detail, mounted under `/v1/admin/orders/*` behind
`AdminSessionGuard`, no `@Roles()` restriction — owner and staff share it,
same convention as `products.controller.ts`) plus one new public endpoint on
the existing `services/api/src/checkout/` module (`GET
/v1/storefront/orders/track`, since it's a storefront-facing, unauthenticated-
by-account endpoint like everything else already in that module).
`OrderStatus`/`OrderEvent`/`Shipment`/`InventoryMovement` all already exist
from P0 — no schema migration. Stock decrement/restock reuses
`StockController.adjust`'s exact atomic-conditional-`UPDATE` + floor-check +
`InventoryMovement` pattern, run inside the SAME manual-RLS transaction as the
order status write (mirroring `checkout.service.ts`'s established manual-RLS-
transaction shape for multi-row atomic writes). Admin gains a new `/pedidos`
section; storefront gains a new `/rastrear` page. Emails extend P2b's existing
`order-emails.ts` module — same fire-and-forget `Mailer` call, no new queue.

**Tech Stack:** NestJS 10 · Prisma 6 (existing schema, no migration) · Zod
(`@ventia/core`) · Next.js 15 App Router · Vitest + Testcontainers (Postgres,
Redis) · Playwright (this phase's e2e DoD pass covers the FULL P2 vertical
slice, deferred here from both P2a and P2b).

## Global Constraints

- All UI copy es-CO Spanish; code/comments/commits English. TypeScript strict.
  Conventional commits.
- Admin order routes: `AdminSessionGuard`, no `@Roles()` (owner + staff both
  get full access — matches `products.controller.ts`'s existing convention,
  not `settings.controller.ts`'s owner-only one). The public tracking route:
  `PublicTenantGuard` only, same as every other `/v1/storefront/*` route.
- All new domain writes go through `tenantDb(tenantId)` EXCEPT the one
  transaction that needs the atomic conditional-`UPDATE` stock write (manual
  `platformDb.$transaction` + `SET LOCAL ROLE` + tenant GUC, exactly
  `checkout.service.ts`'s and `stock.controller.ts`'s existing pattern — not a
  new one).
- Typed error convention: `{ error: CODE, details? }`. This phase's new codes:
  `INVALID_TRANSITION`, reuse of the existing `ORDER_NOT_FOUND` (from P2b Task
  9) and `STOCK_BELOW_ZERO` (from P1a-7).
- No payment gateways, no courier API integration, no WhatsApp notifications,
  no BullMQ email queue/`NotificationLog`, no DIAN invoicing, no
  `get_order_status` AI tool — all explicit backlog/later-phase per the design
  doc.
- Git identity before commits: `git config user.email noreply@anthropic.com && git config user.name Claude`.
- Verify the exact `stockController.adjust`-style atomic `UPDATE ... RETURNING`
  SQL against the actually-installed Prisma 6.x at implementation time.

---

### Task 1: Order status transitions (`services/api/src/orders/`, new module)

**Files:**
- Create: `services/api/src/orders/orders.module.ts`, `orders.service.ts`,
  `orders.controller.ts`, `transitions.ts` (the `ALLOWED_TRANSITIONS` map, kept
  as its own small file so it's easy to find/audit)
- Modify: `services/api/src/app.module.ts` (register `OrdersModule`)
- Test: `services/api/test/orders-transitions.test.ts`

**Interfaces:**
- `transitions.ts`:
  ```ts
  import type { OrderStatus } from '@ventia/db';
  export type OrderAction = 'confirm' | 'preparing' | 'shipped' | 'delivered' | 'cancel';
  export const ACTION_TARGET_STATUS: Record<OrderAction, OrderStatus> = {
    confirm: 'CONFIRMED', preparing: 'PREPARING', shipped: 'SHIPPED',
    delivered: 'DELIVERED', cancel: 'CANCELLED',
  };
  // Every key is a FROM status; its value is the set of actions valid from
  // there. `cancel` is valid from every non-terminal status; DELIVERED and
  // CANCELLED have none (terminal).
  export const ALLOWED_ACTIONS: Record<OrderStatus, OrderAction[]> = {
    PENDING: ['confirm', 'cancel'],
    CONFIRMED: ['preparing', 'cancel'],
    PREPARING: ['shipped', 'cancel'],
    SHIPPED: ['delivered', 'cancel'],
    DELIVERED: [],
    CANCELLED: [],
  };
  ```
- `orders.service.ts`:
  ```ts
  export interface ShippedPayload { carrier: string; trackingNumber: string; }
  export interface CancelPayload { reason: string; }

  @Injectable()
  export class OrdersService {
    async list(tenantId: string, query: { status?: string; page?: string; pageSize?: string }): Promise<OrderListResult>;
    async findOne(tenantId: string, orderId: string): Promise<OrderDetail>; // 404 ORDER_NOT_FOUND if missing/cross-tenant
    async transition(tenantId: string, orderId: string, action: OrderAction, payload?: ShippedPayload | CancelPayload): Promise<OrderDetail>;
  }
  ```
  `list`/`findOne` mirror `ProductsService`'s existing pagination shape
  (`DEFAULT_PAGE_SIZE = 20`, `MAX_PAGE_SIZE = 100`) exactly — same clamp logic,
  same `{items, total, page, pageSize}` envelope.
- `orders.controller.ts`:
  ```ts
  @Controller('v1/admin/orders')
  @UseGuards(AdminSessionGuard)
  export class OrdersController {
    @Get() list(...)
    @Get(':id') findOne(...)
    @Patch(':id/confirm') confirm(...)
    @Patch(':id/preparing') preparing(...)
    @Patch(':id/shipped') shipped(...)   // body: {carrier, trackingNumber}
    @Patch(':id/delivered') delivered(...)
    @Patch(':id/cancel') cancel(...)     // body: {reason}
  }
  ```
  One route per action (matches `staff.controller.ts`'s existing
  invite/revoke-by-route convention), not a generic `PATCH :id/status` with an
  action field — each route's body validation is specific to that action
  (`shipped` requires both `carrier`/`trackingNumber` non-empty; `cancel`
  requires a non-empty `reason`; `confirm`/`preparing`/`delivered` take no
  body). Hand-rolled body validators, same convention as
  `cart.controller.ts`'s `parseAddItemBody` (no direct `zod` import in this
  package — see that file's doc comment for why).

**`transition`'s exact behavior, inside one manual-RLS `platformDb.$transaction`
(mirroring `checkout.service.ts`'s and `stock.controller.ts`'s existing
pattern — `SET LOCAL ROLE ventia_app` + `set_config('app.tenant_id', ...)`
once, every read/write on `tx` with explicit `tenantId`):**
1. Read the current order (`tx.order.findFirst({where: {id: orderId, tenantId}})`).
   Throw `ORDER_NOT_FOUND` (404) if missing or wrong tenant.
2. Check `ALLOWED_ACTIONS[order.status].includes(action)`. Throw
   `INVALID_TRANSITION` (409 — a real state conflict, not a validation
   failure) with `details: {from: order.status, action}` if not allowed.
3. **`confirm` only:** for each `OrderItem`, run the exact atomic
   `UPDATE "Product"/"ProductVariant" SET stock = stock - qty WHERE id = ... AND "tenantId" = ... AND stock - qty >= 0 RETURNING stock`
   (copy `stock.controller.ts`'s raw-SQL shape, delta = `-item.qty`) and a
   matching `tx.inventoryMovement.create({data: {tenantId, productId,
   variantId, delta: -qty, reason: 'order_confirmed', orderId, actor:
   session.userId}})`. If ANY line's floor check returns 0 rows (would go
   negative), throw `STOCK_BELOW_ZERO` (422, matches P1a-7's existing code)
   with `details: {productId}` — the whole transaction rolls back, no partial
   decrement across lines. `OrderItem.productId`/`variantId` are the columns
   to decrement (NOT `ProductVariant`'s own `id` when `variantId` is null —
   decrement `Product.stock` in that case, matching `checkout.service.ts`'s
   existing `variant ? variant.stock : product.stock` read-side convention).
4. **`cancel` only:** if `order.status` is `CONFIRMED`, `PREPARING`, or
   `SHIPPED` (i.e. stock WAS decremented at some earlier point — `PENDING`
   never was), restock: for each `OrderItem`, the same atomic `UPDATE ...
   SET stock = stock + qty ...` (delta = `+item.qty`, no floor check needed
   for a restock) + `InventoryMovement` (`delta: +qty, reason:
   'order_cancelled', orderId`). Cancelling from `PENDING` skips this step
   entirely (nothing to restock).
5. **`shipped` only:** upsert one `Shipment` row
   (`tx.shipment.upsert({where: {orderId}, ...})` — wait, `Shipment` has no
   unique constraint on `orderId` in the current schema; use
   `tx.shipment.findFirst({where: {orderId, tenantId}})` then create-or-update
   explicitly) with `{provider: carrier, trackingNumber, status: 'shipped'}`.
6. Update `tx.order.update({where: {id: orderId}, data: {status:
   ACTION_TARGET_STATUS[action]}})`.
7. Create one `tx.orderEvent.create({data: {tenantId, orderId, type:
   'status_changed', actor: 'staff', data: {from: order.status, to:
   ACTION_TARGET_STATUS[action], ...payload}}})`.
8. Return the updated order detail (re-read, or assemble from what's already
   in scope — your call, whichever is cleaner).

After the transaction commits (fire-and-forget, outside the transaction,
exactly `checkout.service.ts`'s existing post-commit email pattern): for
`confirm`/`shipped`/`delivered`, call the matching new `sendOrder*Email`
(Task 2). `preparing`/`cancel` send nothing (per the design doc — no
spec-required template for either).

**Tests:** `orders-transitions.test.ts` (Testcontainers) — every edge in
`ALLOWED_ACTIONS` succeeds once from its valid `from` status; every action
NOT listed for a given status returns `409 INVALID_TRANSITION`; confirming
decrements stock by exactly the ordered qty (verify via a direct DB read,
not just the response); confirming twice (first succeeds, second attempt is
now `INVALID_TRANSITION` since status is no longer `PENDING`) does NOT
double-decrement; cancelling from `CONFIRMED`/`PREPARING`/`SHIPPED` restocks
back to the pre-confirm level; cancelling from `PENDING` does NOT touch stock
(assert `InventoryMovement` count for that order is 0); confirm on a line
whose current stock (independently reduced by something else since checkout)
would go negative returns `422 STOCK_BELOW_ZERO` and the WHOLE transaction
rolls back (no partial decrement across multiple lines — seed an order with 2
lines, make only the second line's stock insufficient, assert the FIRST
line's stock is unchanged after the failed confirm); `shipped` requires
`carrier`+`trackingNumber` (400 on missing); a cross-tenant order id on any
action returns `404 ORDER_NOT_FOUND`, never another tenant's data; `list`
pagination/status-filter match `ProductsService`'s existing clamping tests'
shape.

- [ ] RED: write `orders-transitions.test.ts` against not-yet-existing
  `OrdersService`/`OrdersController`
- [ ] Implement `transitions.ts`, `orders.service.ts`, `orders.controller.ts`,
  `orders.module.ts`; register in `app.module.ts`
- [ ] GREEN: all new tests pass; full `pnpm --filter @ventia/api test` still
  green (no regression in `stock.controller.ts`'s own tests — you're copying
  its SQL shape, not modifying it)
- [ ] `pnpm --filter @ventia/api typecheck && pnpm --filter @ventia/api lint`
- [ ] Commit: `feat: add order status transitions with stock decrement/restock`

---

### Task 2: Order-transition emails (`services/api/src/mailer/order-emails.ts`, extended)

**Files:**
- Modify: `services/api/src/mailer/order-emails.ts` (add 3 new exported
  functions), `services/api/src/orders/orders.service.ts` (wire the
  fire-and-forget calls from Task 1's transition method)
- Test: extend `services/api/test/order-emails.test.ts`

**Interfaces:**
```ts
// Same shape/spirit as the existing OrderEmailContext, trimmed to what each
// template actually needs — read the existing sendOrderEmails/
// OrderEmailContext in full before adding these, reuse its formatCOP/VNT-
// helpers rather than re-deriving them.
export interface OrderStatusEmailContext {
  orderNumber: number;
  email: string;
  tenantName: string;
}
export interface OrderShippedEmailContext extends OrderStatusEmailContext {
  carrier: string;
  trackingNumber: string;
}
export async function sendOrderConfirmedEmail(mailer: Mailer, ctx: OrderStatusEmailContext): Promise<void>;
export async function sendOrderShippedEmail(mailer: Mailer, ctx: OrderShippedEmailContext): Promise<void>;
export async function sendOrderDeliveredEmail(mailer: Mailer, ctx: OrderStatusEmailContext): Promise<void>;
```
Each a short es-CO plain-text template (subject includes `VNT-{orderNumber}`
via the same `vnt()` helper already in this file), one `mailer.send(...)` call
each — no merchant-facing alert for these three (unlike order-creation's 3rd
email), since the merchant is the one who just took the action.

**`OrdersService.transition` wiring:** after the transaction commits, for
`action === 'confirm'` call `sendOrderConfirmedEmail(...).catch(console.error)`
(no `await` blocking the response — exact fire-and-forget shape as
`checkout.service.ts`'s existing call); same for `shipped`/`delivered`. You'll
need the tenant's name and the order's email — either already available from
what `transition` read in Task 1, or one more cheap `tx.tenant.findUnique`
read inside the same transaction (matching `checkout.service.ts`'s existing
precedent of reading tenant name for its own emails).

**Tests:** extend `order-emails.test.ts` with 3 new small test cases (one per
function) — recording-mailer double, assert subject contains `VNT-{n}`, assert
the shipped email's body contains the carrier + tracking number. Extend
`orders-transitions.test.ts` (Task 1) with a mailer spy (same
`ConsoleMailer.prototype.send` spy convention as `checkout.test.ts`'s existing
mailer assertion) confirming confirm/shipped/delivered each fire exactly one
email, and preparing/cancel fire none.

- [ ] RED: extend `order-emails.test.ts`
- [ ] Implement the 3 new send functions + wire into `orders.service.ts`
- [ ] GREEN + full api test suite green
- [ ] `pnpm --filter @ventia/api typecheck && lint`
- [ ] Commit: `feat: send confirmed/shipped/delivered order emails`

---

### Task 3: Public order tracking endpoint (`services/api/src/checkout/`, extended)

**Files:**
- Modify: `services/api/src/checkout/checkout.controller.ts` (add
  `GET /v1/storefront/orders/track`) — or a new sibling controller/service if
  you judge `checkout.controller.ts` too crowded already (check its current
  line count first, same judgment call P2b Task 6 made for the admin
  shipping tab)
- Test: `services/api/test/order-tracking.test.ts`

**Interfaces:**
```ts
export interface OrderTrackingDto {
  orderNumber: number;
  status: OrderStatus; // the raw enum — the storefront maps to es-CO labels itself
  createdAt: string;
  items: Array<{ nameSnapshot: string; qty: number; priceCentsSnapshot: number }>;
  totalCents: number;
  shippingCiudad: string;
  shippingDepartamento: string;
  shipment: { carrier: string; trackingNumber: string } | null; // null until shipped
  events: Array<{ type: string; createdAt: string }>; // no `data`/`actor` — internal detail, not shopper-facing
}
```
`GET /v1/storefront/orders/track?orderNumber=1042&contact=shopper@example.com`
(or a phone number in `contact`) — `PublicTenantGuard` only (no cart cookie
needed). Validation: `orderNumber` must parse as a positive integer (same
`Number.isInteger` guard as the existing confirmation route, same reasoning:
a malformed param must not reach Prisma as `NaN`); `contact` required,
non-empty. Query: `tenantDb(tenantId).order.findFirst({where: {tenantId,
number: orderNumber, OR: [{email: contact}, {phone: contact}]}, include:
{items: true, events: {orderBy: {createdAt: 'asc'}}}})` (`Shipment` is a
separate table with no direct relation currently declared on `Order` in
`schema.prisma` — check whether one exists before assuming `include:
{shipment: true}` works; if there's no relation, do a second `findFirst` on
`Shipment` by `orderId`+`tenantId`). Both branches (order genuinely doesn't
exist, and order exists but neither `email` nor `phone` matches `contact`)
return the exact same `404 {error: 'ORDER_NOT_FOUND'}` — do not let a
timing difference or distinct error shape leak which case occurred (an
attacker must not be able to distinguish "guessed a real order number, wrong
contact" from "guessed wrong").

**Tests:** exact order-number + matching email → 200 with the full DTO;
exact order-number + matching phone → 200; matching order-number + WRONG
contact → `404 ORDER_NOT_FOUND` (same shape/status as nonexistent order
number — assert the two responses are byte-identical in shape, only to
prove no side-channel); nonexistent order number → `404 ORDER_NOT_FOUND`;
malformed (non-numeric) `orderNumber` param → `404 ORDER_NOT_FOUND` (not
500); missing `contact` → `400 VALIDATION_FAILED`; before shipping,
`shipment` is `null`; after a `shipped` transition (call the Task 1 endpoint
first in the test), `shipment` carries the carrier/tracking number;
`events` reflects every transition in order; cross-tenant (same order
number exists for a different tenant, queried through THIS tenant's domain)
returns `404` not the other tenant's order.

- [ ] RED: write `order-tracking.test.ts`
- [ ] Implement the endpoint
- [ ] GREEN + full api suite green
- [ ] `pnpm --filter @ventia/api typecheck && lint`
- [ ] Commit: `feat: add public order tracking endpoint`

---

### Task 4: Admin orders UI (`apps/admin/app/(app)/pedidos/`, new)

**Files:**
- Create: `apps/admin/app/(app)/pedidos/page.tsx` (list),
  `apps/admin/app/(app)/pedidos/[id]/page.tsx` (detail),
  `apps/admin/lib/orders-api.ts` (typed client, mirrors the existing
  `products`-page fetch pattern — check `apps/admin/app/(app)/productos/page.tsx`
  for the established list/detail-fetch convention in this app, this is a
  Server Component app unlike the storefront's cart/checkout client islands)
- Modify: `apps/admin/lib/nav.ts` (add `{href: '/pedidos', label: 'Pedidos'}`
  to `CATALOG_ITEMS`, NOT `OWNER_ONLY_ITEMS`)
- Test: `apps/admin/test/nav.test.ts` (extend for the new item),
  `apps/admin/test/orders-status.test.ts` (pure helper: which action buttons
  are valid for a given status — mirror `ALLOWED_ACTIONS` client-side purely
  for UI button-gating, the server is still the real enforcement per the
  design doc)

**UI requirements:**
- `/pedidos`: table (order number as `VNT-{n}`, customer name/email, total via
  `formatCOP`, status badge, date), status filter, pagination — same
  conventions as `apps/admin/app/(app)/productos/page.tsx`.
- `/pedidos/[id]`: items, customer contact, FULL shipping address (this is
  the merchant's own view — not subject to the shopper-facing "never leak
  full address" restriction), current status badge, the full `OrderEvent`
  timeline, action buttons gated by a client-side mirror of `ALLOWED_ACTIONS`
  (only show buttons valid from the current status — still just a UX nicety,
  the server independently rejects an invalid transition regardless), a
  carrier+tracking-number form that appears only for the "mark shipped"
  action, and a two-step "¿Confirmar cancelación?" flow for cancel (a plain
  second click/confirm state, no need for a full modal — your call on the
  simplest correct UI, matching this app's existing minimal-chrome style).
- Same `ApiError`/`fieldErrors`/`errorMessage` handling as every other admin
  page (`lib/errors.ts`) — add `INVALID_TRANSITION` and `STOCK_BELOW_ZERO`
  (if not already present) to `MESSAGES`.

- [ ] Implement `orders-api.ts`, the two pages, nav update
- [ ] `pnpm --filter @ventia/admin build && typecheck && lint`
- [ ] `pnpm --filter @ventia/admin test` (full suite, zero regressions)
- [ ] Commit: `feat: add admin orders list, detail, and status actions`

---

### Task 5: Storefront tracking page (`apps/storefront/app/rastrear/`, new)

**Files:**
- Create: `apps/storefront/app/rastrear/page.tsx` (client component — a form,
  same client-boundary reasoning as P2b's cart/checkout pages),
  `apps/storefront/lib/tracking-api.ts` (typed client, mirrors
  `cart-api.ts`'s `fetchImpl`-injectable style),
  `apps/storefront/app/api/orders/track/route.ts` (same-origin proxy,
  mirrors `app/api/cart/route.ts`'s shape — no cookie-forwarding need here
  since the endpoint is stateless/per-request, but keep the same proxy
  pattern for consistency and to keep `API_INTERNAL_URL` server-side)
- Modify: `apps/storefront/app/checkout/confirmacion/[orderNumber]/page.tsx`
  (add a "Rastrear mi pedido" link to `/rastrear`)
- Test: `apps/storefront/test/tracking-api.test.ts`

**UI requirements:** a small form (order number + email-or-phone), submit →
render the result (es-CO status label — a small `Record<OrderStatus, string>`
map: `PENDING: 'Pendiente', CONFIRMED: 'Confirmado', PREPARING: 'Preparando',
SHIPPED: 'Enviado', DELIVERED: 'Entregado', CANCELLED: 'Cancelado'` — a
simple timeline list from `events`, carrier+tracking once shipped, city +
departamento (never street address), and a clear "no encontramos ese pedido"
message for a 404 (never a distinct message for "wrong contact" vs
"nonexistent", matching the backend's identical-shape posture).

- [ ] Implement the proxy route, `tracking-api.ts`, the page, the
  confirmation-page link
- [ ] `pnpm --filter @ventia/storefront build && typecheck && lint`
- [ ] `pnpm --filter @ventia/storefront test` (full suite, zero regressions)
- [ ] Commit: `feat: add public order tracking page`

---

### Task 6: Wrap-up gate + full P2 Playwright DoD pass + docs

**Files:**
- Create: `apps/admin/e2e/p2-dod.spec.ts` (or extend an existing e2e spec file
  if one already covers this vertical slice's earlier steps — check
  `apps/admin/e2e/` first)
- Modify: `README.md` (document the orders/tracking endpoints, matching the
  existing "Catalog API"/"Onboarding, staff & launch" sections' style)

**Steps:**
- [ ] Full gate: `pnpm turbo run lint typecheck build test` — 21+ build tasks,
  every test suite, zero regressions (retry the storefront build 2-3× if
  Google Fonts fetch flakiness hits, same accepted-risk precedent as every
  prior phase)
- [ ] Playwright e2e covering the FULL vertical slice (deferred here from both
  P2a's and P2b's own testing sections): browse the storefront → add to cart
  → checkout (COD) → in the admin, confirm the order → mark preparing → mark
  shipped (with a tracking number) → mark delivered → on the storefront,
  `/rastrear` the same order by number+email and see status `Entregado` +
  the tracking number + the full timeline. Through Caddy, against the real
  dev stack (`bash scripts/e2e.sh` or extend it if it only boots
  API/admin/storefront for P1's flow — check first).
- [ ] Lighthouse budget check (spec's P2 DoD explicitly requires this,
  deferred by every prior P2 sub-phase) — run against the storefront's home/
  PDP/cart pages, record the numbers in the commit/report; if this repo has
  no existing Lighthouse tooling/budget config, set up the minimal version
  needed to produce a number (e.g. `lighthouse` CLI against the local dev
  server) rather than skipping the AC silently.
- [ ] Manual smoke test beyond what Playwright covers: verify a WRONG-contact
  tracking attempt genuinely shows the generic not-found message (not a
  console error, not a different-looking screen than a genuinely nonexistent
  order number).
- [ ] README updates: document `/v1/admin/orders/*`, `GET
  /v1/storefront/orders/track`, and the `/pedidos`/`/rastrear` pages,
  matching the existing docs' style/section placement.
- [ ] Commit: `docs: P2c wrap-up — order lifecycle, tracking, P2 DoD e2e`

---

### Phase-scoped review

After Task 6, run a dedicated review pass across the WHOLE P2c diff (all 6
tasks' commits together, same structure as P2a's and P2b's own
phase-scoped reviews) — specifically re-checking for the kind of
cross-task interaction gap those two phases' phase-reviews each caught that
no single task's own review could have (P2b's phase review found exactly one
such gap: two requests racing on the SAME cart at checkout). For P2c, the
analogous risk to scrutinize hardest is concurrent/overlapping order-status
transitions on the SAME order (e.g. two admin tabs both clicking "confirm" at
once, or a "confirm" and a "cancel" racing) — Task 1's `ALLOWED_ACTIONS` check
reads `order.status` and re-checks it inside the same transaction, but verify
this is actually safe under Postgres's default read-committed isolation (does
the transaction need an explicit row lock — `SELECT ... FOR UPDATE` — on the
order row it reads in step 1, or does the later `tx.order.update` in step 6
naturally serialize against a concurrent transaction some other way? Don't
assume; reproduce it empirically the way P2b Task 4's review did for the
order-number advisory lock).

Once the phase review's fixes (if any) are in, this branch is ready for the P2
PR (P2a + P2b + P2c together).
