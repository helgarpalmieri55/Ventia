# P0 — Foundation: Design

**Date:** 2026-07-23
**Source spec:** `docs/SPEC.md` (§4, §5, §8, §11 P0)
**Status:** Approved

## Goal

Lay the platform foundation so every later phase builds on a proven multi-tenant
base: monorepo scaffold, dev environment, full database schema with enforced
tenant isolation, auth, tenant resolution by domain, and CI.

**Definition of Done (from spec §11):** two seeded tenants resolve by subdomain
locally; a cross-tenant read attempt fails in an automated test; CI green.

## Decisions made during brainstorming

1. **Chatwoot deferred to P5.** Deviation from spec §11 P0 ("pg + redis + caddy
   + chatwoot"): Chatwoot is only used by the human-handoff feature (P5) and
   adds several containers with no P0 value. The dev compose ships Postgres,
   Redis, and Caddy only.
2. **Full §8 schema in the initial migration.** All tables defined in spec §8
   (including Phase-2 sockets `shipments` and `invoices`) are created in P0.
   The RLS harness and isolation tests run against the real model from day one;
   later phases add logic, not large migrations.
3. **pnpm 10 is installed in the environment; the repo pins pnpm 9** via the
   `packageManager` field (corepack), per spec §4 global constraints.

## Architecture

### 1. Monorepo & tooling

- Turborepo + pnpm workspaces, TypeScript `strict: true` end-to-end, Node 22.
- Layout per spec §12:
  - `apps/storefront` — Next.js 15 minimal scaffold (enough to demonstrate
    tenant resolution + a placeholder tenant home and platform landing).
  - `apps/admin` — Next.js 15 minimal scaffold (placeholder only in P0).
  - `services/api` — NestJS 10 skeleton: config, health endpoint, tenant
    context plumbing, auth module.
  - `packages/db` — Prisma 6 schema, migrations (incl. RLS SQL), tenant-scoped
    client extension.
  - `packages/core` — Zod, shared types/constants (only what P0 needs; DANE
    data arrives in P2).
  - `packages/payments` — `PaymentProvider` interface only (spec §6 M5).
  - `packages/ui` — placeholder package (components arrive in P1/P2).
- ESLint + Prettier, conventional commits. Spec file moved to `docs/SPEC.md`.

### 2. Dev environment

- `docker/compose.yaml`: Postgres 16 (with `pgvector` and `pg_trgm` extensions
  available), Redis 7, Caddy.
- Caddy serves `*.ventia.localhost` → storefront and `admin.ventia.localhost`,
  `api.ventia.localhost` → their services, so subdomain resolution is testable
  locally without editing `/etc/hosts` (`*.localhost` resolves to 127.0.0.1).

### 3. Database schema + tenant isolation (two layers)

- Prisma schema v1 covering every table in spec §8.
- Money columns are integer cents; enums for order/payment status per §6.
- **Layer 1 — Postgres RLS:** enabled on every table carrying `tenant_id`, with
  policy `tenant_id = current_setting('app.tenant_id')::uuid`. Policies are
  raw SQL appended to the initial migration (Prisma does not model policies).
  The API's database role is non-superuser and not `BYPASSRLS`, so policies
  actually apply.
- **Layer 2 — Prisma client extension** in `packages/db`:
  - `tenantDb(tenantId)` returns a client that runs queries inside a
    transaction which first sets the `app.tenant_id` GUC (`set_config(...,
    true)` — transaction-scoped), auto-injects `where: { tenantId }` on reads
    and `tenantId` on creates, and rejects cross-tenant writes.
  - `platformDb` is the unscoped client, exported separately and used only in
    platform-admin/system code paths, explicitly.

### 4. Auth

- better-auth on the API: email + password with email verification, session
  carrying `userId`, `tenantId`, `role` (`owner | staff | platform_admin`)
  resolved through `memberships`.
- P0 scope: working signup/login/session endpoints with tests. Onboarding
  wizard, invites, and admin UI are P1 (spec M1).

### 5. Tenant resolution

- Middleware (storefront + API): read `Host` → look up `tenant_domains`
  (Redis-cached, 60 s TTL) → attach `tenantId` to request context. Unknown
  host → platform landing page. Suspended tenant handling arrives with tenant
  lifecycle work (P6); the resolver returns tenant status from day one.
- Seed script creates two `live` tenants (e.g. `demo-moda`, `demo-tech`) with
  their `{slug}.ventia.localhost` domains.

### 6. Testing & CI

- Vitest (unit/integration) + Testcontainers (Postgres/Redis). TDD throughout.
- Key P0 suites:
  - **Cross-tenant isolation:** with tenant A's context, reads and writes
    against tenant B's rows fail at the Prisma-extension layer; and a raw SQL
    session with tenant A's GUC cannot see tenant B's rows (RLS layer proven
    independently).
  - GUC scoping: concurrent transactions with different tenants don't leak.
  - Domain resolution: known domain → tenant, unknown → landing, cache TTL.
  - Auth: signup/login/session shape.
- GitHub Actions CI: install → lint → typecheck → test (Testcontainers via the
  runner's Docker). Green CI required before merge.

## Error handling

- Unknown host: storefront renders platform landing (200), API returns 404
  with a typed error.
- Missing/invalid `app.tenant_id` GUC: RLS denies by default (no rows), and
  `tenantDb` refuses to run without a tenant id.
- Migration/seed scripts are idempotent (`upsert` by slug/domain).

## Out of scope for P0

Catalog CRUD, storefront pages beyond placeholders, checkout, payments logic,
AI agent, WhatsApp, notifications, platform admin UI, Chatwoot, R2 uploads.
