# P2a — Public Storefront: Design

**Date:** 2026-07-25
**Source spec:** `docs/SPEC.md` (M3, §11 P2 partial)
**Status:** Approved
**Builds on:** P1 (merged PR #2) — catalog, tenant theming, tenant_content model

## Goal

A shopper can browse a live tenant's storefront (home, categories, search, product
detail) on its subdomain, themed per the tenant's saved branding, with policy
pages and SEO — everything needed before cart/checkout (P2b) can be wired in.

## Decisions made during brainstorming

1. **P2 split into P2a (storefront) → P2b (cart/checkout/orders backend) →
   P2c (order management admin + tracking + DoD e2e)**, each with its own
   design → plan → subagent execution → phase review, matching the P1
   pattern.
2. **AI chat widget: omitted entirely in P2.** Spec §6 M3 lists it as an AC,
   but the real agent is P4. Building a placeholder now is pure YAGNI —
   nothing to wire it to yet. Deferred whole to P4.
3. **Real Resend integration in P2b** (not console-only) so "emails at each
   step" in the P2 DoD is genuinely true, not simulated. `RESEND_API_KEY`
   optional in dev/test: unset → automatic fallback to `ConsoleMailer` (the
   existing P1b abstraction already supports swapping the injected `Mailer`).
4. **Policy pages get a placeholder + a simple editor now**, not deferred to
   P4's agent-config bundle. P2a renders the four `tenant_content` pages
   (shipping, returns, privacy, contact) with es-CO generic copy when no
   content is saved; P2c adds a plain title+body editor in Configuración.
5. **Storefront talks to a new public API module** (`services/api/src/storefront/`),
   not directly to Prisma from Next.js — same architectural pattern as
   `/v1/admin/*`, reusing the Host/`x-tenant-domain` tenant-resolution
   middleware from P0. Keeps business logic (stock, IVA math) in one place
   ahead of P2b's checkout, which needs the same tenant-resolved context.

## Architecture

### 1. Public storefront API (`services/api/src/storefront/`)

- `GET /v1/storefront/tenant` — theme + name + status (extends P0's
  `/v1/tenant`, or the storefront reuses that endpoint directly — reuse it,
  don't duplicate).
- `GET /v1/storefront/products?search=&category=&priceMax=&sort=&page=` —
  active products only, full-text search (Postgres `spanish` config on
  `name`/`description_md`) + `pg_trgm` similarity for typo tolerance
  (`pg_trgm` extension already installed by the P0 RLS migration).
  Sort: relevance (only with a search term) / price / newest.
- `GET /v1/storefront/products/:slug` — full detail incl. variants, images,
  stock state (in stock / low / out — no exact numbers ever exposed to
  shoppers), related products (same-category, excluding self, active only —
  no "bestseller" signal exists yet pre-orders, keep it simple).
- `GET /v1/storefront/categories` — active categories with product counts,
  for nav + category listing pages.
- `GET /v1/storefront/content/:type` — one of
  `faq|policy_shipping|policy_returns|policy_privacy|about`; 404 falls back
  to a built-in es-CO default rendered by the page itself (not a stored
  default — keeps the "no content configured yet" case honest).
- All routes resolve tenant via the existing `TenantMiddleware`
  (`x-tenant-domain` / `Host`, Redis-cached); unresolved tenant → 404;
  suspended tenant → 503 for real this time (this module is the P2
  "storefront rebuild" the P1 design doc's 503 deviation note pointed at —
  the strict-503 backlog item closes here).
- No auth guard (public), but still tenant-scoped: a thin
  `PublicTenantGuard` attaches `req.tenant` and 404s/503s before the
  controller runs, mirroring `AdminSessionGuard`'s shape without the session
  bits.

### 2. Storefront app (`apps/storefront`)

- Pages: `/` (home: hero from theme, featured/newest products, category
  tiles), `/categorias/[slug]` (listing: filters price range + availability,
  sort), `/productos/[slug]` (PDP: gallery, variant selector, stock state,
  related products — **no working "Agregar al carrito" yet**, button renders
  disabled/placeholder; P2b wires it), `/buscar?q=` (search results reusing
  the listing UI), `/envios`, `/cambios-y-devoluciones`, `/privacidad`,
  `/contacto` (policy pages), `/404`.
- Theming: tenant theme (colors/fontPair/radius/logo — already modeled and
  editable since P1c) rendered as CSS variables on the root layout, same
  token names `packages/ui` already defines. Font pairs: the same fixed
  catalog of 5 used in the admin's theme picker — load via `next/font` at
  build time for all 5, select via CSS variable per tenant (no per-tenant
  code).
- Search: instant-search input on all pages hitting
  `/v1/storefront/products?search=` with debounce; dedicated `/buscar` page
  for the full results grid.
- Mobile-first Tailwind (reuse `packages/ui` primitives from P1c —
  Card/Badge/Button — the storefront was always meant to share them per the
  original spec §5 architecture note).
- ISR: product/category pages use `revalidate` + on-demand tag-based
  revalidation (`revalidateTag` called by the admin API on product/category
  writes — a small addition to P1a's catalog mutation paths: tag
  `products:{tenantId}` / `categories:{tenantId}`).
- SEO: per-tenant `sitemap.xml` + `robots.txt` (Next.js route handlers,
  querying `/v1/storefront/products` + `/categories`), Product `JSON-LD`
  on PDPs, OpenGraph tags from theme + product data.

### 3. Cross-cutting with catalog (P1a)

- Small addition to `services/api/src/catalog/products.service.ts` and
  `categories.controller.ts`: call `revalidateTag` (via a fetch to a Next.js
  on-demand revalidation route, token-protected) after create/update/delete,
  so storefront ISR reflects admin changes within the spec's 60-second AC.
- No schema changes needed — `tenant_content`, `Product.status`, all indexes
  already exist.

### 4. Testing

- API: Testcontainers integration tests per endpoint (search relevance +
  trigram typo match, tenant isolation — another tenant's products never
  leak, suspended tenant → 503, content-type fallback).
- Storefront: vitest for pure helpers (price formatting reuse from
  `apps/admin`? — no, storefront is a separate app; small local
  `formatCOP` copy is fine, it's an 8-line pure function, not worth a shared
  package for this alone — YAGNI). Playwright smoke deferred to P2c's e2e
  (which extends the P1 DoD flow through a real browse).
- Lighthouse mobile ≥ 90 on a PDP with 8 images — manual check in the
  wrap-up task, not automated in P2a (no CI Lighthouse budget exists yet;
  noting as a P6 hardening backlog item if we want it automated later).

## Error handling

- Unknown tenant domain → storefront 404 page (already exists from P0).
- Suspended tenant → real 503 with an es-CO "no disponible" page (replaces
  the P1 placeholder-200 deviation).
- Search with no results → empty-state es-CO copy, not an error.
- Missing product image → `packages/ui`'s existing image fallback pattern
  (none yet — add a simple placeholder SVG, tiny scope addition).

## Out of scope for P2a

Cart/checkout interactivity (P2b), order tracking page (P2c), payment
gateways (P3), AI widget (P4), platform-admin suspension tooling (P6, but
its *effect* — 503 — is what P2a implements), multi-currency, discount
codes (never — permanent non-goal per spec §2).
