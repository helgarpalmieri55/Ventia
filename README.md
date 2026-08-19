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
  access token). Wompi's lookup authenticates with the *public* key and answers requests carrying no
  credential at all, and ePayco's takes none — so for those two a hinted ref settles nothing. **That
  provenance gate — not the binding check — is what makes the deliberately unauthenticated hint
  endpoint safe**, and neither may be "optimized away": without them, a shopper who plants a real,
  genuinely-paid transaction id from their own past purchase onto someone else's `PENDING` order
  would get a truthful "yes, paid" from the gateway and a free order. The job
  only ever calls the existing `markPaid`/`markFailed`; it never expires, cancels or restocks
  anything itself, and its `reconciled N order(s)` log counts real transitions rather than settle
  attempts.
  Both settle paths enforce the same rule: the **webhook** path also refuses to settle unless the
  event's currency is `COP` (`result: 'currency_mismatch'`, or `'currency_unknown'` when the adapter
  could not read one), and a valid payment landing on an order that can no longer be settled — e.g.
  a `PAID` webhook arriving after the expiry worker cancelled the order — is recorded as
  `result: 'paid_order_not_settleable'` with a loud log, never as `'confirmed'`. Those orders mean a
  shopper paid and has nothing, so they need a human — and the merchant is told so directly rather
  than having to be told by us: `GET /v1/admin/payment-alerts` surfaces them, the admin shell shows a
  banner on every authenticated page while any are unreviewed, and **Pagos por revisar**
  (`/pagos-por-revisar`) holds the detail and the per-case guidance. A merchant records what they did
  with `POST /v1/admin/payment-alerts/:id/review` (`refunded` / `order_taken_again` /
  `no_action_needed` / `other` / `reopened`, plus an optional note), which appends a
  `WebhookEventReview` row and moves the alert to that page's **Revisados** section. That table is
  append-only in Postgres — `ventia_app` holds SELECT + INSERT with UPDATE/DELETE revoked — so a
  financial discrepancy can be accounted for but never erased, and an alert marked reviewed by
  mistake is corrected by appending a `reopened` row rather than by deleting anything.

### AI sales agent — P4

`POST /v1/storefront/agent/messages` (JSON) and `/stream` (Server-Sent Events) answer one shopper
message. Both call the same conversation loop, so tenant scoping, throttling and the budget cap are
decided in exactly one place. The tenant comes from the request's domain via `PublicTenantGuard`,
never from the body. Six tools run server-side against that tenant only — `search_products`,
`get_product`, `recommend_products`, `create_cart_link`, `get_order_status`, `get_store_info`.
`escalate_to_human` is plan-gated on `TenantLimits.humanHandoff` and is filtered out of the tool
array — and out of the prompt's rule 7 — for a store without it, so the model is never told to reach
for something it does not have. It marks the conversation `escalated` and emails the merchant a link to the
transcript; SPEC's Chatwoot conversation is a P5 line item that will become a second notifier
alongside the email rather than a replacement.

**Conversaciones** (`/v1/admin/conversations`, both roles) is where the merchant reads what the agent
has been saying and answers the chats it handed over — the handoff email deep-links to a row via
`?c=<id>`, which for an anonymous web shopper is the merchant's only route to finding out who needs
help. `PATCH :id/resolve` marks an escalation handled so the list stays meaningful as it grows.

Three independent limits, deliberately not one:

- **Monthly plan cap** (`AgentUsage` / `TenantLimits.aiMessagesMonth`) — counts shopper turns, not
  API calls. At 100% the agent returns a fixed sentence and makes no model call at all. A tenant
  with no `TenantLimits` row is zero budget, not unlimited. The counter is not writable by
  tenant-scoped code (migration `20260818090000_agent_usage`).
- **Per conversation** — 20 messages / 5 min, plus a cool-down that answers a repeated identical
  message from the previous reply instead of billing it again. Redis, fails open.
- **Per address** — 30/min on `/v1/storefront/agent`, the tightest of the four request limiters,
  because it is the only surface where an accepted request spends the *merchant's* money.

A cart the agent builds carries `source = 'agent'`; the order inherits it at checkout, which is what
`GET /v1/admin/agent/usage` counts as "ventas asistidas por IA" alongside the month's message usage.
The merchant configures name, tone and summaries under **Configuración → Asistente IA**
(`PATCH /v1/admin/settings/agent`, owner-only). The storefront widget mounts only for a store whose
plan includes AI messages.

**Evals** (`services/api/test/agent-evals.test.ts`) cover SPEC §7's six scenarios in two halves. The
deterministic half runs on every `pnpm test` and pins the properties the system guarantees whatever
the model says — a budget is never exceeded because over-budget products are never returned, a
mismatched order contact is indistinguishable from a nonexistent order, an escalation is a durable
status change and not just a sentence, a price comes from the current row. The live half asks the real model and is skipped by default:

```bash
AGENT_LIVE_EVALS=1 ANTHROPIC_API_KEY=sk-ant-... pnpm --filter @ventia/api vitest run test/agent-evals
```

### WhatsApp channel — P5

Two providers behind one interface (`packages/whatsapp`): **Evolution API** in development (self-hosted,
QR-paired, no Meta app review needed) and **Meta WhatsApp Cloud API** in production. Both were built
against their official docs read at implementation time, per SPEC §4, and are verified against the
docs' own example payloads rather than live traffic — no Meta app or Evolution instance was available
during development. **See `docs/deploying-whatsapp.md`** for connecting a real app, including an
ordered list of which assumptions are most likely to need adjusting on first contact.

**Routing does not use the URL.** `POST /webhooks/whatsapp/:provider` carries no tenant, because Meta
delivers one webhook per *app* covering every number registered under it — the only discriminator is
`phone_number_id` inside the payload. Hence `WhatsAppNumber.externalId` is globally `@unique`: the
lookup must have exactly one answer, and two tenants claiming one id would mean a shopper reaching
another store's agent. Evolution's instance name occupies the same column, so there is no special case.

Credentials (`credentialsEnc`) and `verifyToken` are AES-256-GCM encrypted with the same key as payment
credentials, and are **unreachable from tenant-scoped code**: `ventia_app` holds a column-level SELECT
grant that omits both, so a `tenantDb(...).whatsAppNumber.findMany()` errors rather than quietly loading
a token into memory. RLS is `ENABLE`, not `FORCE`, and that is load-bearing — the inbound routing lookup
runs on `platformDb` *before* a tenant is known, so forcing the policy on the owner would drop every
inbound message on the platform.

Four independent things bound abuse on this endpoint, since its tenant is unknowable at the rate-limiter
layer (see the comment in `main.ts`): the provider signature is verified before any work beyond one
indexed lookup; `Message.externalId` (unique per tenant) dedupes provider retries, which would otherwise
each be a second billed agent turn; the per-conversation throttle caps one shopper; and the monthly
budget caps the tenant. The plan gate (`TenantLimits.whatsappChannel`) is re-checked on every inbound
message, not just at connect time — a downgraded store keeps its number registered and Meta keeps
delivering to it.

The agent itself is unchanged: `AgentService.respond` was already channel-agnostic, so WhatsApp is a
second transport into it, with a text-first renderer replacing the widget's product cards. Prices in
that text come from the tool results, never from the model's prose — the same guarantee the widget has.

### Totals and IVA

Colombian retail convention, per `docs/SPEC.md` §5: **catalogue prices include IVA**. An order's
`taxCents` is therefore the IVA portion *contained in* `subtotalCents`
(`price_cents - price_cents / (1 + rate)`), recorded for the DIAN breakdown — it is **not** added to
the total. A shopper pays `subtotal + shipping`, which is exactly the sticker prices they were
quoted plus delivery. Every surface that shows it says "IVA incluido" for the same reason.

This was wrong from P2b until P4: checkout, the cart API, the cart drawer, the cart page and the
checkout page all computed `subtotal + tax + shipping`, over-charging every order by the IVA
contained in its own contents (a $180.000 basket at 19% was billed $208.739). It is pinned now by
`POST /v1/storefront/checkout — prices include IVA (SPEC §5)` in `test/checkout.test.ts`, which
states the rule rather than deriving an expected number the same way the code does — the reason the
original happy-path test could not catch it.

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
  available, the amount and its currency, read out of the gateway's own response, must match the
  order's `number`/`totalCents` — gates every settle, in both directions. A binding check is *not*
  an account check, so what actually makes the unauthenticated hint endpoint safe is the
  **provenance gate** on top of it: a hint-sourced ref is never looked up by id for a provider whose
  lookup isn't merchant-account-scoped, because a planted-but-genuinely-paid transaction id gets a
  truthful "yes" from the gateway and every term of the binding check can be chosen by the payer.
  The job never expires, cancels or restocks anything itself. DoD: for all three gateways independently, a checkout
  reserves stock, a real validly-signed webhook confirms payment and decrements stock exactly
  once, and replaying the identical webhook is a verified no-op; and a `PENDING` order whose
  webhook never arrived is instead settled by the reconciliation sweep (for Mercado Pago; see the
  disclosed limitation below for why Wompi and ePayco no longer are) — the webhook chains
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
    - **Post-provenance-gate, the same is now true of Wompi: a Wompi or ePayco order whose webhook
      never arrives has no recovery path at all.** Neither provider implements
      `searchByReference` (no lookup-by-our-own-reference endpoint exists for either), and since
      the wave-2 provenance gate a hint-sourced `providerRef` is refused for both — so Wompi's
      redirect-return capture (`/pago/wompi-retorno/:orderNumber?id=`), which was the one thing
      that gave a webhook-less Wompi order a ref to reconcile from, no longer settles anything on
      its own. Such an order falls through to the 15-minute stock-reservation expiry worker and is
      cancelled and restocked, exactly like an ePayco one. Mercado Pago is the only provider whose
      orders genuinely self-heal without a webhook (its `searchByReference` runs off our own order
      number against MP's private-token-authenticated API). The Wompi hint is still stored as a
      support/audit breadcrumb, and a merchant-identifier binding — or evidence that Wompi's lookup
      really is account-scoped — would make it settle-capable again by adding `'wompi'` to
      `ACCOUNT_SCOPED_LOOKUP_PROVIDERS`, one line in `reconciliation.worker.ts`.
    - **FIXED (was: "Related, still open"):** the redirect URLs handed to Wompi and ePayco used to
      come from a single *global* `PAYMENTS_STOREFRONT_BASE_URL`, so with 2+ tenants on those
      gateways every shopper was redirected to one storefront — and, since Wompi's return page
      `PATCH`es the API, tenant B's shopper landing on tenant A's storefront had A's proxy stamp
      `x-tenant-domain: A`, writing B's transaction id onto **A's** same-numbered order, which A's
      reconciliation worker then queried with **A's own** credentials. `OrderForPayment` now
      carries `storefrontBaseUrl`, populated per request in `checkout.service.ts` from the
      `TenantDomain` row that request resolved through (`@StorefrontTenantDomain()` →
      `tenants/tenant-public-url.ts`); the env var is gone, with no fallback, so a call site that
      omits the value fails to compile rather than silently redirecting somewhere wrong. The
      http-vs-https choice is an explicit documented rule: `*.localhost`/`*.local`/`*.test`/
      loopback get `http` (this repo's dev stack), every real registrable domain defaults to
      `https`, and `STOREFRONT_PUBLIC_SCHEME` overrides both.
    - **Also fixed: ePayco's missing return path.** ePayco `standard`-mode shoppers had no
      automatic way back (the bridge page's hooks are proven dead in that mode — `open()` is a
      full-page navigation — leaving the manual "Ya pagué" link as the only way back, on a page
      the shopper had already left). With a per-tenant public URL available, `epayco.ts` now sets
      the session-create `response` field to that tenant's own
      `/pago/epayco-retorno/{orderNumber}` route, which captures `ref_payco` off the query string
      exactly as ePayco's own first-party samples do (`docs.epayco.com/docs/paginas-de-respuestas`;
      `github.com/epayco/resources`' `onePage/response/response.html` and `epayco-ng6`'s
      `response.component.ts`). **This does NOT restore ePayco reconciliation coverage** — read the
      two bullets above: a response-page ref is `hint`-sourced, and the provenance gate refuses
      hint-sourced refs for ePayco because its status lookup is unauthenticated and
      merchant-agnostic. It buys the UX return path and a support/audit breadcrumb, nothing more;
      an ePayco order whose webhook never arrives still falls through to the expiry worker.
      ePayco's `confirmation` (webhook) URL and its `method` field are still deliberately NOT sent
      — both touch the *verified settle* path, which no one here can test against a real sandbox.
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
- **P4 — AI Agent (web)** ✅: a tool-using sales agent on the storefront widget, built on the
  Anthropic Messages API. Seven tools (catalogue search, product detail, stock, shipping quote,
  cart add/read, and `escalate_to_human`), a per-tenant monthly message budget read from
  `TenantLimits.aiMessagesMonth` that fails **closed** for an unprovisioned tenant, an es-CO
  system prompt whose handoff rule varies with the tenant's plan, and an eval suite. The agent
  can build a cart that becomes a real, attributed order. DoD: the agent answers from the
  merchant's own catalogue, never invents a product or a price, and stops at its budget.
- **P5 — WhatsApp + Human handoff** ✅: `packages/whatsapp` with two providers behind one
  interface — Meta's **WhatsApp Cloud API** (`X-Hub-Signature-256` HMAC over the raw body, the
  `hub.challenge` handshake, Graph version pinned) and **Evolution API** — plus the inbound
  channel in the API. One webhook per Meta *app* covers every number, so delivery is routed by
  the `phone_number_id` in the payload against a globally-unique `WhatsAppNumber.externalId`;
  the webhook URL carries no tenant id. Per-tenant credentials are encrypted at rest and the
  columns holding them are withheld from `ventia_app` at the `GRANT` level. Messages are
  deduplicated on `(tenantId, externalId)`. Human handoff marks the conversation escalated and
  emails the merchant; the admin has a Conversaciones panel to read the transcript and resolve.
  Merchant-side Meta app configuration is a deploy-time step — see `docs/deploying-whatsapp.md`.
- **P6 — Platform Admin + Hardening + Pilot** 🚧: every engineering item is built; the pilot
  itself is not, and cannot be from a development environment. **Built** — the platform-operator
  console (tenant list, detail with GMV and AI usage, assign plan, suspend/reactivate, and
  impersonation), behind two independent grants: an env allowlist that fails closed *and* a
  `User.isPlatformAdmin` column no product code path writes. Custom domains with DNS TXT
  verification gating Caddy's on-demand TLS. Plan limits behind one 402 `PLAN_LIMIT_EXCEEDED`
  shape. An append-only payment ledger and audit entries on every order transition. Subscription
  tracking with an auto-suspend sweep and a warning three days ahead. Full **Ley 1581 (Habeas
  Data)** compliance — a privacy-policy generator built from the Decreto 1074 required contents,
  customer anonymization that keeps the accounting and erases the person, a 12-month conversation
  retention purge, and authorization at checkout with the *prueba de la autorización* the law
  lets a shopper demand. Backups with an offsite copy verified by read-back, and a restore drill
  executed against the **downloaded** copy (15/15, tenant isolation biting on restored data).
  A 100-concurrent-checkout load test that found and proved a connection-pool starvation bug in
  checkout. Sentry with a PII scrubber that reuses the anonymizer's own key list, and a guarded
  queue-health endpoint. **Not done, and not doable from here** — the pilot with 2–3 real
  merchants on custom domains, which needs real merchants, real gateway credentials and real DNS.
  Everything it requires is enumerated in [`docs/deploying.md`](docs/deploying.md). No payment
  gateway and no WhatsApp number has ever been exercised against live traffic; there is no CI/CD,
  no staging environment, and nothing schedules the backups.

## Operations: backups, restore drill & load test

Full runbook — including everything that was written but **not** exercised — in
[`docs/operations.md`](docs/operations.md). Four local-run scripts, none of them
part of `pnpm turbo run test`/CI:

```bash
bash scripts/backup.sh          # pg_dump + pg_dumpall globals + manifest + sha256
node scripts/backup-upload.mjs  # copy that run offsite (S3/R2), verified by read-back
bash scripts/restore-drill.sh   # restore into a scratch DB and prove it is usable
node scripts/load-test.mjs      # 100 concurrent checkouts, invariants asserted from Postgres
```

**Backups.** `backup.sh` writes four files per run: the `--format=custom` dump,
a `pg_dumpall --globals-only` file, a manifest (row counts, policy digest,
migration count), and checksums. The globals file is not optional — every RLS
policy is written against the `ventia_app` role, which `pg_dump` does not
carry, so a dump-only restore into a fresh cluster either fails on the first
`GRANT` or comes up with tenant isolation quietly switched off. Retention
defaults to 30 days (SPEC.md §10). Output goes to
`${TMPDIR:-/tmp}/ventia-backups` by default, deliberately outside the repo.
`backup-upload.mjs` copies a run offsite to S3/R2, verifying every file by
reading it back (a `PutObject` 200 is not evidence the bytes that landed are
the bytes you sent), and `--pull` brings one back down checked against the
`.sha256` taken before the upload. Exercised end to end against the compose
MinIO, and the **downloaded** copy then passed the full restore drill 15/15 —
so the offsite copy is known-restorable, not merely present. Real R2
credentials are a deploy-time step.

**Restore drill (P6 DoD: "restore drill documented and executed").**
`restore-drill.sh` restores a backup into a throwaway database and runs 15
checks: row counts against the manifest, the RLS-enabled table set, an md5 over
every policy's `USING`/`WITH CHECK` clause, `ventia_app`'s full grant matrix
against the source, and — the one that matters — connecting **as `ventia_app`**
to the restored data and confirming each tenant's `app.tenant_id` context sees
exactly its own rows, zero of the other tenant's, nothing at all with no GUC
set, and that a cross-tenant `INSERT` is refused. Executed against the dev
database on 2026-08-19: **15 passed, 0 failed** (35 tables, 28 RLS tables, 29
policies, 20 migrations). The checks were also verified non-vacuous against a
deliberately sabotaged copy, where every one of them flipped red.

**Load test (P6 DoD: "isolation suite green under load").** `load-test.mjs`
seeds four throwaway tenants, drives real checkouts over HTTP, and asserts the
outcome by reading Postgres — separating *invariants* (stock accounting, tenant
isolation) from *capacity* (was the offered load actually served), because a
platform that refuses work and a platform that oversells are not the same
problem. At 100 concurrent checkouts, three consecutive green runs:

| Scenario | Result | Wall | Throughput |
| --- | --- | --- | --- |
| Capacity — stock 100 | 100 × 201, stock → 0, order numbers dense 1..100 | 1839 ms | 54.4/s |
| Oversell — stock 50 | exactly 50 × 201 + 50 × 400 `INSUFFICIENT_STOCK` | 1552 ms | 64.4/s |
| Isolation — 2 tenants × 50 | 100 × 201, 50 orders each numbered 1..50, 0 cross-tenant rows under RLS | 911 ms | 109.7/s |

Zero oversell at every concurrency level tested, and no invariant was violated
in any run — including badly degraded ones. Two findings came out of it. The
checkout rate limiter (60/IP/min) dominates any single-source load test unless
raised — working as designed. And **checkout starved the Prisma connection
pool**: it called `ShippingService` from inside `platformDb.$transaction()`,
and that call needed a second connection from the same pool, so a burst larger
than the pool wedged until Prisma's 15 s transaction timeout and returned bare
500s. At 100 concurrent on the default pool that was **7 requests served out of
100**. Fixed — the shipping config is now loaded before the transaction opens
and priced from memory inside it, which takes the same run to **100/100 in
1.9 s**. Both findings, the evidence, and the before/after are in
[`docs/operations.md`](docs/operations.md#load-test).
