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
`apps/storefront/app/api/{cart,checkout}/[[...path]]/route.ts`. Payment is cash-on-delivery only.
Checkout itself never touches `Product.stock` — stock is decremented on the `confirm` transition
below (`PENDING` → `CONFIRMED`), not at order-creation time, and restocked on `cancel` from any
status that had already decremented it; see `services/api/src/orders/orders.service.ts`.
Manually exercising the cart/checkout flow (add → drawer → `/carrito` → `/checkout`) needs the API
reachable from wherever the storefront dev server runs, since the proxy route calls it directly.

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
- **P3 — Online Payments + Order lifecycle** ⬜
- **P4 — AI Agent (web)** ⬜
- **P5 — WhatsApp + Human handoff** ⬜
- **P6 — Platform Admin + Hardening + Pilot** ⬜
