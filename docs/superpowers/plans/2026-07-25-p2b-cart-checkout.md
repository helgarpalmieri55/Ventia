# P2b — Cart, Checkout & Orders Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A guest shopper adds products to a cart, completes a single-page checkout
(contact → Colombian address → shipping method → COD payment → review), and the
resulting order is created transactionally with a real confirmation email sent —
all on top of P2a's public storefront.

**Architecture:** A new NestJS module `services/api/src/checkout/` (cart CRUD +
one checkout endpoint + a shipping-quote endpoint), all mounted under
`/v1/storefront/*` behind `PublicTenantGuard` (P2a) plus a new cart-resolving
guard. Order/Cart/Customer/OrderItem/OrderEvent tables and their RLS policies
already exist from P0 — no schema migration needed for them. Shipping method
config lives in `Tenant.settings.shipping` (same JSON-settings pattern as
`payments`/`storeInfo`). A real `ResendMailer` extends P1b's `Mailer` interface.
Storefront gains a cart drawer/page and the app's first client-heavy page
(checkout).

**Tech Stack:** NestJS 10 · Prisma 6 (existing schema, no migration) · Zod
(`@ventia/core`) · Resend (`resend` npm package) · Next.js 15 App Router
(client components for cart/checkout) · Vitest + Testcontainers (Postgres,
Redis).

## Global Constraints

- All UI copy es-CO Spanish; code/comments/commits English. TypeScript strict.
  Conventional commits.
- Every new endpoint under `/v1/storefront/*` resolves tenant via the existing
  `PublicTenantGuard` (P2a) — 404 for unresolved/draft, 503 for suspended.
- All new domain writes go through `tenantDb(tenantId)` (RLS + app-layer
  scoping) — never `platformDb` for cart/order data (`platformDb` stays
  reserved for genuinely tenant-agnostic writes like `AuditLog`).
- Typed error convention: `{ error: CODE, details? }`, matching every prior
  phase (`VALIDATION_FAILED`, `TENANT_NOT_FOUND`, `TENANT_SUSPENDED`, plus this
  phase's new `CART_EMPTY`, `INSUFFICIENT_STOCK`, `INVALID_MUNICIPIO`,
  `SHIPPING_METHOD_UNAVAILABLE`).
- No payment gateways, no order-status-transition endpoints, no public
  tracking page — those are P2c. No billing-fields toggle, no BullMQ email
  queue — both explicit backlog per the design doc.
- Git identity before commits: `git config user.email noreply@anthropic.com && git config user.name Claude`.
- Verify Prisma raw-SQL/transaction behavior (`pg_advisory_xact_lock` inside a
  Prisma `$transaction`) against the actually-installed Prisma 6.x at
  implementation time — don't transcribe blindly if it behaves differently.

---

### Task 1: Colombian address + shipping schemas (`@ventia/core`)

**Files:**
- Create: `packages/core/src/colombia-locations.ts` (departamento/municipio
  static data), `packages/core/src/address-schemas.ts` (checkout address zod
  schema + departamento/municipio cross-validation), `packages/core/src/shipping-schemas.ts`
  (shipping method config zod schemas)
- Modify: `packages/core/src/index.ts` (export the 3 new modules)
- Test: `packages/core/test/colombia-locations.test.ts`, `packages/core/test/address-schemas.test.ts`, `packages/core/test/shipping-schemas.test.ts`

**Interfaces:**
- `colombia-locations.ts` exports:
  ```ts
  export interface Departamento { code: string; name: string; }
  export interface Municipio { departamentoCode: string; name: string; }
  export const DEPARTAMENTOS: Departamento[];   // all 33 (32 departments + Bogotá D.C.)
  export const MUNICIPIOS: Municipio[];         // DANE/DIVIPOLA-sourced, ~1100 entries
  export function municipiosFor(departamentoCode: string): Municipio[];
  ```
  Source the data from public DANE/DIVIPOLA department+municipality codes
  (each department has a 2-digit code, e.g. `'11'` = Bogotá D.C., `'05'` =
  Antioquia — use the real, standard DIVIPOLA codes, not invented ones).
  `municipiosFor` is a plain `MUNICIPIOS.filter(m => m.departamentoCode === departamentoCode)`.
- `address-schemas.ts` exports:
  ```ts
  export const checkoutAddressSchema = z.object({
    nombreCompleto: z.string().min(2).max(120),
    telefono: z.string().min(7).max(20),
    departamentoCode: z.string(),
    municipioName: z.string(),
    direccion: z.string().min(3).max(200),
    complemento: z.string().max(100).optional(),
    barrio: z.string().max(100).optional(),
    notas: z.string().max(500).optional(),
  }).refine(
    (v) => municipiosFor(v.departamentoCode).some((m) => m.name === v.municipioName),
    { message: 'El municipio no pertenece al departamento seleccionado', path: ['municipioName'] },
  );
  export type CheckoutAddressInput = z.infer<typeof checkoutAddressSchema>;
  ```
- `shipping-schemas.ts` exports:
  ```ts
  export const SHIPPING_METHOD_TYPES = ['flat', 'zone', 'free_over', 'pickup'] as const;
  export type ShippingMethodType = (typeof SHIPPING_METHOD_TYPES)[number];

  export const shippingMethodSchema = z.discriminatedUnion('type', [
    z.object({ id: z.string(), type: z.literal('flat'), label: z.string().min(1).max(60), priceCents: z.number().int().min(0), enabled: z.boolean() }),
    z.object({ id: z.string(), type: z.literal('zone'), label: z.string().min(1).max(60), ratesByDepartamento: z.record(z.string(), z.number().int().min(0)), defaultPriceCents: z.number().int().min(0).optional(), enabled: z.boolean() }),
    z.object({ id: z.string(), type: z.literal('free_over'), label: z.string().min(1).max(60), thresholdCents: z.number().int().min(0), fallbackPriceCents: z.number().int().min(0), enabled: z.boolean() }),
    z.object({ id: z.string(), type: z.literal('pickup'), label: z.string().min(1).max(60), instructions: z.string().max(500).optional(), enabled: z.boolean() }),
  ]);
  export type ShippingMethodInput = z.infer<typeof shippingMethodSchema>;

  export const shippingSettingsSchema = z.object({
    methods: z.array(shippingMethodSchema).max(8),
    codRestrictedDepartamentos: z.array(z.string()).optional(),
  });
  export type ShippingSettingsInput = z.infer<typeof shippingSettingsSchema>;
  ```

**Tests:**
- `colombia-locations.test.ts`: `DEPARTAMENTOS` has exactly 33 entries with
  unique codes; `municipiosFor('11')` (Bogotá D.C.) returns at least one
  entry; `municipiosFor('99')` (nonexistent code) returns `[]`.
- `address-schemas.test.ts`: a valid Bogotá D.C. address passes; a municipio
  from a different departamento than the one given fails with the
  `municipioName` path error; missing `direccion` fails.
- `shipping-schemas.test.ts`: each of the 4 method type shapes parses; an
  unknown `type` value fails; `ratesByDepartamento` with a negative price
  fails.

Steps: RED (all 3 test files, using placeholder imports that don't exist yet)
→ implement `colombia-locations.ts`, `address-schemas.ts`, `shipping-schemas.ts`
→ add exports to `index.ts` → `pnpm --filter @ventia/core test` green →
`pnpm --filter @ventia/core typecheck` green → commit
`feat: add colombian address and shipping method schemas`.

---

### Task 2: Cart API (add/update/remove/get)

**Files:**
- Create: `services/api/src/checkout/checkout.module.ts`,
  `services/api/src/checkout/cart-cookie.guard.ts`,
  `services/api/src/checkout/cart-cookie.decorator.ts`,
  `services/api/src/checkout/cart.service.ts`,
  `services/api/src/checkout/cart.controller.ts`
- Modify: `services/api/src/app.module.ts` (import `CheckoutModule`)
- Test: `services/api/test/cart.test.ts`

**Interfaces:**
- `CartCookieGuard` (mirrors `PublicTenantGuard`'s shape, composed alongside
  it — apply both guards on cart/checkout controllers): reads a `ventia_cart`
  cookie via `req.cookies?.ventia_cart`. **Verified**: this codebase does not
  currently wire Express's `cookie-parser` anywhere (better-auth parses its
  own session cookie internally, not via `req.cookies`) — add
  `cookie-parser` as a new dependency of `services/api/package.json` and
  call `app.use(cookieParser())` in `services/api/src/main.ts`'s
  `createApp()`, before any route registration, so `req.cookies` is
  populated for this guard (and available to any future consumer). If present, looks up `Cart` by `(tenantId, cookieKey)` via
  `tenantDb(tenantId)`; if absent or not found, sets
  `req.cartCookieKey = null` (no cart yet — created lazily by
  `CartService.addItem`, not by this guard). Never creates a `Cart` row
  itself — only `POST cart/items` does that, so a GET-only visit never
  writes to the DB.
- `@CartCookieKey()` param decorator: returns `req.cartCookieKey as string | null`.
- `CartService`:
  ```ts
  export interface CartLineDto {
    id: string; productId: string; variantId: string | null; qty: number;
    name: string; priceCents: number; taxRate: TaxRateValue; lineSubtotalCents: number; lineTaxCents: number;
  }
  export interface CartDto { cookieKey: string | null; lines: CartLineDto[]; subtotalCents: number; taxCents: number; }

  class CartService {
    async getOrEmpty(tenantId: string, cookieKey: string | null): Promise<CartDto>;
    // Returns { cookieKey: newCookieKey, ... } — caller (controller) sets the
    // cookie on the response when cookieKey was null and this creates a cart.
    async addItem(tenantId: string, cookieKey: string | null, productId: string, variantId: string | null, qty: number): Promise<CartDto & { cookieKey: string }>;
    async updateItem(tenantId: string, cookieKey: string, itemId: string, qty: number): Promise<CartDto>;
    async removeItem(tenantId: string, cookieKey: string, itemId: string): Promise<CartDto>;
  }
  ```
  Tax portion per line: `lineTaxCents = lineSubtotalCents - Math.round(lineSubtotalCents / (1 + rateAsDecimal))`,
  where `rateAsDecimal` is `0`/`0.05`/`0.19`/`0` for `excluido` (reuse the
  `TAX_RATE_FROM_DB`-style conversion already established in
  `catalog/products.service.ts`, duplicated locally per this codebase's
  established per-module-copy convention — do not import across modules).
  `addItem` validates the product is `status: 'active'` (404
  `PRODUCT_NOT_FOUND` otherwise) and, if `variantId` given, that the variant
  belongs to that product; merges `qty` into an existing line for the same
  `(productId, variantId)` pair rather than creating a duplicate row.
- `CartController` (`@Controller('v1/storefront/cart')`,
  `@UseGuards(PublicTenantGuard, CartCookieGuard)`):
  - `GET /` → `cartService.getOrEmpty(tenantId, cookieKey)`.
  - `POST /items` `{productId, variantId?, qty}` (qty: positive integer,
    validate inline or via a small zod schema in this file — no need for a
    shared package schema for this one shape) → `addItem`; if the returned
    `cookieKey` differs from the request's (i.e. a cart was just created),
    set it via `res.cookie('ventia_cart', cookieKey, {httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 60 * 60 * 1000})`
    (30-day expiry, matching a typical guest-cart lifetime).
  - `PATCH /items/:id` `{qty}` → `updateItem` (404 if the cookie has no cart
    or the item doesn't belong to it — never let one cart mutate another's
    items even if an id is guessed, `tenantDb`'s scoping plus an explicit
    `cartId` match in the query enforces this).
  - `DELETE /items/:id` → `removeItem`.

**Tests:** integration (Testcontainers) — add item creates a cart + sets
cookie; adding the same product+variant again merges qty instead of
duplicating; adding a draft/archived product's id 404s; adding a variant that
belongs to a *different* product 404s; PATCH/DELETE on an item from tenant
A's cart using tenant B's session context never succeeds (cross-tenant
isolation — the highest-priority test class in this phase, matching the
scrutiny every prior phase gave this); GET with no cookie returns an empty
cart with `cookieKey: null` and creates nothing in the DB (assert via a
direct count query that no `Cart` row exists after a GET-only sequence).

Steps: RED (cart.test.ts against not-yet-existing module) → implement guard/
decorator/service/controller → wire into `app.module.ts` → tests green →
`pnpm --filter @ventia/api typecheck` → commit
`feat: add storefront cart api`.

---

### Task 3: Shipping settings (admin) + shipping-quote endpoint

**Files:**
- Modify: `services/api/src/settings/settings.controller.ts` (add
  `PATCH /shipping`), `services/api/src/settings/settings.controller.ts`'s
  `toResponse` (include `shipping` in the response)
- Create: `services/api/src/checkout/shipping.service.ts`,
  add a `GET /v1/storefront/checkout/shipping-quote` route to
  `services/api/src/checkout/checkout.controller.ts` (created fully in Task 4;
  this task adds one route + the shared `ShippingService` it calls — if
  `checkout.controller.ts` doesn't exist as a file yet when this task runs,
  create it now with just this one route, and Task 4 adds the rest)
- Test: `services/api/test/shipping-settings.test.ts`, `services/api/test/shipping-quote.test.ts`

**Interfaces:**
- `SettingsController.updateShipping` (`@Patch('shipping')`, same
  owner-only/`writeAudit` pattern as `updatePayments`): `parseOr400(shippingSettingsSchema, body)`
  → merge into `settings.shipping` (replace wholesale, like `theme`, not
  merge-in-place — a shipping methods array has no meaningful partial-update
  semantics, same reasoning as `theme`) → `writeAudit(session, 'settings.shipping', ...)`.
  `toResponse` adds `shipping: asRecord(settings.shipping as Prisma.JsonValue | undefined)`
  to its returned object (defaulting to `{ methods: [] }` shape client-side
  when absent).
- `ShippingService`:
  ```ts
  export interface ShippingQuoteLine { id: string; type: ShippingMethodType; label: string; priceCents: number; }
  class ShippingService {
    async quote(tenantId: string, departamentoCode: string): Promise<ShippingQuoteLine[]>;
    async priceFor(tenantId: string, methodId: string, departamentoCode: string, subtotalCents: number): Promise<number>; // throws SHIPPING_METHOD_UNAVAILABLE (HttpException 400) if methodId isn't configured/enabled
    async isCodAllowed(tenantId: string, departamentoCode: string): Promise<boolean>;
  }
  ```
  `quote` reads `tenant.settings.shipping.methods`, filters to `enabled`,
  computes each method's price for the given departamento (`flat` →
  `priceCents`; `zone` → `ratesByDepartamento[departamentoCode] ?? defaultPriceCents`,
  throwing `SHIPPING_METHOD_UNAVAILABLE` if neither exists for that
  departamento; `free_over` → needs `subtotalCents` to decide, so `quote`
  (used for the pre-submit price display) shows `fallbackPriceCents` as a
  placeholder with a `thresholdCents` field alongside it, while `priceFor`
  (used inside checkout, which knows the real subtotal) returns `0` when
  `subtotalCents >= thresholdCents` else `fallbackPriceCents`; `pickup` →
  `0`). `isCodAllowed` returns `true` when `codRestrictedDepartamentos` is
  unset/empty, else checks membership.
- `CheckoutController`'s new route: `GET /v1/storefront/checkout/shipping-quote?departamento=<code>`
  (`@UseGuards(PublicTenantGuard)`, no cart cookie needed for a quote) →
  `shippingService.quote(tenantId, departamento)`; 400 `VALIDATION_FAILED` if
  `departamento` is missing or not a real DANE code (`DEPARTAMENTOS.some(...)`).

**Tests:** `shipping-settings.test.ts` — owner can PATCH, staff gets 403
`FORBIDDEN_ROLE`, invalid method shape 400. `shipping-quote.test.ts` — flat
method returns its fixed price for any departamento; zone method returns the
right price for a configured departamento and `SHIPPING_METHOD_UNAVAILABLE`
for one with no rate and no default; free_over method (via `priceFor`, tested
directly on the service since the quote endpoint can't know cart subtotal)
returns 0 above threshold and the fallback price below it; disabled methods
never appear in `quote`'s results; unconfigured tenant (`settings.shipping`
unset) returns `[]` from `quote`, not a crash.

Steps: RED → implement → tests green → typecheck → commit
`feat: add shipping settings and quote endpoint`.

---

### Task 4: Checkout endpoint (order creation)

**Files:**
- Modify: `services/api/src/checkout/checkout.controller.ts` (add
  `POST /` — the main checkout route)
- Create: `services/api/src/checkout/checkout.service.ts`,
  `services/api/src/checkout/order-number.ts`
- Test: `services/api/test/checkout.test.ts`

**Interfaces:**
- `order-number.ts`:
  ```ts
  export async function nextOrderNumber(tx: Prisma.TransactionClient, tenantId: string): Promise<number> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${tenantId}))`;
    const result = await tx.$queryRaw<{ max: number | null }[]>`SELECT MAX("number") as max FROM "Order" WHERE "tenantId" = ${tenantId}::uuid`;
    return (result[0]?.max ?? 0) + 1;
  }
  ```
  Called from inside `CheckoutService.checkout`'s `$transaction` callback,
  using the same manual `SET LOCAL ROLE ventia_app` + `set_config('app.tenant_id', ...)`
  escape pattern already established for raw SQL elsewhere in this codebase
  (`services/api/src/storefront/products.service.ts`'s `list()`) — copy that
  exact pattern here since `tenantDb`'s extension blocks raw queries.
- `CheckoutService.checkout(tenantId: string, cartCookieKey: string, input: CheckoutInput): Promise<CheckoutResult>` where:
  ```ts
  export interface CheckoutInput {
    email: string; phone: string;
    address: CheckoutAddressInput; // from @ventia/core, already validated by the controller via parseOr400
    shippingMethodId: string;
    paymentMethod: 'cod';
  }
  export interface CheckoutResult { orderNumber: number; totalCents: number; }
  ```
  Steps inside one `platformDb.$transaction`-wrapped, RLS-escaped block (same
  pattern as `order-number.ts` above):
  1. Load the cart by `(tenantId, cookieKey)`; throw `CART_EMPTY` (400) if
     missing or has zero lines.
  2. For each line, re-fetch the product/variant's current stock; throw
     `INSUFFICIENT_STOCK` (400, `details: {productId, available}`) if
     `trackInventory && stock < qty` for any line — abort the whole
     transaction on the first failure (no partial order).
  3. Validate `paymentMethod === 'cod'` is allowed for
     `input.address.departamentoCode` via `shippingService.isCodAllowed` —
     `SHIPPING_METHOD_UNAVAILABLE` (400) if not.
  4. Compute `shippingCents` via `shippingService.priceFor(tenantId, input.shippingMethodId, departamentoCode, subtotalCents)`.
  5. Compute `subtotalCents`/`taxCents` by summing each line's
     `lineSubtotalCents`/`lineTaxCents` (same per-line math as `CartService`,
     duplicated locally per this codebase's established per-module-copy
     convention).
  6. `nextOrderNumber(tx, tenantId)`.
  7. Upsert `Customer` by `(tenantId, email)` — if none matches, create with
     `phone`/`email`/`name: input.address.nombreCompleto`; if one matches,
     leave its fields alone (only `ordersCount`/`totalSpentCents` get bumped,
     by a plain `increment`).
  8. Create `Order` (`status: 'PENDING'`, `paymentStatus: 'COD'`,
     `email`, `phone`, `shippingAddress: input.address as Prisma.InputJsonValue`,
     `shippingMethod: input.shippingMethodId`, `shippingCents`, `subtotalCents`,
     `taxCents`, `totalCents: subtotalCents + taxCents + shippingCents`,
     `source: 'web'`) + one `OrderItem` per cart line (snapshotting
     `nameSnapshot`/`priceCentsSnapshot`/`taxRateSnapshot`/`qty` — never a
     live FK-only reference, so a later product edit/deletion never changes
     a placed order's historical record) + one `OrderEvent`
     (`type: 'created'`, `actor: 'shopper'`).
  9. Delete the `Cart` (cascade deletes its `CartItem`s via the existing
     `onDelete: Cascade`).
  10. Return `{orderNumber, totalCents}`.
  After the transaction commits (fire-and-forget, not awaited, wrapped in its
  own `.catch(console.error)`): call a new `services/api/src/mailer/order-emails.ts`
  (Task 5) to send the 3 order-creation emails.
- `CheckoutController.checkout` (`POST /v1/storefront/checkout`,
  `@UseGuards(PublicTenantGuard, CartCookieGuard)`): `parseOr400` the body
  against a schema combining `checkoutAddressSchema` (nested under
  `address`) with `email`/`phone`/`shippingMethodId`/`paymentMethod` (define
  this combined schema inline in the controller file or as a small local
  const — it's controller-specific request shape, not a `@ventia/core`
  concern); 400 `CART_EMPTY` if no cart cookie at all (skip calling the
  service). On success, clear the `ventia_cart` cookie (`res.clearCookie(...)`)
  and return `201` with the `CheckoutResult`.

**Tests:** integration — full happy path (cart with 2 lines → checkout →
`Order`+2 `OrderItem`s+1 `OrderEvent` created, `Cart` gone, correct
`totalCents` math incl. tax and shipping); insufficient stock on one line
rejects the whole order (assert zero `Order` rows created — no partial
commit); COD-restricted departamento rejects; unconfigured shipping method
id rejects; two concurrent checkouts for the same tenant get sequential,
non-colliding order numbers (spawn both via `Promise.all`, assert the
resulting `number`s differ and there's no `(tenantId, number)` unique
violation); a second checkout for the same email updates the existing
`Customer`'s `ordersCount` rather than creating a duplicate `Customer` row.

Steps: RED → implement `order-number.ts` → implement `CheckoutService` →
wire `CheckoutController.checkout` → tests green → typecheck → commit
`feat: add checkout endpoint with order creation`.

---

### Task 5: Real Resend mailer + order-creation emails

**Files:**
- Create: `services/api/src/mailer/resend-mailer.ts`,
  `services/api/src/mailer/order-emails.ts`
- Modify: `services/api/src/mailer/mailer.module.ts` (provide `ResendMailer`
  when `RESEND_API_KEY` is set, else `ConsoleMailer` — same DI token
  `MAILER`, decided once at module-init time from env), `packages/core/src/env.ts`
  (add `RESEND_API_KEY: z.string().min(1).optional()`, `RESEND_FROM_EMAIL: z.string().email().default('pedidos@ventia.localhost')`),
  `services/api/src/checkout/checkout.service.ts` (call `sendOrderEmails`
  after the transaction commits, per Task 4's note)
- Test: `services/api/test/resend-mailer.test.ts`, `services/api/test/order-emails.test.ts`

**Interfaces:**
- `resend-mailer.ts`:
  ```ts
  import { Resend } from 'resend';
  export class ResendMailer implements Mailer {
    constructor(private readonly client: Resend, private readonly fromEmail: string) {}
    async send(msg: MailMessage): Promise<void> {
      await this.client.emails.send({ from: this.fromEmail, to: msg.to, subject: msg.subject, text: msg.text, html: msg.html });
    }
  }
  ```
  Add `resend` as a dependency of `services/api/package.json`.
- `mailer.module.ts`: change the static `useClass: ConsoleMailer` provider to
  a factory:
  ```ts
  providers: [{
    provide: MAILER,
    useFactory: () => {
      const env = loadEnv();
      return env.RESEND_API_KEY ? new ResendMailer(new Resend(env.RESEND_API_KEY), env.RESEND_FROM_EMAIL) : new ConsoleMailer();
    },
  }],
  ```
- `order-emails.ts`:
  ```ts
  export interface OrderEmailContext {
    orderNumber: number; email: string; phone: string; totalCents: number;
    items: Array<{ nameSnapshot: string; qty: number; priceCentsSnapshot: number }>;
    shippingAddress: { departamentoName: string; municipioName: string };
    merchantContactEmail: string | null; tenantName: string;
  }
  export async function sendOrderEmails(mailer: Mailer, ctx: OrderEmailContext): Promise<void>;
  ```
  Sends 3 messages via the injected `mailer` (never constructs its own
  Mailer — always takes one in, so tests can pass a recording double, same
  convention as every other `Mailer` consumer in this codebase):
  1. To `ctx.email` — subject `Confirmación de tu pedido #VNT-{orderNumber} — {tenantName}`,
     es-CO body listing items/qty/total.
  2. To `ctx.email` — subject `Tu pedido contra entrega #VNT-{orderNumber}`,
     es-CO body explaining the merchant will call/WhatsApp to confirm before
     shipping (this is the "COD confirmation request" template from spec's
     M10).
  3. To `ctx.merchantContactEmail` (skip entirely — don't call `mailer.send`
     — if `null`, e.g. the merchant never set `storeInfo.contactEmail`) —
     subject `Nuevo pedido #VNT-{orderNumber}`, es-CO body with the order
     total and shopper contact info.
  Order numbers are always rendered with the `VNT-` prefix (spec's "never
  expose raw UUIDs... e.g. VNT-1042") — this is the one place in P2b that
  formats it that way; the DB column stays a plain `Int`.
- `CheckoutService.checkout` (Task 4) constructs an `OrderEmailContext` from
  the just-created order + the tenant's `settings.storeInfo.contactEmail`
  and calls `sendOrderEmails(this.mailer, ctx).catch((err) => console.error('[checkout] order email failed', err))`
  — never awaited by the HTTP response path, per the design's fire-and-forget
  decision. `CheckoutService` gets `@Inject(MAILER) private readonly mailer: Mailer`
  in its constructor.

**Tests:** `resend-mailer.test.ts` — mocks the `Resend` client's `emails.send`,
asserts `ResendMailer.send` calls it with the right shape; a thrown error from
the client propagates (this method itself doesn't swallow errors — the
fire-and-forget `.catch` at the call site is what prevents it from breaking
checkout, not this class). `order-emails.test.ts` — a recording `Mailer`
double receives exactly 2 calls when `merchantContactEmail` is null, 3 when
it's set; both shopper emails include the `VNT-` prefixed order number and
the correct total; asserts the es-CO subject lines verbatim.

Steps: RED → implement `ResendMailer`/`order-emails.ts` → wire the module
factory and env vars → wire the call site in `checkout.service.ts` → tests
green (mock `Resend`, don't hit the real network in tests) → typecheck →
commit `feat: add resend mailer and order-creation emails`.

---

### Task 6: Admin shipping settings UI ("Envíos" tab)

**Files:**
- Modify: `apps/admin/app/(app)/configuracion/page.tsx` (add a 4th tab)
- Create: `apps/admin/lib/shipping-form.ts` (form-state helpers, mirroring
  `lib/theme-form.ts`'s pattern), `apps/admin/components/shipping-tab.tsx`
  (or inline in `page.tsx` if that stays under a reasonable size — this
  codebase's convention has been to keep `configuracion/page.tsx` holding
  all tabs inline; check its current line count before deciding, and split
  out a component only if adding this tab would make the file unwieldy)
- Test: `apps/admin/test/shipping-form.test.ts`

**Interfaces:**
- `shipping-form.ts`:
  ```ts
  import type { ShippingMethodInput, ShippingSettingsInput } from '@ventia/core';
  export interface ShippingFormState { methods: ShippingMethodInput[]; codRestrictedDepartamentos: string[]; }
  export const DEFAULT_SHIPPING_FORM: ShippingFormState = { methods: [], codRestrictedDepartamentos: [] };
  export function shippingToFormState(shipping: Record<string, unknown> | undefined): ShippingFormState; // defensive parse, same posture as themeToFormState — unknown/malformed input never crashes the settings page, falls back to DEFAULT_SHIPPING_FORM per-field
  export function newFlatMethod(): ShippingMethodInput; // { id: crypto.randomUUID(), type: 'flat', label: '', priceCents: 0, enabled: true } — used by an "add method" button
  ```
- `SettingsResponse` interface in `configuracion/page.tsx` gains
  `shipping: Record<string, unknown>` (matching Task 3's `toResponse`
  addition).
- New tab UI: a list of configured methods (each rendered per its `type`
  with the relevant fields — label + price for flat, label + a small
  departamento→price table for zone using `DEPARTAMENTOS` from
  `@ventia/core`, label + threshold + fallback price for free_over, label +
  instructions for pickup), an "add method" control per type, remove-method
  buttons, and a multi-select (or checkbox list) of departamentos for
  `codRestrictedDepartamentos` (empty = unrestricted, matching the backend's
  semantics). Save button `PATCH`es `/v1/admin/settings/shipping` via
  `apiFetch`, same success/error pattern as the existing Marca/Pagos tabs
  (`ApiError`/`errorMessage`/`fieldErrors` from `lib/errors.ts`).

**Tests:** `shipping-form.test.ts` — `shippingToFormState` on `undefined`/`{}`
returns `DEFAULT_SHIPPING_FORM`; on a valid saved shape returns it unchanged;
on a malformed `methods` (not an array) falls back to `[]` rather than
throwing; `newFlatMethod()` returns a valid `ShippingMethodInput` shape
(schema-parseable via `shippingMethodSchema.safeParse`).

Steps: RED (`shipping-form.test.ts`) → implement `shipping-form.ts` → add the
tab to `configuracion/page.tsx` (extracting a component if the file has grown
past a few hundred lines — check first) → `pnpm --filter admin build && pnpm --filter admin typecheck` →
commit `feat: add shipping settings tab to admin configuracion`.

---

### Task 7: Storefront cart UI (drawer + page)

**Files:**
- Create: `apps/storefront/lib/cart-api.ts` (typed client for the Task 2
  endpoints, same shape as `lib/storefront-api.ts`'s `fetchStorefront`/
  `fetchStorefrontOrNull` — cart calls always need `credentials: 'include'`
  since they rely on the `ventia_cart` cookie, unlike the read-only
  storefront calls), `apps/storefront/components/cart-drawer.tsx` (client
  component — first client component in this app), `apps/storefront/app/carrito/page.tsx`
- Modify: `apps/storefront/app/layout.tsx` (mount `<CartDrawer>` so it's
  available on every page), `apps/storefront/components/product-card.tsx` /
  `apps/storefront/app/productos/[slug]/page.tsx` (wire the PDP's "Agregar al
  carrito" button — currently permanently `disabled` per P2a's design note
  "P2b wires it" — to actually call the cart API; this is the one place P2a
  deliberately left inert specifically for this task to complete)
- Test: `apps/storefront/test/cart-api.test.ts`

**Interfaces:**
- `cart-api.ts`:
  ```ts
  export interface CartLine { id: string; productId: string; variantId: string | null; qty: number; name: string; priceCents: number; lineSubtotalCents: number; lineTaxCents: number; }
  export interface Cart { lines: CartLine[]; subtotalCents: number; taxCents: number; }
  export async function fetchCart(apiUrl: string, tenantHost: string): Promise<Cart>;
  export async function addCartItem(apiUrl: string, tenantHost: string, productId: string, variantId: string | null, qty: number): Promise<Cart>;
  export async function updateCartItem(apiUrl: string, tenantHost: string, itemId: string, qty: number): Promise<Cart>;
  export async function removeCartItem(apiUrl: string, tenantHost: string, itemId: string): Promise<Cart>;
  ```
  Each issues `fetch(`${apiUrl}/v1/storefront/cart...`, {headers: {'x-tenant-domain': tenantHost}, credentials: 'include', ...})`
  — the cart cookie set by the API on `addCartItem`'s response must be
  forwarded back to the browser; since these are client-side fetches (not
  server-component fetches like the rest of this app), the browser handles
  the `Set-Cookie` natively as long as the request goes through the same
  origin the browser is on. Route these calls through the storefront's own
  domain via a thin Next.js Route Handler proxy (`apps/storefront/app/api/cart/[...path]/route.ts`)
  that forwards to `API_INTERNAL_URL` with the `x-tenant-domain` header set
  from the incoming request's own `Host` — this avoids a cross-origin cookie
  problem (the browser is on `{tenant}.ventia.localhost`, the API is on
  `api.ventia.localhost`; a cookie set directly by the API wouldn't be
  readable by later calls from the storefront's own origin). Mirrors the
  existing `apps/storefront/app/api/revalidate/route.ts`'s proxy shape.
- `CartDrawer`: `'use client'`, holds cart state via `useState`+`useEffect`
  (fetch on mount), exposes an `openCartDrawer()`/quantity-badge affordance
  other components can trigger — simplest correct approach for this task is
  a small client-side context (`apps/storefront/lib/cart-context.tsx`,
  `CartProvider`/`useCart()`) wrapping `{children}` in `layout.tsx`, so the
  PDP's add-to-cart button and the drawer share the same cart state without
  prop-drilling. Keep this to the minimum needed (cart contents + qty +
  add/update/remove actions) — no broader client-state library.
- PDP's "Agregar al carrito" button becomes a small `'use client'` island
  (the rest of the PDP stays a Server Component — only this button + its
  variant-selection state needs to be interactive now that it's wired up)
  calling `useCart().addItem(productId, selectedVariantId, 1)`; disabled
  again (not permanently, just while `!inStock`) when `inStock === false`.

**Tests:** `cart-api.test.ts` — same mocked-`fetch` unit-test style as
`lib/storefront-api.ts`'s existing tests; each function calls the right
proxy path with the right body/credentials option.

Steps: RED → implement `cart-api.ts` → implement the Route Handler proxy →
implement `CartProvider`/`useCart` → implement `CartDrawer` + `/carrito` page
→ wire the PDP button → `pnpm --filter storefront build && typecheck && lint` →
manual check against the dev stack (add an item, see the drawer update, reload
the page, confirm the cart persists via the cookie) → commit
`feat: add storefront cart drawer, page, and pdp wiring`.

---

### Task 8: Storefront checkout page

**Files:**
- Create: `apps/storefront/app/checkout/page.tsx` (`'use client'` — the
  app's first fully client-driven page, per the design's "checkout
  essentials only" JS-scope note), `apps/storefront/lib/checkout-api.ts`
  (client for the Task 3/4 endpoints, same proxy-route approach as Task 7's
  `cart-api.ts` — extend the same `app/api/cart/[...path]/route.ts` proxy or
  add a sibling `app/api/checkout/[...path]/route.ts`, whichever keeps the
  route-handler code simplest; a single shared proxy handling both `/cart/*`
  and `/checkout/*` under one catch-all is fine if it stays simple)
- Test: `apps/storefront/test/checkout-form.test.ts`

**Interfaces:**
- `checkout-api.ts`:
  ```ts
  export async function fetchShippingQuote(apiUrl: string, tenantHost: string, departamentoCode: string): Promise<Array<{id: string; type: string; label: string; priceCents: number}>>;
  export async function submitCheckout(apiUrl: string, tenantHost: string, input: CheckoutFormInput): Promise<{orderNumber: number; totalCents: number}>; // throws a typed error on 400 (CART_EMPTY/INSUFFICIENT_STOCK/INVALID_MUNICIPIO/SHIPPING_METHOD_UNAVAILABLE/VALIDATION_FAILED), same ApiError-style shape convention as apps/admin/lib/api.ts's apiFetch
  ```
- A pure `apps/storefront/lib/checkout-form.ts` helper (unit-tested, unlike
  page-local logic elsewhere in this app — this one is genuinely
  non-trivial): `municipioOptionsFor(departamentoCode: string): {value: string; label: string}[]`
  wrapping `@ventia/core`'s `municipiosFor`, and
  `validateCheckoutStep(step: 'contact' | 'address' | 'shipping', state: CheckoutFormState): Record<string, string>`
  (field → es-CO error message map, empty object = valid) for inline
  client-side validation before hitting the server (the server's own
  `checkoutAddressSchema` validation is still the real gate — this is just
  UX, matching the spec's checkout AC about rejecting bad municipio/
  departamento pairs before submit, not only after).
- The page itself: sectioned single-page form (contact → address, with a
  departamento `<select>` driving a dependent municipio `<select>` via
  `municipioOptionsFor` → shipping method, fetched via `fetchShippingQuote`
  once a departamento is chosen, rendered as radio options with live price →
  review, showing cart contents from `useCart()` (Task 7's context) + the
  chosen shipping price → a submit button calling `submitCheckout`).
  `paymentMethod` is hardcoded to `'cod'` (only option — no UI needed to
  choose it, though the review section should show "Pago: contra entrega"
  as a label so the shopper isn't confused about what they're agreeing to).
  On success, `router.push('/checkout/confirmacion/' + orderNumber)` (Task 9)
  and clear the local cart state.

**Tests:** `checkout-form.test.ts` — `municipioOptionsFor` returns entries
only for the given departamento; `validateCheckoutStep('contact', ...)`
flags a missing email/phone; `validateCheckoutStep('address', ...)` flags a
missing dirección; a fully valid state for each step returns `{}`.

Steps: RED → implement `checkout-form.ts` (pure helpers first) → implement
`checkout-api.ts` → implement the page → `pnpm --filter storefront build && typecheck && lint` →
manual check against the dev stack (full checkout with a seeded live tenant
that has a shipping method configured, confirm an `Order` row appears and
the console/Resend-sandbox mailer logs the 3 emails) → commit
`feat: add storefront checkout page`.

---

### Task 9: Order confirmation page

**Files:**
- Create: `apps/storefront/app/checkout/confirmacion/[orderNumber]/page.tsx`
- Modify: `services/api/src/checkout/checkout.controller.ts` (add
  `GET /v1/storefront/checkout/confirmacion/:orderNumber` — a narrow,
  intentionally minimal read endpoint; NOT the full order-detail shape P2c's
  tracking page will need, just enough for a post-checkout confirmation
  screen)
- Test: `services/api/test/checkout-confirmation.test.ts`

**Interfaces:**
- `CheckoutController`'s new route (`@UseGuards(PublicTenantGuard)`, no cart
  cookie needed — this is a plain lookup by order number, publicly
  reachable since order numbers alone reveal nothing sensitive and the spec
  itself treats `VNT-1042`-style numbers as shareable): looks up
  `Order.findFirst({ where: { tenantId, number: orderNumber } })`
  (via `tenantDb`) plus its `items`; 404 `ORDER_NOT_FOUND` if absent.
  Returns a narrow DTO:
  ```ts
  export interface OrderConfirmationDto {
    orderNumber: number; totalCents: number; createdAt: string;
    items: Array<{ nameSnapshot: string; qty: number; priceCentsSnapshot: number }>;
    shippingCiudad: string; shippingDepartamento: string; // city + departamento ONLY, never the full address — same "never leak full address" posture the design doc calls out for the future P2c tracking page, applied here too since this DTO shape sets the precedent
  }
  ```
- Storefront page: server component, fetches via `fetchStorefront` (plain,
  not `OrNull` — a missing order should genuinely 404, matching the PDP's
  established convention), renders order number (`VNT-{orderNumber}`
  formatted client-side same as the email), item list, total (`formatCOP`),
  and a "revisa tu correo" note pointing at the email just sent.

**Tests:** integration — a real order's confirmation is fetched correctly;
a nonexistent order number 404s; a DIFFERENT tenant's order number (same
number, different tenant) 404s (cross-tenant isolation, same rigor as every
other endpoint this phase); the returned shape never includes `direccion`/
`complemento`/`barrio`/`telefono`/`email` (assert the response object's keys
directly, not just that the rendered page doesn't show them — this is the
kind of contract that should be enforced at the DTO level, not the UI level).

Steps: RED → implement the controller route → implement the storefront page
→ `pnpm --filter @ventia/api typecheck` + `pnpm --filter storefront build && typecheck` →
manual check (complete a real checkout, land on the confirmation page,
confirm no full address leaks in the rendered HTML) → commit
`feat: add order confirmation page`.

---

### Task 10: P2b wrap-up — full gate + manual smoke + docs

**Files:**
- Modify: `README.md` (≤ 12 lines: cart/checkout endpoints note,
  `RESEND_API_KEY`/`RESEND_FROM_EMAIL` env vars, a line noting the storefront
  build now needs a Docker-reachable API for cart cookie round-trips during
  manual testing — no change to the Prerequisites/network-dependency note
  from P2a)

**Steps:**
- [ ] Run `pnpm turbo run lint typecheck build` + `pnpm turbo run test` — green.
- [ ] Manual smoke against the dev stack, seeded live tenant with a
      configured flat-rate shipping method and 2+ active products: browse →
      add to cart (drawer updates) → `/carrito` page → `/checkout` (fill
      contact/address with a real departamento+municipio pair, pick the
      shipping method, submit) → confirmation page shows correct total →
      grep the API's console-mailer log (or a configured Resend sandbox) for
      the 3 emails → confirm the `Order`/`OrderItem`/`OrderEvent`/`Customer`
      rows exist via a scratch Prisma script → confirm the product's `stock`
      column is UNCHANGED after checkout (per this phase's explicit
      no-decrement-at-checkout decision — this is the one behavior most
      worth double-checking live, since "should stock have changed?" is an
      easy thing to get backwards).
  - [ ] Confirm a second checkout attempt against a since-sold-out product
        (flip its stock to 0 via a scratch script between add-to-cart and
        checkout) is rejected with `INSUFFICIENT_STOCK`, not silently
        accepted.
  - [ ] Confirm a COD-restricted departamento (configure one via the admin
        Envíos tab) is rejected at checkout for that departamento and
        accepted for others.
- [ ] README update + commit `docs: document cart/checkout endpoints and resend env vars`.

---

## Self-Review Notes

- **Spec coverage:** M4's full AC is covered (COD purchase possible,
  departamento/municipio validation, all 4 shipping method types, COD zone
  restriction) except the 15-minute stock-reservation-release AC, which is
  explicitly online-payment-only (P3, not built here) per this phase's own
  scoping decision — recorded in the design doc, not a silent gap. M6's
  order creation half is covered (number format, `OrderEvent` timeline
  seeded with one `created` event, `Order`/`Customer`/`OrderItem` writes);
  its status-transition half is explicitly P2c. M10's 3 order-creation
  templates are covered; the other 4 templates and BullMQ retry are
  explicitly P2c/backlog.
- **Known judgment calls:** cart cookie proxy via a Next.js Route Handler
  (Task 7) rather than direct browser→API calls — necessary because the
  cart cookie must be readable from the storefront's own origin, not the
  API's; documented inline in Task 7 rather than left implicit. Billing
  fields and BullMQ email retry are deferred per the design doc, not
  silently dropped.
- **Type consistency:** `CartDto`/`CartLineDto` (Task 2) are what Task 7's
  `cart-api.ts` client types mirror field-for-field; `CheckoutInput`/
  `CheckoutResult` (Task 4) are what Task 8's `checkout-api.ts` mirrors;
  `OrderConfirmationDto` (Task 9) is deliberately narrower than either —
  checked for drift risk and found none, since each storefront client type
  is defined independently per this app's established no-shared-DTO
  convention (matching P2a's precedent) rather than imported from the API.
- **Cross-tenant isolation** gets an explicit test in every task that
  touches a new writable table (cart items in Task 2, orders in Task 4,
  order confirmation in Task 9) — matching the priority this concern was
  given in every prior phase's review.
