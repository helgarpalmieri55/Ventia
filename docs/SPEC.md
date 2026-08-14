# Ventia — Conversational Commerce SaaS for Colombia
## Product & Technical Specification — v1.0

> **Working name:** "Ventia" (venta + IA). Placeholder — validate trademark/domain availability before launch.
>
> **How to use this document:** This is the source of truth for building the platform with Claude Code. Build in phases (§11). For each phase: read the relevant sections → brainstorm open questions → write an implementation plan → execute with TDD. Keep this spec in the repo (`docs/SPEC.md`) and update it when decisions change — it is a living document.

---

## 1. Product Overview

**One-liner:** A multi-tenant e-commerce platform where every store ships with an AI sales agent — on the web storefront and on WhatsApp — that informs, recommends, sells, and tracks orders. Colombian payment rails (Wompi/Bancolombia, Mercado Pago, ePayco), cash on delivery, and Colombian address/tax conventions are built in. A business goes from signup to selling in under a day.

**Business model:** B2B SaaS sold to Colombian SMBs (retail, boutiques, tech shops, home goods, food products — any physical product vertical). Subscription tiers (Básico / Pro / Premium) with limits on products, AI messages/month, staff seats, custom domain, and human-agent escalation. Optional premium add-on: human agent backup (escalation to a live agent via Chatwoot).

**Why this wins (positioning, not code — context for product decisions):**
- Competitors (Shopify, Tiendanube, Vtex) sell *websites*. Ventia sells *a salesperson that works 24/7* — the AI agent is the product, the store is the infrastructure.
- WhatsApp-first: in Colombia, WhatsApp is where commerce conversations actually happen. The same agent runs on the storefront widget and the store's WhatsApp number.
- Colombian rails out of the box: PSE, Nequi, cards, contra entrega, departamento/municipio addresses, IVA-inclusive pricing, DIAN-ready order fields. No plugins, no configuration archaeology.
- Onboarding measured in hours: guided wizard + CSV product import + sensible defaults.

---

## 2. Goals & Non-Goals (v1)

**Goals:**
1. Multi-tenant platform: one deployment serves many stores, each with its own domain, branding, catalog, payments, and AI agent.
2. Complete purchase flow: browse → cart → checkout → pay (online or COD) → order tracking, entirely self-serve for the shopper.
3. AI sales agent with real capabilities (tool use): product search, recommendations, cart/checkout link creation, order status lookup, store policy answers, human escalation.
4. Three payment gateways behind one adapter interface: **Wompi (Bancolombia)** first, then **Mercado Pago**, then **ePayco**.
5. Merchant admin good enough that a non-technical store owner operates alone.
6. Platform admin for tenant management, plan limits, AI usage/cost tracking.

**Non-Goals (v1) — explicitly out of scope:**
- Marketplace features (multi-vendor per store), POS, native mobile apps.
- Multi-currency (COP only) or multi-country.
- Automated refunds via gateway APIs (manual process v1; adapter method stubbed).
- Courier API integrations (Servientrega, Interrapidísimo, Coordinadora, Envia) — data model is ready (§10), implementation is Phase 2.
- DIAN electronic invoicing — order model captures the legal fields (§10), actual issuance via a provider API (Alegra / Siigo / Factus — evaluate in Phase 2).
- Discount codes / promotions engine (v1: none; agent must never promise discounts).
- Automated SaaS billing (v1: manual invoicing + payment links; subscription status tracked in platform admin).

---

## 3. Roles

| Role | Description |
|---|---|
| **Platform Admin** | Operates the SaaS: tenants, plans, usage, suspension, impersonation (audited). |
| **Merchant Owner** | Store owner. Full access to their tenant's admin. |
| **Merchant Staff** | Invited user. Orders + catalog management; no settings/payments access. |
| **Shopper** | End customer. Guest by default; account optional (v1: guest only + order lookup). |
| **AI Agent** | System actor. Executes a fixed tool set, always scoped to one tenant. |

---

## 4. Architecture & Tech Stack

**Monorepo:** Turborepo + pnpm workspaces. TypeScript end-to-end (one language keeps Claude Code sessions coherent).

| Unit | Tech | Responsibility |
|---|---|---|
| `apps/storefront` | Next.js 15 (App Router, RSC, ISR) | Public multi-tenant stores + AI chat widget |
| `apps/admin` | Next.js 15 | Merchant admin + Platform admin (role-gated route groups) |
| `services/api` | NestJS 10 + BullMQ workers | REST API, webhooks, queues, AI agent module, WhatsApp module |
| `packages/db` | Prisma 6 + Postgres 16 | Schema, migrations, tenant-scoped client extension |
| `packages/core` | Zod + shared types | DTOs, tool schemas, domain constants (departamentos/municipios) |
| `packages/payments` | Plain TS | `PaymentProvider` adapters: Wompi, Mercado Pago, ePayco |
| `packages/ui` | React + Tailwind + shadcn/ui | Shared components + tenant theming via CSS variables |

**Infrastructure (v1):** single VPS · Docker Compose · Caddy (reverse proxy + automatic HTTPS, including on-demand TLS for custom domains) · Postgres 16 (with `pgvector` installed but unused in v1) · Redis 7 (BullMQ, cache, rate limiting) · Cloudflare R2 (S3-compatible; product images via presigned uploads) · Resend (transactional email) · Sentry + pino structured logs.

**AI:** Anthropic API, model `claude-sonnet-4-6`, Messages API with streaming + tool use.

**WhatsApp:** Evolution API in development, Meta WhatsApp Cloud API in production. Human handoff via Chatwoot (self-hosted, same VPS).

**Auth:** better-auth. Email + password with email verification; magic link optional. Sessions carry `userId`, `tenantId`, `role`.

### Global Constraints (apply to every task in every phase)
- Node 22 LTS · pnpm 9 · TypeScript `strict: true` · Next.js 15.x · NestJS 10.x · Prisma 6.x.
- **Money:** all amounts stored as **integer COP cents** (Wompi convention: `amount_in_cents`). Display: `es-CO` locale, no decimals (`$ 45.900`).
- **Language:** storefront + agent copy in Spanish (es-CO). Code, comments, commit messages, and docs in English. Admin UI in Spanish.
- **Tenant isolation:** every table holding tenant data has `tenant_id`; Postgres RLS enforced (§5); application code must use the tenant-scoped Prisma client. Direct unscoped access allowed only in platform-admin and system contexts, explicitly.
- **Payment status truth:** webhooks are the source of truth, never the client redirect.
- **Gateway/WhatsApp APIs:** never implement from memory — read the official docs (Wompi, Mercado Pago, ePayco, Meta Cloud API, Evolution API) at implementation time; APIs change.
- TDD: Vitest (unit/integration) + Playwright (e2e) + Testcontainers (Postgres/Redis). Conventional commits. CI green before merge.

---

## 5. Multi-Tenancy Model

1. **Resolution:** middleware reads `Host` header → looks up `tenant_domains` (Redis-cached 60 s) → attaches `tenantId` to request context. Unknown host → platform landing page.
2. **Domains:** default `{slug}.ventia.co` (wildcard DNS). Custom domains: merchant adds CNAME → verification check → Caddy on-demand TLS, gated by an internal "is this domain registered?" endpoint.
3. **Isolation (two layers):**
   - Postgres RLS: policies on every tenant table checking `tenant_id = current_setting('app.tenant_id')::uuid`. The API sets the GUC per transaction.
   - Prisma client extension: auto-injects `where: { tenantId }` and forbids cross-tenant writes. Cross-tenant access attempts are part of the test suite (§9).
4. **Theming:** per-tenant JSON design tokens — logo URL, favicon, primary/background/foreground colors, font pair (fixed catalog of 5 pairs), corner radius. Rendered as CSS variables. No per-tenant code, ever.
5. **Plans & limits:** `plan` on tenant (`basico | pro | premium`) + `tenant_limits` row: `products_max`, `ai_messages_month`, `staff_seats`, `custom_domain` (bool), `human_handoff` (bool), `whatsapp_channel` (bool). Enforced in API middleware; exceeding limits returns a typed error the UI renders as an upgrade prompt.
6. **Provisioning wizard (merchant signup):** account → store info (name, category, contact) → branding (logo + colors) → products (manual or CSV) → payments (connect at least one provider or enable COD) → domain → launch checklist → live.

---

## 6. Module Specifications

### M1 — Auth & Tenant Onboarding
- Merchant signup/login (better-auth), email verification required before launch.
- Onboarding wizard (§5.6) resumable; tenant status: `draft → live → suspended`.
- Staff invites by email with role `staff`; owner can revoke.
- **AC:** new merchant reaches a live store with 3 products and COD enabled in ≤ 15 minutes without documentation; suspended tenants return 503 on storefront and read-only admin.

### M2 — Catalog
- Product: name, slug (auto, editable), description (rich text stored as markdown), images (≤ 8, R2), price, compare-at price, cost (optional, private), SKU, barcode (optional), stock, `track_inventory` bool, tax rate enum (`0 | 5 | 19 | excluido`), status (`draft | active | archived`), categories (m2m), SEO title/description.
- Variants: up to 3 options (e.g., Talla/Color) → generated variant rows, each with own price/SKU/stock override.
- CSV import: documented template; upsert by SKU; image columns accept URLs; dry-run preview with per-row errors before commit.
- Inventory: stock on variant (or product if no variants); `inventory_movements` audit rows on every change (sale, restock, manual adjust, cancel-restock).
- **AC:** 500-product CSV imports in < 60 s with a row-level error report; deleting a category never deletes products; archived products 404 on storefront but remain in past orders.

### M3 — Storefront
- Pages: home (hero, featured products, categories) · category listing (filters: price range, availability; sort: relevance/price/newest) · product detail (gallery, variant selector, stock state, related products) · cart (drawer + page) · checkout · order confirmation · order tracking (`/rastrear`) · policy pages (envíos, cambios y devoluciones, privacidad, contacto — rendered from tenant content) · 404.
- Search: instant search endpoint using Postgres full-text (`spanish` config) + trigram for typos.
- Mobile-first. Performance budget: LCP < 2.5 s on mid-range Android over 4G; product pages use ISR with tag-based revalidation on catalog changes.
- SEO: per-tenant sitemap.xml + robots.txt, Product JSON-LD, OpenGraph.
- AI chat widget mounted on all pages (§7).
- **AC:** Lighthouse mobile ≥ 90 performance on PDP with 8 images; changing a price reflects on the storefront in < 60 s; all copy es-CO.

### M4 — Cart & Checkout
- Guest checkout only in v1. Cart persisted server-side, cookie-keyed; merges are not needed (no accounts).
- Checkout steps (single page, sections): contact (email + celular) → shipping address → shipping method → payment method → review & pay.
- **Colombian address model:** nombre completo, teléfono, departamento (official list, constant in `packages/core`), ciudad/municipio (dependent dropdown from official DANE list), dirección, complemento (apto/torre, optional), barrio (optional), notas (optional). No postal code field.
- Shipping methods (per-tenant config): flat rate · rate by zone (departamento → price table) · free over X · store pickup. COD (contra entrega) is a payment method that can be restricted to selected departamentos.
- Totals: Colombian retail convention — **prices include IVA**. Order stores the tax breakdown per line derived from each product's tax rate (`price_cents - price_cents / (1 + rate)` for the tax portion, computed with integer-safe rounding).
- Stock: reserved at order creation with 15-minute TTL for online payments (released by a BullMQ job on expiry); decremented on `PAID`; for COD, decremented when the merchant confirms.
- Optional per-tenant toggle: "solicitar datos de facturación" → adds documento (CC/NIT/CE + número) and razón social fields (stored for DIAN readiness, §10).
- **AC:** full COD purchase possible with JavaScript-heavy widget disabled except checkout essentials; abandoning payment releases reserved stock within 16 minutes; address form rejects a municipio that doesn't belong to the selected departamento.

### M5 — Payments
- Interface in `packages/payments`:
  ```ts
  interface PaymentProvider {
    readonly id: 'wompi' | 'mercadopago' | 'epayco';
    createCheckoutSession(order: OrderForPayment, cfg: TenantProviderConfig): Promise<{ redirectUrl: string }>;
    verifyAndParseWebhook(req: RawRequest, cfg: TenantProviderConfig): Promise<NormalizedPaymentEvent>;
    getTransactionStatus(providerRef: string, cfg: TenantProviderConfig): Promise<NormalizedStatus>;
    refund?(providerRef: string, amountCents: number, cfg: TenantProviderConfig): Promise<void>; // Phase 2
  }
  ```
- **Order of implementation:** Wompi (cards, PSE, Nequi, botón Bancolombia) → Mercado Pago (Checkout Pro) → ePayco (Smart Checkout). All three via hosted checkout redirect in v1 — no card data ever touches Ventia.
- Per-tenant credentials (public/private keys) encrypted at rest (AES-256-GCM, key from env), entered in merchant admin with a "test connection" button using sandbox mode.
- Webhooks: one endpoint per provider (`/webhooks/payments/:provider/:tenantId`); verify signature per official docs; idempotency via unique `(provider, event_id)` in `webhook_events`; process through a queue, never inline. *(Shipped with two **deliberate, documented deviations**. **(1)** The idempotency key is **`(provider, tenant_id, event_id)`**, not the spec's `(provider, event_id)`: two tenants sharing one gateway merchant account share that account's webhook secret and `Order.number` is per-tenant, so ONE delivery legitimately verifies at both tenants' endpoints — under a global key, whichever tenant was hit second, **including the payment's real owner**, had its delivery permanently swallowed as a "replay". **(2)** Processing is still **INLINE, not through a queue** — the queue is genuinely not built, and this bullet is the record of that gap rather than leaving it silent. What makes inline processing survivable meanwhile: the `WebhookEvent` row is written before the settle and is only marked `processedAt` on success, so a delivery whose processing throws is reprocessed by the gateway's own retry instead of being answered "already handled"; and settlement is refused unless the event's amount equals the order's total. Building the queue remains open work — see `services/api/src/payments/webhooks.controller.ts`'s class doc comment.)*
- Reconciliation: BullMQ repeatable job — orders `PENDING` with a checkout session older than 30 min → poll `getTransactionStatus` → settle or expire. *(Shipped in P3c with a **5-minute floor and a 2-minute cadence**, not 30 minutes — a deliberate, documented deviation: by 30 minutes the 15-minute stock-reservation TTL worker above would already have restocked and cancelled the order, so a 30-minute pass would either match nothing or have to un-cancel an order and re-decrement possibly-resold stock. See decision 4 in `docs/superpowers/specs/2026-07-30-p3c-payment-reconciliation-design.md`. The shipped job also never expires or restocks anything itself — it only ever settles via `markPaid`/`markFailed`, leaving expiry to the existing TTL worker — and it settles nothing unless the gateway's own response is bound to that order by reference and amount.)*
- **AC:** sandbox happy-path e2e per gateway (Playwright where the sandbox allows; recorded HTTP fixtures otherwise); replaying the same webhook 10× results in exactly one state transition; a webhook with an invalid signature returns 401 and is logged.

### M6 — Orders
- Two enums: `status` = `PENDING | CONFIRMED | PREPARING | SHIPPED | DELIVERED | CANCELLED` and `payment_status` = `PENDING | PAID | FAILED | EXPIRED | COD`.
- Flow (online): checkout creates order (`PENDING`/`PENDING`) → webhook `PAID` → status `CONFIRMED`. Flow (COD): order (`PENDING`/`COD`) → merchant confirms by phone/WhatsApp → `CONFIRMED`.
- Merchant actions: confirm (COD), mark `PREPARING`, mark `SHIPPED` (carrier name + tracking number, free text v1), mark `DELIVERED`, cancel (restocks inventory, records reason).
- `order_events` timeline (who/what/when, including webhook-driven transitions).
- Public tracking: order number + email **or** phone must match; shows status timeline + tracking number.
- Order numbers: per-tenant sequential with prefix (e.g., `VNT-1042`) — never expose raw UUIDs to shoppers.
- **AC:** cancelling a paid order requires a confirmation step and creates a restock movement; the tracking page never leaks the full address (shows city + departamento only).

### M7 — AI Sales Agent
Detailed in §7. Summary: web widget + WhatsApp, tool-using agent scoped per tenant, budgets per plan, sales attribution.

### M8 — Merchant Admin
- Dashboard: today / 7d / 30d — revenue, orders, average order value, active conversations, **ventas asistidas por IA** (orders whose cart originated from an agent tool call).
- Products (CRUD + CSV), Orders (list with status filters, detail, actions), Customers (auto-created from orders; name, contact, order history).
- Agent config: agent name, tone (`cercano | profesional | juvenil`), welcome message, FAQs editor, policy pages editor, escalation toggle (plan-gated) + Chatwoot inbox link, monthly AI usage meter with plan limit.
- Settings: store info, branding/theme, domains, shipping methods, payment providers, COD zones, billing-fields toggle, notification preferences.
- Staff management (invite/revoke).
- **AC:** every mutation is validated with Zod and audit-logged; a `staff` user cannot reach settings or payment credentials (enforced server-side, verified by tests).

### M9 — Platform Admin
- Tenants: list, search, detail (plan, status, GMV, AI usage/cost month-to-date), assign plan, suspend/reactivate, impersonate (banner shown, every action audit-logged).
- Usage & cost: per-tenant AI tokens and computed cost (input/output pricing constants in config), messages by channel, GMV.
- Subscription tracking (v1 manual): plan, price, paid-until date, notes; auto-suspend N days past due (configurable, default 7) with warning email at N-3.
- Global announcement banner (e.g., maintenance windows).
- **AC:** impersonation sessions expire in 30 min and are visually unmistakable; suspending a tenant takes effect on the storefront in < 60 s.

### M10 — Notifications
- Email (Resend), Spanish templates: order confirmation, payment received, order shipped (+tracking), order delivered, COD confirmation request, merchant new-order alert, plan/limit warnings.
- WhatsApp (when tenant channel connected): pre-approved Cloud API templates for order confirmation / shipped / delivered, sent only to shoppers who provided their number at checkout and ticked consent.
- All sends go through BullMQ with retry + exponential backoff; every attempt logged in `notifications_log`.
- **AC:** a failed email retries 3× then dead-letters with an alert in platform admin; no notification is ever sent twice for the same event (idempotency key = `order_event_id + template`).

---

## 7. AI Sales Agent — Detailed Design

### Channels
1. **Web widget** (`apps/storefront`): floating launcher, streaming responses, product cards rendered from tool results, "abrir carrito" deep links. Session tied to the cart cookie.
2. **WhatsApp:** tenant connects a number (Evolution API in dev, Meta Cloud API in prod). Inbound messages route by phone-number-id → tenant. Same agent core, text-first rendering (product lists as numbered text + short links).

### Core loop
`services/api` module `agent/`: receives message → loads conversation (last 20 messages) + tenant agent config → calls Anthropic Messages API (streaming, tools) → executes requested tools server-side with the tenant-scoped client → persists messages, tool calls, and token usage → streams reply.

### Tools (Zod schemas in `packages/core`, executed server-side, always tenant-scoped)
| Tool | Input | Behavior |
|---|---|---|
| `search_products` | `query, category?, price_max_cents?, limit=5` | Full-text + trigram search; returns id, name, price, availability, url, thumbnail |
| `get_product` | `product_id` | Full details, variants, stock per variant |
| `recommend_products` | `need_description, budget_cents?` | Search + heuristic rerank (in-stock first, bestsellers 30d); ≤ 4 items, each with a one-line reason |
| `create_cart_link` | `items: [{variant_id, qty}]` | Validates stock; creates/updates a cart; returns a short URL that opens the storefront with that cart (works from WhatsApp) |
| `get_order_status` | `order_number, email_or_phone` | Both must match; returns status, timeline, tracking number |
| `get_store_info` | `topic: shipping\|returns\|payments\|contact\|about` | Answers from tenant policy/FAQ content only |
| `escalate_to_human` | `reason, transcript_summary` | Plan-gated; creates a Chatwoot conversation with the summary, notifies merchant; agent tells the customer a human will follow up |

### System prompt template (skeleton — stored in code, filled per tenant)
```
Eres {{agent_name}}, asesor(a) de ventas de {{store_name}}, una tienda en Colombia.
Tono: {{tone_description}}. Respondes en el idioma del cliente (por defecto español).

REGLAS ESTRICTAS:
1. Precios, disponibilidad y datos de productos SOLO provienen de tus herramientas. Si una herramienta falla, dilo con naturalidad; NUNCA inventes precios ni stock.
2. Solo hablas de {{store_name}}: sus productos, envíos, pagos y políticas. Si te preguntan otra cosa, redirige con amabilidad.
3. No ofreces descuentos ni promociones: no existen en esta tienda.
4. Nunca pides datos de tarjetas ni pagos por chat. Para comprar, genera el link de carrito y guía al cliente al checkout.
5. Para consultar un pedido exige número de orden Y el correo o celular con que se compró.
6. Sé breve: mensajes cortos, máximo un producto destacado por mensaje en WhatsApp.
7. Si el cliente está molesto, pide hablar con una persona, o llevas 3 intentos sin resolver: usa escalate_to_human.

Sobre la tienda: {{store_summary}}
Políticas clave: {{policies_summary}}
```

### Guardrails & limits
- Prices/stock only from tools (enforced by prompt + spot-check evals).
- Budgets: `agent_usage` per tenant per month; at 90% → merchant warning; at 100% → agent replies with a fixed fallback (contact form / store WhatsApp) and stops calling the model. Hard cap, no exceptions.
- Rate limit: 20 messages / 5 min per conversation; simple abuse filter (repeated identical messages → cool-down).
- PII: agent never echoes full addresses; order lookups require the double factor above.
- Attribution: carts created via `create_cart_link` get `source = 'agent'`; orders inherit it → powers the "ventas asistidas por IA" KPI.

### Conversation storage
`conversations` (tenant, channel, shopper ref, status, started_at) + `messages` (role, content, tool_calls jsonb, input_tokens, output_tokens). Retention: 12 months, then purge job.

### Evals (part of Phase 4 DoD)
Scripted scenarios run as integration tests (recorded fixtures in CI, live-API smoke suite run manually):
1. Recommends within a stated budget and never exceeds it.
2. Admits out-of-stock honestly; offers an in-stock alternative.
3. Rejects order lookup with mismatched email/phone.
4. Declines off-topic requests (tarea de física, competitor comparison) politely, in character.
5. Escalates after explicit "quiero hablar con una persona".
6. Never states a price that differs from the tool result.

---

## 8. Data Model (core tables — key columns only)

- `tenants` — id, slug, name, status, plan, theme jsonb, agent_config jsonb, settings jsonb
- `tenant_domains` — tenant_id, domain (unique), is_primary, verified_at
- `tenant_limits` — tenant_id, products_max, ai_messages_month, staff_seats, custom_domain, human_handoff, whatsapp_channel
- `users` / `memberships` — user_id, tenant_id, role (`owner | staff | platform_admin`)
- `categories` — tenant_id, name, slug, position
- `products` — tenant_id, name, slug, description_md, price_cents, compare_at_cents, cost_cents, sku, stock, track_inventory, tax_rate, status, seo jsonb
- `product_variants` — product_id, option1..3, price_cents, sku, stock
- `product_images` — product_id, url, alt, position
- `inventory_movements` — tenant_id, variant_id, delta, reason, order_id?, actor
- `carts` / `cart_items` — cart: tenant_id, cookie_key, source (`web | agent`), expires_at
- `customers` — tenant_id, email, phone, name, orders_count, total_spent_cents
- `orders` — tenant_id, number (per-tenant seq), status, payment_status, payment_provider, customer_id, email, phone, shipping_address jsonb, billing_fields jsonb?, shipping_method, shipping_cents, subtotal_cents, tax_cents, total_cents, source, created_at
- `order_items` — order_id, variant_id, name_snapshot, price_cents_snapshot, qty, tax_rate_snapshot
- `order_events` — order_id, type, actor (`merchant | system | webhook | agent`), data jsonb, created_at
- `payments` — order_id, provider, provider_ref, amount_cents, status, raw jsonb
- `webhook_events` — provider, event_id (unique with provider), tenant_id, payload jsonb, processed_at, result
- `conversations` / `messages` — see §7
- `agent_usage` — tenant_id, month, input_tokens, output_tokens, cost_cents, messages_count
- `tenant_content` — tenant_id, type (`faq | policy_shipping | policy_returns | policy_privacy | about`), title, body_md
- `notifications_log` — tenant_id, channel, template, recipient, idempotency_key (unique), status, attempts
- `subscriptions` — tenant_id, plan, price_cents, paid_until, notes
- `audit_log` — tenant_id?, actor_user_id, action, entity, entity_id, data jsonb, ip
- `shipments` — order_id, provider, tracking_number, status, raw jsonb *(Phase 2 — table created, unused)*
- `invoices` — order_id, provider, cufe, status, raw jsonb *(Phase 2 — DIAN, table created, unused)*

---

## 9. Non-Functional Requirements

**Security:** OWASP Top 10 checklist per phase · httpOnly sessions · CSRF on admin mutations · Zod validation at every boundary · rate limiting (Redis) on auth, checkout, agent, webhooks · provider credentials encrypted (AES-256-GCM) · audit log on all admin/platform mutations · **cross-tenant isolation test suite**: authenticated attempts to read/write another tenant's products, orders, and conversations must fail at both API and RLS layers.

**Privacy (Ley 1581 — Habeas Data):** per-tenant privacy policy template (autofilled with store data) · customer data deletion flow: request → anonymize orders (keep amounts for accounting, strip PII) · agent conversations covered by the same retention/purge policy.

**Reliability:** nightly `pg_dump` to R2 (30-day retention) + weekly restore drill script · health endpoints per service · Sentry alerts · BullMQ dashboards.

**Performance:** storefront LCP < 2.5 s mobile · API p95 < 300 ms (non-AI endpoints) · catalog reads cached (Redis + ISR tags) · images through R2 + `next/image`.

**Testing:** unit (domain logic: totals/tax rounding, stock reservation, order state machine) · integration (API + Testcontainers) · e2e (Playwright): COD purchase, one online purchase per gateway sandbox, agent widget smoke, admin CRUD smoke.

---

## 10. Phase-2-Ready Hooks (build the sockets, not the appliances)

- **DIAN e-invoicing:** checkout billing-fields toggle (M4) captures documento + razón social; `invoices` table exists; issuance via a provider API (evaluate Alegra vs Siigo vs Factus when Phase 2 starts).
- **Couriers:** `shipments` table + a `ShippingProvider` adapter interface defined in `packages/core` (unimplemented). v1 uses free-text carrier + tracking number.
- **Refunds:** `refund?` on `PaymentProvider`, unimplemented; manual process documented for merchants.
- **Embeddings:** `pgvector` installed; if catalog search quality demands it, add embedding-based retrieval for `recommend_products` without schema surgery.

---

## 11. Build Phases (Claude Code roadmap)

> Per phase: read the mapped sections → brainstorm open questions → write a task-level implementation plan → execute with TDD → run the phase DoD checklist before moving on. One phase per working session (or less); never start a phase with the previous DoD red.

**P0 — Foundation** *(§4, §5)*
Monorepo scaffold, Docker Compose dev env (pg + redis + caddy + chatwoot), Prisma schema v1 + migrations, RLS harness + tenant-scoped client extension, better-auth, tenant resolution middleware, CI (lint, typecheck, tests).
**DoD:** two seeded tenants resolve by subdomain locally; cross-tenant read attempt fails in an automated test; CI green.

**P1 — Catalog + Admin core** *(M1, M2, M8 partial)*
Onboarding wizard, products/variants/categories CRUD, CSV import, image uploads to R2, staff roles.
**DoD:** M1 + M2 acceptance criteria pass; a non-technical tester creates a store with 10 products from a CSV without help.

**P2 — Storefront + Cart + Checkout (COD end-to-end)** *(M3, M4, M6 partial, M10 partial)*
Public storefront with theming, search, cart, full checkout with Colombian addresses and shipping methods, COD orders, order emails, tracking page.
**DoD:** first complete sale: browse → checkout → COD order → merchant confirms → shipped → delivered, with emails at each step; Lighthouse budget met.

**P3 — Online Payments + Order lifecycle** *(M5, M6, M10)*
`PaymentProvider` interface, **Wompi**, then **Mercado Pago**, then **ePayco**; webhooks + idempotency + reconciliation job; stock reservation TTL; full notifications.
**DoD:** sandbox purchase succeeds on all three gateways; webhook replay test passes; abandoned checkout releases stock; payment_status transitions fully covered by tests. *(Shipped as P3a/P3b/P3c — see the README's Phase status for what was and wasn't verified live, notably that no real gateway sandbox account was available and that the reconciliation job's threshold deviates from M5's "30 min" above for the reason footnoted there.)*

**P4 — AI Agent (web)** *(§7, M7, M8 agent config)*
Agent module, all seven tools, streaming widget, per-tenant config UI, budgets + usage metering, attribution KPI, eval suite.
**DoD:** all six eval scenarios pass; budget hard-cap verified; an agent-created cart converts to an order flagged `source=agent`.

**P5 — WhatsApp + Human handoff** *(§7 channels)*
Evolution API (dev) / Cloud API (prod) integration, number connection flow in admin, message routing, WhatsApp rendering of tools, Chatwoot escalation, WhatsApp order notifications.
**DoD:** full WhatsApp conversation → cart link → purchase on a test tenant; escalation lands in Chatwoot with the transcript summary; template notifications delivered.

**P6 — Platform Admin + Hardening + Pilot** *(M9, §9)*
Platform admin, plans/limits enforcement, custom domains + on-demand TLS, subscription tracking + auto-suspend, backups + restore drill, load test (100 concurrent checkouts), security checklist pass, pilot with 2–3 real stores.
**DoD:** isolation suite green under load; restore drill documented and executed; two pilot merchants live on custom domains.

---

## 12. Repository Structure

```
ventia/
├── apps/
│   ├── storefront/          # Next.js 15 — public stores + chat widget
│   └── admin/               # Next.js 15 — merchant + platform admin
├── services/
│   └── api/                 # NestJS — REST, webhooks, queues
│       └── src/modules/
│           ├── tenants/  ├── catalog/  ├── carts/  ├── checkout/
│           ├── orders/   ├── payments/ ├── agent/  ├── whatsapp/
│           ├── notifications/ ├── platform/ └── auth/
├── packages/
│   ├── db/                  # Prisma schema, migrations, tenant-scoped client
│   ├── core/                # Zod schemas, tool defs, DANE dept/municipio data
│   ├── payments/            # Wompi / MercadoPago / ePayco adapters
│   └── ui/                  # Shared React components + theming
├── docker/                  # compose files, Caddyfile
├── docs/
│   ├── SPEC.md              # this document
│   └── plans/               # per-phase implementation plans
└── turbo.json / pnpm-workspace.yaml
```

---

## 13. Environment Variables (checklist)

```
DATABASE_URL, REDIS_URL
AUTH_SECRET, APP_ENCRYPTION_KEY          # AES key for provider credentials
R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PUBLIC_URL
ANTHROPIC_API_KEY, AGENT_MODEL=claude-sonnet-4-6
RESEND_API_KEY, EMAIL_FROM
PLATFORM_ROOT_DOMAIN=ventia.co
SENTRY_DSN
# Per-tenant (stored encrypted in DB, not env): Wompi/MP/ePayco keys, WhatsApp tokens
EVOLUTION_API_URL, EVOLUTION_API_KEY     # dev WhatsApp
WHATSAPP_CLOUD_API_TOKEN                 # prod (per-tenant in DB; env only for platform test number)
CHATWOOT_URL, CHATWOOT_API_TOKEN
```

---

## 14. Definition of Done — project level

1. All phase DoDs green.
2. A real merchant can: sign up → configure → import products → connect Wompi → sell online and by COD → let the AI agent close a sale on web and WhatsApp → track it to delivery — without touching a terminal.
3. Platform admin shows accurate AI cost per tenant.
4. Cross-tenant isolation, webhook idempotency, and money-rounding tests pass in CI.
5. Docs: merchant quickstart (Spanish), ops runbook (deploy, backup/restore, incident basics).
