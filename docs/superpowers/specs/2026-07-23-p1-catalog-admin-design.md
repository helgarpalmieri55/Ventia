# P1 — Catalog + Admin Core: Design

**Date:** 2026-07-23
**Source spec:** `docs/SPEC.md` (M1, M2, M8 partial, §5.6, §11 P1)
**Status:** Approved
**Builds on:** P0 Foundation (merged PR #1)

## Goal

A non-technical merchant can sign up, complete the onboarding wizard, load a
catalog (manually or via CSV, with images), invite staff, and launch a live
store — all without documentation.

**Definition of Done (spec §11):** M1 + M2 acceptance criteria pass; a
non-technical tester creates a store with 10 products from a CSV without help.

## Decisions made during brainstorming

1. **MinIO in dev for object storage.** The storage module speaks the S3 API
   (`@aws-sdk/client-s3`) with an env-configured endpoint: MinIO locally and
   in tests (Testcontainers), Cloudflare R2 in production. No code changes
   between environments. Env: `S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`,
   `S3_BUCKET`, `S3_PUBLIC_URL`.
2. **Wizard adapted to P1.** Steps: account → store info → branding → products
   (manual or CSV) → payments (enable COD only; gateways are P3) → launch
   checklist → live at `{slug}.ventia.localhost`. Gateway and custom-domain
   steps render as "próximamente". Meets M1's AC (live store with 3 products
   and COD enabled in ≤ 15 minutes).
3. **shadcn/ui + Tailwind 4 in `packages/ui`** per spec §4, shared components
   themed via CSS variables; the storefront reuses them in P2.

## Architecture

### 1. Scope

- **M1 complete:** onboarding wizard (resumable), staff invites/revocation,
  tenant lifecycle (`draft → live → suspended`), email verification required
  before launch.
- **M2 complete:** products (all spec fields), variants (≤ 3 options),
  categories, images (≤ 8, presigned uploads), CSV import (template, dry-run,
  upsert by SKU), inventory movements on stock changes.
- **M8 partial:** only the admin screens M1/M2 need (login, wizard, products,
  categories, CSV, staff, basic settings). Dashboard metrics and orders are
  later phases.

### 2. Storage module (`services/api/src/storage/`)

- Presigned PUT URLs for admin uploads; key scheme
  `tenants/{tenantId}/products/{productId}/{uuid}.{ext}`.
- Validation server-side before signing: content-type allowlist
  (jpeg/png/webp), max size (5 MB), max 8 images per product.
- Public read URLs via `S3_PUBLIC_URL` (MinIO exposes the bucket; R2 uses its
  public bucket URL in prod).
- Dev compose gains a `minio` service (+ one-shot bucket-create init).
  Tests use Testcontainers MinIO.

### 3. API modules (NestJS, all tenant-scoped via `tenantDb`, Zod at every boundary)

- **catalog:** CRUD for products/variants/categories/images. Auto slugs
  (editable, unique per tenant), soft-archive (`status`), stock adjustments
  write `inventory_movements` (reason, actor). Category delete never deletes
  products (M2 AC).
- **onboarding:** creates tenant + owner membership at signup; wizard step
  state persisted in `tenants.settings.onboarding` (resumable); launch
  endpoint validates checklist (store info, ≥ 1 active product, COD enabled,
  email verified) → status `live`.
- **staff:** email invites with single-use tokens (7-day expiry), role
  `staff`; owner can revoke. Mailer abstraction: console transport in dev,
  Resend adapter later (P2 wires real sends).
- **csv-import:** streaming parse (documented template; upsert by SKU; image
  columns accept URLs); `POST /import/dry-run` returns per-row errors +
  summary; `POST /import/commit` applies transactionally. 500 rows < 60 s
  (M2 AC), verified by a golden-file test.
- **Cross-cutting:** `tenant_limits.products_max` enforced (typed error
  `PLAN_LIMIT_EXCEEDED` → UI renders upgrade prompt); audit log rows on every
  admin mutation; role guards server-side (`staff` cannot reach settings,
  payments config, or staff management — M8 AC, pinned by tests).

### 4. Tenant lifecycle & verification

- `draft → live` only through the launch checklist; email verification
  (better-auth flow, console mailer in dev) is a hard launch requirement.
- `suspended`: storefront returns 503, admin becomes read-only (middleware
  checks tenant status; suspension tooling itself is P6 platform admin).
  **P1 deviation:** the storefront renders the unavailable message at HTTP
  200, not a real 503 (see `apps/storefront/app/page.tsx`'s doc comment) —
  the strict 503 is deferred to P2's storefront rebuild.

### 5. Admin UI (`apps/admin`)

- Tailwind 4 + shadcn/ui primitives in `packages/ui` (button, input, form,
  table, dialog, select, toast…), CSS-variable theming.
- Auth pages (login/signup/verify), onboarding wizard, products list
  (search/filter/status) + form (variants editor, image dropzone with
  presigned upload), categories, CSV importer (upload → dry-run preview →
  commit), staff management, basic settings (store info + branding).
- Admin copy in Spanish (es-CO); code and comments in English.
- Session: better-auth cookie against the API (`/v1/auth/*`), role-aware
  navigation (staff sees catalog only).

### 6. Testing

- TDD throughout. Integration tests per API module with Testcontainers
  (Postgres, Redis, MinIO). Golden-file CSV tests (valid, mixed-errors,
  500-row performance). Role/limit/audit tests. Cross-tenant isolation
  inherited from P0 harness (new endpoints ride on `tenantDb`).
- Playwright e2e for the DoD path: signup → wizard → products (incl. CSV)
  → launch → live store on subdomain.

## Error handling

- Typed API errors (`PLAN_LIMIT_EXCEEDED`, `VALIDATION_FAILED` with field
  map, `FORBIDDEN_ROLE`, `LAUNCH_CHECKLIST_INCOMPLETE` with missing items).
- CSV dry-run never partially applies; commit is transactional; row errors
  carry row number + column + message (Spanish, shown in UI).
- Upload failures leave no orphan `product_images` rows (record created only
  after client confirms upload; nightly orphan sweep deferred to P6).

## Out of scope for P1

Storefront changes (P2), payment gateways (P3), AI agent (P4), WhatsApp (P5),
platform admin & suspension tooling, custom domains, dashboard metrics,
Chatwoot.
