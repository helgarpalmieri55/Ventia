# Ventia

Multi-tenant e-commerce platform with an AI sales agent, built as a Turborepo monorepo.
See [`docs/SPEC.md`](docs/SPEC.md) for the full product/technical spec and build-phase roadmap.

## Repository layout

```
apps/
  storefront/       Next.js 15 — public, tenant-aware storefront
  admin/            Next.js 15 — merchant admin (placeholder in P0)
services/
  api/              NestJS — platform API (health, tenant resolution, auth)
packages/
  core/             Shared env/domain types, PaymentProvider interface
  payments/         Payment provider scaffolding (Phase 2+)
  db/               Prisma schema, migrations, tenant-scoped client, seed script
  ui/               Shared UI package (scaffold)
docker/             Dev stack: Postgres (pgvector), Redis, Caddy
```

## Prerequisites

- Node.js >= 22.12 (the built API's CJS output requires ESM dependencies via `require(esm)`,
  stable only from 22.12 onward — pinned in the root `package.json`'s `engines` field)
- pnpm 9.15.0, via [corepack](https://nodejs.org/api/corepack.html) (pinned in `package.json`'s
  `packageManager` field — run `corepack enable` once if `pnpm` isn't already on your PATH)
- Docker (for the dev stack, and for running the `db`/`api` test suites, which use
  [Testcontainers](https://testcontainers.com/) against the local Docker daemon)
- Network access to `fonts.googleapis.com`/`fonts.gstatic.com` when building `apps/storefront`:
  it loads the tenant theme's font pairs via `next/font/google` (`apps/storefront/lib/fonts.ts`),
  which fetches font files at build time and fails the build if unreachable — the only build-time
  network dependency in this repo; an airgapped CI runner must allow it.

## Quickstart

```bash
# 1. Environment
cp .env.example .env

# 2. Dev stack: Postgres + Redis + Caddy
docker compose -f docker/compose.yaml up -d

# 3. Install dependencies
pnpm install

# 3b. Generate the Prisma client (migrate:deploy below does NOT generate it —
#     a fresh clone's typecheck/build/dev will fail without this step)
pnpm --filter @ventia/db generate

# 4. Apply migrations
DATABASE_URL=postgresql://ventia:ventia@localhost:5432/ventia \
  pnpm --filter @ventia/db migrate:deploy
# (or `pnpm --filter @ventia/db migrate:dev` in a fresh dev DB)

# 5. Seed two demo tenants (idempotent)
DATABASE_URL=postgresql://ventia:ventia@localhost:5432/ventia \
  pnpm --filter @ventia/db seed

# 6. Run the services (each in its own terminal)
DATABASE_URL=postgresql://ventia:ventia@localhost:5432/ventia \
REDIS_URL=redis://localhost:6379 \
AUTH_SECRET=dev-secret-change-me \
  pnpm --filter @ventia/api dev            # http://localhost:4000

pnpm --filter @ventia/storefront dev       # http://localhost:3000
pnpm --filter @ventia/admin dev            # http://localhost:3001
```

Caddy (started by the dev stack in step 2) fronts the API and storefront on port 80 for
`*.ventia.localhost`, so once everything above is running you can hit the platform through its
real tenant-resolving domains — see the verification checks below.

## Verifying the stack (tenant resolution end to end)

With the dev stack, API, and storefront running:

```bash
# Known tenant resolves via the API
curl -s -H "x-tenant-domain: demo-moda.ventia.localhost" http://api.ventia.localhost/v1/tenant

# Unknown host returns 404 TENANT_NOT_FOUND
curl -s -i -H "x-tenant-domain: unknown.ventia.localhost" http://api.ventia.localhost/v1/tenant

# Storefront renders the tenant matching its subdomain
curl -s http://demo-moda.ventia.localhost/
curl -s http://demo-tech.ventia.localhost/

# Root domain renders the platform landing page
curl -s http://ventia.localhost/
```

**Tenant resolution note:** the storefront resolves the visitor's tenant by calling the API
internally. Node's built-in `fetch` (undici) ignores a caller-set `Host` header, so this internal
call forwards the tenant's domain via an `x-tenant-domain` header instead — the API's tenant
middleware reads `x-tenant-domain` first and falls back to `Host` for direct callers (curl,
browsers). See
[`docs/superpowers/specs/2026-07-23-p0-foundation-design.md`](docs/superpowers/specs/2026-07-23-p0-foundation-design.md)
for the full rationale.

## Development

```bash
pnpm turbo run lint typecheck build   # static checks + build, all packages
pnpm turbo run test                   # unit/integration tests, all packages (needs Docker)
```

The `db` and `api` test suites use Testcontainers and spin up throwaway Postgres containers on the
local Docker daemon — no manual DB setup is required to run them, only a running Docker daemon.

The dev stack (`docker/compose.yaml`) also runs MinIO (S3-compatible storage) for product images,
on ports `9000` (S3 API) and `9001` (web console, login `ventia` / `ventia-secret`). The API reads
`S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`, and `S3_PUBLIC_URL` (see
`.env.example`) to talk to it.

### Catalog API

The `/v1/admin/*` endpoints (products, categories, variants, images, stock) provide the merchant
catalog CRUD, plus bulk CSV import at `/v1/admin/import/{template,dry-run,commit}` — fetch a
starter file from `GET /v1/admin/import/template`.

The public `/v1/storefront/*` endpoints (categories, product list/detail, content) mirror that
pattern for the storefront: no auth, tenant-scoped via the same `x-tenant-domain`/`Host`
resolution. Admin mutations trigger on-demand ISR revalidation on the storefront via
`REVALIDATE_SECRET` and `STOREFRONT_INTERNAL_URL` (see `services/api/src/storefront/revalidate.ts`
and `apps/storefront/app/api/revalidate/route.ts`).

### Cart, checkout & orders

`/v1/storefront/cart` (get/add/update/remove) and `/v1/storefront/checkout` (shipping quote,
order creation, confirmation lookup) are guest-cart endpoints keyed on a `ventia_cart` cookie —
the storefront never calls these directly (its browser can't reach the API's internal host, and a
cross-origin `Set-Cookie` wouldn't be readable back from its own domain), instead proxying through
`apps/storefront/app/api/{cart,checkout}/[[...path]]/route.ts`. `paymentMethod` is `cod`, `wompi`
(P3a), or `mercadopago`/`epayco` (P3b — see the Payments section below). For `cod`, checkout never
touches `Product.stock` — stock is decremented on the `confirm` transition below (`PENDING` →
`CONFIRMED`), not at order-creation time, and restocked on `cancel` from any status that had already
decremented it. `confirm` is **COD-only** and the API enforces it: an order with a `paymentProvider`
whose `paymentStatus` is still `PENDING` is rejected with `409 ONLINE_PAYMENT_PENDING`, because its
stock was already decremented at checkout and confirming it by hand double-decremented and stranded
it (the admin UI hides the button for those orders too). For any online provider (`wompi`/`mercadopago`/`epayco`), stock IS decremented
immediately at order-creation time (an online-payment order's stock "reservation" *is* the real
decrement, reusing the same primitive) and restocked on `cancel` or by the TTL-expiry worker if the
shopper never completes payment; see
`services/api/src/orders/orders.service.ts`'s `adjustStockLine` and
`services/api/src/checkout/checkout.service.ts`. Manually exercising the cart/checkout flow (add →
drawer → `/carrito` → `/checkout`) needs the API reachable from wherever the storefront dev server
runs, since the proxy route calls it directly.

### Order lifecycle & tracking

`GET`/`PATCH /v1/admin/orders*` (list, detail, and one `PATCH` route per action — `confirm`,
`preparing`, `shipped`, `delivered`, `cancel`) drive the order state machine (`PENDING` →
`CONFIRMED` → `PREPARING` → `SHIPPED` → `DELIVERED`, with `cancel` reachable from every
non-terminal status — see `services/api/src/orders/transitions.ts`'s `ALLOWED_ACTIONS`). Every
transition is serialized per-order under a Postgres advisory lock (`pg_advisory_xact_lock`) so two
concurrent requests on the same order (two admin tabs, a double-click) can't both win a race
against `ALLOWED_ACTIONS`; an invalid transition is `409 INVALID_TRANSITION`. `shipped` requires a
`carrier`/`trackingNumber` body; `cancel` requires a `reason`. Both are operational actions shared
by `owner` and `staff` (no `@Roles()` gate), driven from the admin app's `/pedidos` (list + filter
by status) and `/pedidos/:id` (detail, timeline, and action buttons) pages.

Shoppers track their own order via `GET /v1/storefront/orders/track?orderNumber=&contact=`
(no auth) on the storefront's `/rastrear` page — `contact` must match the order's `email` or
`phone`. A nonexistent order number and a real order number with the WRONG contact deliberately
return the identical `404 ORDER_NOT_FOUND` (same code path, not just the same status) — order
numbers are sequential and guessable, so this endpoint must not let an attacker distinguish
"guessed a real number" from "guessed wrong" by contact-checking after an existence check.

### Payments (Wompi, Mercado Pago, ePayco) — P3a/P3b/P3c

Online payments now cover **three gateways** end to end: admin credential UI, encrypted storage,
checkout redirect, and webhook confirmation — **Wompi** (P3a), Colombia's hosted "Web Checkout";
**Mercado Pago** (P3b), whose `createCheckoutSession` makes a real server-side "Checkout Pro"
preference-creation HTTP call (unlike Wompi's locally-signed redirect URL) against a single API
host (`api.mercadopago.com`) shared by sandbox and production — `cfg.sandbox` only picks which
field of that one response to read (`sandbox_init_point` vs `init_point`); and **ePayco** (P3b),
whose real checkout is a client-side JS widget rather than a plain redirect URL — its
`createCheckoutSession` returns a redirect to this codebase's own storefront `/pago/epayco` bridge
page (`apps/storefront/app/pago/epayco/`), which opens the widget with a server-created session id.
All three share the same provider-registry/webhook-controller/stock-reservation plumbing
(`services/api/src/payments/`) — a shopper's `paymentMethod` is `cod`, `wompi`, `mercadopago`, or
`epayco`.

- **`PAYMENTS_ENCRYPTION_KEY`** (see `.env.example`) is a required env var for any environment that
  saves or reads payment-provider credentials: a base64-encoded 32-byte AES-256-GCM key (generate
  one with `openssl rand -base64 32`). Every provider's private key / integrity secret / events
  secret are encrypted with it before being persisted to
  `Tenant.settings.payments.providers.<provider>` (the `publicKey` is stored in cleartext — none of
  the three providers' public keys are secrets, and Wompi's/Mercado Pago's is meant to appear in a
  client-visible checkout redirect URL); the plaintext is only ever decrypted in-memory, at the
  moment a real provider call needs it — never returned in any API response. ePayco additionally
  needs `epaycoCustomerId` (its merchant-account id, `P_CUST_ID_CLIENTE`, half of its webhook
  signature formula alongside `eventsSecret`/`P_KEY`) — the one provider-specific extra field on
  top of the shared shape. See `services/api/src/payments/encryption.ts` and `payments.service.ts`.
- Merchants configure credentials via the admin's `/configuracion` page
  (`PATCH /v1/admin/settings/payments`) and can test the saved connection with
  `POST /v1/admin/settings/payments/:provider/test-connection`.
- **`POST /webhooks/payments/:provider/:tenantId`** is the payment-gateway webhook receiver
  (`services/api/src/payments/webhooks.controller.ts`) — a **machine-to-machine endpoint the
  gateway is configured to call out-of-band** (at credential-save time), never something a
  browser or an admin session hits. It carries no session/tenant-header resolution of its own; the
  tenant comes straight from the URL path segment. Signature verification (each provider's own
  `verifyAndParseWebhook` — Wompi's SHA-256 checksum, Mercado Pago's HMAC-SHA256 `x-signature`
  manifest, ePayco's `^`-joined SHA-256 formula) needs the exact original request bytes, so this
  route is exempted from the API's global JSON body-parser in favor of a path-scoped raw-body
  middleware (see `services/api/src/main.ts`) — this matters even for ePayco, whose real
  confirmation POST is `application/x-www-form-urlencoded`, not JSON, unlike the other two. A
  verified `APPROVED`/`approved`/`Aceptada` event transitions the order to `CONFIRMED`/`PAID` and
  clears its stock reservation — but **only if the event's amount equals the order's total**: that
  check is unconditional, runs for all three providers before any settlement, and is what
  neutralizes both ePayco's unsigned status/order fields (its documented signature formula covers
  neither) and Wompi's undelimited checksum concatenation (adjacent numeric fields alias, so one
  genuine checksum also validates a re-split naming a different amount and a different order). A
  mismatch is recorded with `result: 'amount_mismatch'` and acknowledged `200` — retrying could
  never change the outcome, and a 4xx would only invite gateway retry storms. Idempotency is
  enforced by `WebhookEvent`'s `@@unique([provider, tenantId, eventId])` constraint —
  **tenant-scoped**, because two tenants sharing one gateway merchant account share its webhook
  secret, so one delivery verifies at both endpoints — and a conflict short-circuits only when the
  existing row was actually processed, so a delivery whose processing threw is reprocessed by the
  gateway's retry rather than swallowed. Replaying the identical webhook any number of times
  returns `200` every time but only ever transitions the order once. **Deviation from
  `docs/SPEC.md`:** webhooks are processed inline, not "through a queue, never inline" as M5
  requires — recorded in that bullet in `docs/SPEC.md`, still open work.
- **Payment-status reconciliation (P3c)** catches payments whose webhook never arrived.
  `services/api/src/payments/reconciliation.worker.ts` is a BullMQ repeatable job (started from
  `main.ts`'s real-boot block, alongside the stock-reservation worker) that every **2 minutes**
  sweeps every tenant's online-payment orders still `PENDING`/`PENDING` with a live
  `stockReservedUntil` and **older than 5 minutes**, and re-asks the gateway's own authenticated
  API. Both thresholds sit deliberately *below* the existing 15-minute stock-reservation TTL, so
  an order gets ~5 reconciliation attempts before the expiry worker would ever cancel and restock
  it — not the spec's draft-time "30 min", which would arrive *after* that worker had already
  fired (design decision 4 in
  `docs/superpowers/specs/2026-07-30-p3c-payment-reconciliation-design.md`). It looks a
  transaction up either by `Order.providerRef` (stamped by `markPaid`/`markFailed`
  from a signature-verified webhook, or planted by Wompi's redirect return: `redirect-url` →
  `/pago/wompi-retorno/:orderNumber?id=` → `PATCH
  /v1/storefront/checkout/:orderNumber/provider-ref-hint`, which writes *only* `providerRef` and
  its `providerRefSource` provenance marker, never `paymentStatus`/`status`) or, for Mercado Pago
  only, by our own order number via
  `searchByReference` (`GET /v1/payments/search?external_reference=`). **Before settling
  anything it runs an order-binding check**: the reference — and, where the provider supplies an
  amount, the amount *and* its currency (`COP`) — read out of the *gateway's own response* must
  equal the order's `number` / `totalCents`; a mismatch, or a reference the adapter couldn't read,
  settles nothing in either direction, and the worker then falls back to `searchByReference` where
  the provider has one (so a planted bogus ref can no longer suppress Mercado Pago's self-healing).
  A binding check is **not** an account check: `Order.providerRefSource` records whether a ref came
  from a verified webhook or from the unauthenticated hint endpoint, and a hint-sourced ref is only
  ever looked up by id for providers whose lookup is merchant-account-scoped (Mercado Pago's private
  access token). Wompi's lookup authenticates with the *public* key and was observed answering with
  no credential at all, and ePayco's takes none — so for those two a hinted ref settles nothing. That check is what makes the deliberately
  unauthenticated hint endpoint safe, and must not be "optimized away": without it, a shopper who
  plants a real, genuinely-paid transaction id from their own past purchase onto someone else's
  `PENDING` order would get a truthful "yes, paid" from the gateway and a free order. The job
  only ever calls the existing `markPaid`/`markFailed`; it never expires, cancels or restocks
  anything itself.

### Onboarding, staff & launch

A signed-up user provisions their tenant via `POST /v1/admin/onboarding/tenant`, then drives the
wizard with `GET`/`PATCH /v1/admin/onboarding` (steps: `store_info`, `branding`, `products`,
`payments`). `POST /v1/admin/launch` (owner-only) flips the tenant to `live` once the checklist —
store info, verified email, an active product, payments — is complete, else `422
LAUNCH_CHECKLIST_INCOMPLETE`. Owners invite staff via `POST /v1/admin/staff/invites`; the invitee
accepts with `POST /v1/staff/accept`. Staff share `/v1/admin/products` etc. with owners but get
`403 FORBIDDEN_ROLE` on `/v1/admin/settings`, `/v1/admin/staff/*`, and `/v1/admin/launch`.

**Mailer:** dev/test use a console transport (`ConsoleMailer`) that logs `[mail] to=... subject=...`
plus the body — including verification, staff-invite, and order-confirmation links — to stdout
instead of sending real email; grep the API's dev log for the token/URL when testing these flows
locally. Setting `RESEND_API_KEY` (plus optionally `RESEND_FROM_EMAIL`, see `.env.example`) switches
every environment sharing that API process to sending real email via
[Resend](https://resend.com) instead.

### P1 Definition-of-Done e2e

Prerequisites: dev stack up + DB migrated (Quickstart steps 2–4). Then, from the repo root:
`bash scripts/e2e.sh` — boots API/admin/storefront, runs the Playwright suite
(`apps/admin/e2e/p1-dod.spec.ts`) through Caddy, tears servers down after. Local-run only, not
part of `pnpm turbo run test`/CI.

### P2 Definition-of-Done e2e

Same prerequisites and runner as P1's suite above — `bash scripts/e2e.sh` runs every spec under
`apps/admin/e2e/` (no file filter), so it picks up `apps/admin/e2e/p2-dod.spec.ts` automatically
alongside `p1-dod.spec.ts` in the same invocation; no separate command or script change was needed
to wire it in. `p2-dod.spec.ts` covers the full P2 vertical slice in one flow: storefront browsing
→ add to cart → `/carrito` → COD `/checkout` → admin `/pedidos` fulfillment (confirm → preparing →
shipped, with a carrier/tracking number → delivered) → `/rastrear` showing the delivered status,
carrier/tracking number, and full timeline — plus asserting a wrong-contact tracking lookup on that
same real order renders the byte-for-byte identical message a nonexistent order number would. It
seeds its tenant/product/shipping configuration directly via `@ventia/db`'s `platformDb` (a real
signup still runs through `/registro` for a genuine session cookie) rather than re-driving the
whole P1 onboarding wizard, which `p1-dod.spec.ts` already covers on its own.

### Lighthouse budget check

`bash scripts/lighthouse.sh` runs the `lighthouse` CLI (via `npx`, no new permanent dependency,
reusing the Chromium already preinstalled for Playwright) against the seeded `demo-moda` tenant's
home page, one PDP, and `/carrito` — same "check, don't start, the dev stack" posture and
prerequisites as the e2e scripts above (also needs `pnpm --filter @ventia/db seed` to have run at
least once). Latest run, against the Next.js **dev** server (unminified, no production
optimizations — a floor, not a production number; re-run against `next build && next start` for a
representative one):

| Page      | Performance | Accessibility | Best Practices | SEO |
| --------- | ----------- | -------------- | --------------- | --- |
| Home      | 54          | 100             | 96               | 91  |
| PDP       | 57          | 100             | 96               | 91  |
| `/carrito`| 46          | 100             | 96               | 91  |

## Deviations

- **Suspended storefront returns 200, not 503 — closed in P2a.** `apps/storefront/middleware.ts`
  now fetches `/v1/tenant` ahead of the route tree and returns a real HTTP 503 for a suspended
  tenant (the App Router still has no way for a page component to set a non-200 status, so the
  check lives in middleware instead). Archived products also now 404 on their PDP URL
  (`services/api/src/storefront/products.service.ts`'s `detail()` only queries `status: 'active'`).

## Production notes

- **`ADMIN_URL` is required in any real deployment.** It's used both as better-auth's
  `trustedOrigins` entry (`services/api/src/admin/admin.module.ts`) and as the destination for
  the staff-invite and email-verification links (`services/api/src/staff/staff.service.ts`,
  `services/api/src/auth/auth.ts`). Leaving it unset falls back to the dev default
  (`http://admin.ventia.localhost`); in a real deployment where the admin app is served from a
  different origin, every sign-in fails with `403 INVALID_ORIGIN` until `ADMIN_URL` is set to that
  origin.

## CI

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on every push to `main` and on every
pull request: install (frozen lockfile) → generate the Prisma client → `lint`, `typecheck`,
`build` → `test`, all via Turborepo. It runs on `ubuntu-latest`, which ships a Docker daemon, so
the Testcontainers-based `db`/`api` suites run unmodified in CI.

## Phase status

Build phases per [`docs/SPEC.md` §11](docs/SPEC.md#11-build-phases-claude-code-roadmap):

- **P0 — Foundation** ✅ (this branch): monorepo scaffold, Docker Compose dev env, Prisma schema
  v1 + migrations, RLS harness + tenant-scoped client, better-auth, tenant resolution middleware,
  CI. DoD: two seeded tenants resolve by subdomain; cross-tenant reads fail under RLS; CI green.
- **P1 — Catalog + Admin core** ✅: onboarding wizard, products/variants/categories CRUD, CSV
  import, image uploads to MinIO/S3, staff roles + invites, launch checklist. DoD: a
  non-technical tester creates a store with 10 products from a CSV without help.
- **P2 — Storefront + Cart + Checkout (COD end-to-end)** ✅: themed public storefront with
  search, cart, Colombian-address checkout, shipping methods, COD orders + emails at every step
  (confirmation, COD confirmation, merchant alert, confirmed/shipped/delivered), admin order
  fulfillment, public order tracking. DoD: first complete sale — browse → checkout → COD order →
  merchant confirms → shipped → delivered, with emails at each step — verified end to end via
  `apps/admin/e2e/p2-dod.spec.ts`; Lighthouse budget recorded (see `scripts/lighthouse.sh`).
- **P3 — Online Payments + Order lifecycle** ✅ (P3a + P3b + P3c, all three in): encrypted
  per-tenant credential storage (`PAYMENTS_ENCRYPTION_KEY`, AES-256-GCM) behind a
  provider-registry abstraction; three gateway adapters — **Wompi** (P3a: locally-signed Web
  Checkout redirect + SHA-256 checksum webhook), **Mercado Pago** (P3b: real server-side Checkout
  Pro preference creation + HMAC-SHA256 `x-signature` webhook) and **ePayco** (P3b: Smart Checkout
  session creation + `^`-joined SHA-256 webhook, driven from the storefront's `/pago/epayco`
  bridge page for its client-side widget); stock reservation at checkout with the 15-minute
  TTL-expiry worker; an admin credentials UI with a per-provider "test connection"; and
  **payment-status reconciliation (P3c)** for the payments whose webhook never arrives. The
  reconciliation worker is a BullMQ repeatable job sweeping every tenant's still-`PENDING` online
  orders **older than 5 minutes, every 2 minutes** — both figures deliberately *below* the
  existing 15-minute stock-reservation TTL rather than the spec's draft-time "30 min", because at
  30 minutes the expiry worker would already have cancelled the order and restocked it, so
  reconciliation would have to un-cancel an order and re-decrement possibly-resold stock (design
  decision 4). It resolves each order through the gateway's own authenticated API, by
  `Order.providerRef` (stamped by `markPaid`/`markFailed` from a verified webhook, or captured
  from Wompi's redirect return via the new, deliberately unauthenticated `PATCH
  /v1/storefront/checkout/:orderNumber/provider-ref-hint`) or, for Mercado Pago only, by our own
  order number via `searchByReference`. An **order-binding check** — the reference *and*, where
  available, the amount, read out of the gateway's own response, must match the order's
  `number`/`totalCents` — gates every settle, in both directions; that check is exactly what
  makes the unauthenticated hint endpoint safe, since a planted-but-genuinely-paid transaction id
  gets a truthful "yes" from the gateway and still settles nothing. The job never expires,
  cancels or restocks anything itself. DoD: for all three gateways independently, a checkout
  reserves stock, a real validly-signed webhook confirms payment and decrements stock exactly
  once, and replaying the identical webhook is a verified no-op; and a `PENDING` order whose
  webhook never arrived is instead settled by the reconciliation sweep — the webhook chains
  proven end to end over real HTTP against a real Postgres (P3a/P3b), and reconciliation proven
  against the same real Postgres with the hint endpoint hit over real HTTP and the gateway's
  status/search response faked (no sandbox account, see below), including the binding guard's
  fraud case — a genuinely-paid transaction id planted on someone else's order — reproduced live
  and confirmed to leave that order completely untouched.
  - **Disclosed limitations** (what was and wasn't verified, same posture as P3a/P3b's own
    notes):
    - **ePayco has no redirect-return capture at all — the phase's biggest coverage gap.** Its
      checkout hooks (`setHooks({onResponse})`) structurally cannot fire in the `standard` mode
      this app uses (`open()` is a `window.location.href` full-page redirect that unloads the
      bridge page), are never invoked at all on the `sessionId` code path, and carry no
      transaction reference on any path — established in P3c Task 3 by reading ePayco's actual
      shipped `checkout-v2.js` (421 KB, `ref_payco`/`x_ref_payco`: 0 occurrences), whose behavior
      *contradicts ePayco's own prose docs*; the shipped code was taken as the authority.
      Consequence: ePayco's only `providerRef` source is `markPaid`/`markFailed` stamping one
      from an already-verified webhook, so an ePayco order whose webhook **never** arrives can
      never be reconciled — it always falls through to the 15-minute stock-reservation expiry
      worker. Reconciliation therefore helps ePayco only in the narrow "one webhook arrived, a
      later one was lost" case, **not** the "no webhook ever arrived" case it primarily exists
      for.
    - **Related, still open:** `PAYMENTS_STOREFRONT_BASE_URL` is a single *global* URL, so the
      redirect URLs handed to Wompi and ePayco are wrong for any deployment with 2+ tenants on
      those gateways; and ePayco shoppers in `standard` mode have no automatic return path at all
      (the bridge page's hook-driven handlers are proven dead in that mode, leaving the manual
      "Ya pagué" link as the only way back). Both share one root cause — `OrderForPayment`
      carries no tenant domain — and fixing that would also unlock ePayco's response-page return,
      which ePayco's own first-party samples show *does* carry the `ref_payco` reconciliation
      needs.
    - **`Order.number` is per-tenant**, so two tenants sharing one gateway account would produce
      colliding references. Pre-existing rather than introduced here — the already-shipped
      webhook path makes the identical assumption — but worth stating alongside the binding
      check, which compares against exactly that number.
    - **No real gateway sandbox account was available for any of P3a/P3b/P3c.** Every live
      verification used well-formed *fake* credentials against real HTTP and a real Postgres,
      exercising the real encryption / signature-verification / binding code paths rather than
      stubbing them — none of it is a real sandbox transaction. P3a/P3b's webhook passes were not
      mocked at the provider level at all: a real, correctly-signed payload went through the real
      adapter. P3c's reconciliation passes necessarily *were* faked at the adapter edge (a
      scripted `getTransactionStatus`/`searchByReference` injected through the worker's
      provider-resolver seam), since there is no account to produce a real gateway answer from;
      everything downstream of that answer — the binding check, `markPaid`/`markFailed`, the
      advisory lock, the real DB writes — ran for real, as did the hint endpoint over HTTP. A
      further exception, from P3b: Mercado Pago's webhook path
      was verified live only through its signature-verification step (a correctly-signed payload
      reached Mercado Pago's own live API for the mandatory follow-up `GET /v1/payments/:id`,
      where a tampered one failed earlier with a different error); its
      `markPaid`/stock-decrement/idempotency chain rests on mocked-fetch unit tests
      (`packages/payments/test/mercadopago.test.ts`).
- **P4 — AI Agent (web)** ⬜
- **P5 — WhatsApp + Human handoff** ⬜
- **P6 — Platform Admin + Hardening + Pilot** ⬜
