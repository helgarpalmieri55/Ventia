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

- Node.js 22
- pnpm 9.15.0, via [corepack](https://nodejs.org/api/corepack.html) (pinned in `package.json`'s
  `packageManager` field — run `corepack enable` once if `pnpm` isn't already on your PATH)
- Docker (for the dev stack, and for running the `db`/`api` test suites, which use
  [Testcontainers](https://testcontainers.com/) against the local Docker daemon)

## Quickstart

```bash
# 1. Environment
cp .env.example .env

# 2. Dev stack: Postgres + Redis + Caddy
docker compose -f docker/compose.yaml up -d

# 3. Install dependencies
pnpm install

# 4. Apply migrations
DATABASE_URL=postgresql://ventia:ventia@localhost:5432/ventia \
  pnpm --filter @ventia/db exec prisma migrate deploy
# (or `pnpm --filter @ventia/db migrate:dev` in a fresh dev DB)

# 5. Seed two demo tenants (idempotent)
DATABASE_URL=postgresql://ventia:ventia@localhost:5432/ventia \
  pnpm --filter @ventia/db seed

# 6. Run the services (each in its own terminal)
DATABASE_URL=postgresql://ventia:ventia@localhost:5432/ventia \
REDIS_URL=redis://localhost:6379 \
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
curl -s -H "Host: demo-moda.ventia.localhost" http://api.ventia.localhost/v1/tenant

# Unknown host -> 404
curl -s -i -H "Host: unknown.ventia.localhost" http://api.ventia.localhost/v1/tenant

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
- **P1 — Catalog + Admin core** ⬜
- **P2 — Storefront + Cart + Checkout (COD end-to-end)** ⬜
- **P3 — Online Payments + Order lifecycle** ⬜
- **P4 — AI Agent (web)** ⬜
- **P5 — WhatsApp + Human handoff** ⬜
- **P6 — Platform Admin + Hardening + Pilot** ⬜
