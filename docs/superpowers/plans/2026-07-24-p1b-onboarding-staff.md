# P1b — Onboarding + Staff + Tenant Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Server side of M1: merchant signup provisions a tenant, resumable onboarding wizard state, owner-only settings (store info, branding, COD), staff invites with seat limits, email-verification-gated launch checklist (`draft → live`), and suspended-tenant semantics (storefront 503, admin read-only).

**Architecture:** New NestJS modules `onboarding/`, `settings/`, `staff/` under `services/api/src/`; a `mailer/` abstraction (console transport in dev, Resend adapter is P2). Builds directly on P1a's admin guards, catalog, and the manual RLS transaction pattern. Admin endpoints under `/v1/admin/*` derive tenant from session; public storefront resolution is untouched except suspended → 503.

**Tech Stack:** unchanged from P1a (NestJS 10, Prisma 6, Zod in @ventia/core, Vitest + Testcontainers).

## Global Constraints (spec §4 + P1a conventions)

- TypeScript strict; TDD with genuine RED; conventional commits; English code/comments, es-CO user-facing copy.
- Every mutation: `parseOr400` + `writeAudit` (best-effort) + tenant-scoped access (`tenantDb` or the manual RLS escape for multi-op transactions).
- Typed errors only — no raw 500s for expected failures. Reuse `{ error: CODE, details? }`.
- `staff` role must be blocked server-side from settings/staff/launch endpoints (`@Roles('owner')`) — spec M8 AC, and the FORBIDDEN_ROLE guard branch MUST gain its first real tests here.
- Git identity before commits: `git config user.email noreply@anthropic.com && git config user.name Claude`.
- Baseline entering P1b: api 89, db 16, core 10, storefront 2 — stays green throughout.
- NOTE for first migration in this phase: run a literal `prisma migrate dev` once (TTY available in Bash here) to smoke the shadow-DB fix; anyone holding a pre-hardening dev DB must recreate it (checksum change) — the compose volume recreate + `migrate deploy` + seed recipe is in the P1a hardening report.

---

### Task 1: Session narrowing + P1a leftovers

**Files:** Modify `services/api/src/admin/admin-session.guard.ts`, `services/api/src/admin/roles.decorator.ts`, `services/api/src/auth/session-context.ts`, `services/api/src/csv-import/csv-import.service.ts`; update all `session.tenantId!` call sites. Tests: extend existing files.

**Interfaces:**
- Produces `AdminSessionContext = { userId: string; email: string; tenantId: string; role: 'owner' | 'staff' }` (non-nullable tenantId/role) — the guard narrows and attaches this type; `AdminSession()` decorator returns it; all catalog/csv services drop the `!` assertions.
- `getSessionContext` membership lookup becomes deterministic: `findFirst({ where: { userId }, orderBy: { createdAt: 'asc' } })` — requires adding `createdAt DateTime @default(now())` to `Membership` (FIRST MIGRATION of the phase — run literal `prisma migrate dev --name membership_created_at` as the smoke).
- CSV `resolveCategoryId`: every created slug (base or `categoria-N`) registers in `takenCategorySlugs` and both paths check it (closes the cross-pool P2002 edge; add the two-name collision test from the phase re-review).

Steps: RED (membership determinism test with two memberships; csv collision test) → migrate + implement → GREEN full suite → commit `refactor: narrow admin session context and close csv slug edge`.

---

### Task 2: Mailer abstraction + email verification

**Files:** Create `services/api/src/mailer/mailer.ts`, `mailer.module.ts`. Modify `services/api/src/admin/auth-instance.ts` (better-auth `emailVerification` wiring). Test: `services/api/test/email-verification.test.ts`.

**Interfaces:**
- `interface Mailer { send(msg: { to: string; subject: string; text: string; html?: string }): Promise<void> }`; `ConsoleMailer` logs `[mail] to=<to> subject=<subject>` + body (dev + tests); `MAILER` injection token. Resend adapter is P2 — do NOT add it.
- better-auth config gains `emailVerification: { sendVerificationEmail: async ({ user, url }) => mailer.send(...) }` (verify exact option names against installed better-auth 1.6.x — read node_modules types, not memory). `requireEmailVerification` stays false (launch gate enforces it instead, Task 6).
- `GET /v1/admin/me` response gains `emailVerified: boolean` (from the better-auth user).
- Tests: signup triggers a verification send (spy/capture ConsoleMailer); hitting the verification URL flips `user.emailVerified`; /v1/admin/me reflects it.

Steps: RED → implement → GREEN → commit `feat: add mailer abstraction and email verification flow`.

---

### Task 3: Onboarding — tenant provisioning + wizard state

**Files:** Create `services/api/src/onboarding/onboarding.controller.ts`, `onboarding.service.ts`, `onboarding.module.ts`; Zod schemas in `packages/core/src/onboarding-schemas.ts` (export from index). Test: `services/api/test/onboarding.test.ts`.

**Interfaces (all authenticated; provisioning requires session WITHOUT tenant — the NO_TENANT case):**
- `POST /v1/admin/onboarding/tenant` body `{ storeName: string(2..80), slug?: string }` → creates Tenant (status `draft`, plan `basico`, slug = provided or slugify(storeName), dedup `-2..-20` against existing tenants, 409 `SLUG_TAKEN` after), TenantLimits from `PLANS.basico`, TenantDomain `{slug}.ventia.localhost` (dev root domain from env `PLATFORM_ROOT_DOMAIN`), Membership owner — all in ONE `platformDb.$transaction` (system context: tenant creation precedes tenant scope; comment why). Rejects 409 `ALREADY_HAS_TENANT` if session already has a membership. Returns the new AdminSessionContext shape + tenant.
- `GET /v1/admin/onboarding` → `{ steps: OnboardingState, checklist: LaunchChecklist }` (checklist computed live — see Task 6 shape).
- `PATCH /v1/admin/onboarding` body `{ step: 'store_info' | 'branding' | 'products' | 'payments', data?: {...} }` → merges into `tenants.settings.onboarding[step] = { done: true, ...data }`; `store_info` data: `{ category?: string(≤60), contactEmail?: email, contactPhone?: string(≤20), description?: string(≤500) }` stored in `settings.storeInfo`; `payments` data: `{ codEnabled: boolean }` → `settings.payments.codEnabled`. Owner-only (`@Roles('owner')`).
- Audit: 'onboarding.tenant_create', 'onboarding.step'.
- Tests: provisioning happy path (all four rows, domain shape, membership owner, /v1/admin/me works after); double-provision 409; slug dedup; staff cannot PATCH onboarding (403 FORBIDDEN_ROLE — first of the rider tests); step merge is additive (two PATCHes, both persist); cross-tenant invisible.

Steps: RED → implement → GREEN → commit `feat: add tenant provisioning and onboarding wizard state`.

---

### Task 4: Settings — store info, branding, COD (owner-only)

**Files:** Create `services/api/src/settings/settings.controller.ts`, `settings.module.ts`; `packages/core/src/settings-schemas.ts`. Test: `services/api/test/settings.test.ts`.

**Interfaces (`@Roles('owner')` at controller level):**
- `GET /v1/admin/settings` → `{ storeInfo, theme, payments: { codEnabled }, status, slug, name }` (from Tenant row; theme from `tenants.theme`).
- `PATCH /v1/admin/settings/store` body `{ name?: string(2..80), storeInfo?: { category?, contactEmail?, contactPhone?, description? } }` → updates Tenant.name and/or merges settings.storeInfo.
- `PUT /v1/admin/settings/theme` body themeSchema: `{ logoUrl?: url, faviconUrl?: url, colors: { primary, background, foreground } (each `^#[0-9a-fA-F]{6}$`), fontPair: z.enum(['inter-lora','poppins-source','montserrat-merriweather','raleway-open','worksans-bitter']), radius: z.enum(['none','sm','md','lg','full']) }` → replaces `tenants.theme` (spec §5.4 fixed catalog of 5 pairs).
- `PATCH /v1/admin/settings/payments` body `{ codEnabled: boolean }` → merges settings.payments.
- Audit each ('settings.store', 'settings.theme', 'settings.payments').
- Tests: each endpoint happy path; **staff gets 403 FORBIDDEN_ROLE on every settings route (M8 AC — assert the exact error body)**; invalid hex color / unknown fontPair → 400; theme PUT fully replaces (old keys gone).

Steps: RED → implement → GREEN → commit `feat: add owner-only store settings endpoints`.

---

### Task 5: Staff invites with seat limits

**Files:** Create `services/api/src/staff/staff.controller.ts`, `staff.service.ts`, `staff.module.ts`; migration `staff_invites` adding model `StaffInvite { id uuid pk, tenantId uuid, email, tokenHash (sha256 hex, unique), role 'staff', expiresAt, acceptedAt?, revokedAt?, createdAt }` (+ RLS policy: append a guarded migration adding `StaffInvite` to the tenant-isolation policy set — same SQL shape as the P0 rls migration for one table; and REVOKE is NOT needed — it's a tenant table). Test: `services/api/test/staff.test.ts`.

**Interfaces:**
- `POST /v1/admin/staff/invites` (`@Roles('owner')`) body `{ email }` → seat check: count memberships with role 'staff' + pending invites vs `tenantLimits.staffSeats`; over → 402 `{ error: 'PLAN_LIMIT_EXCEEDED', details: { limit } }`. Creates invite (raw token = crypto.randomUUID + randomBytes → 48 hex chars; store sha256 hash only), 7-day expiry, mails the accept link (`{API_URL}/v1/staff/accept?token=...` — text contains the link; UI page is P1c), audit 'staff.invite'. Duplicate pending invite for same email → 409 `INVITE_EXISTS`. Email already a member → 409 `ALREADY_MEMBER`.
- `GET /v1/admin/staff` (`@Roles('owner')`) → `{ members: [{ userId, email, role, createdAt }], invites: [{ id, email, expiresAt, createdAt }] }` (pending only).
- `DELETE /v1/admin/staff/invites/:id` (`@Roles('owner')`) → revoke (set revokedAt), 204. `DELETE /v1/admin/staff/:userId` (`@Roles('owner')`) → removes the staff membership (owner cannot remove self/owner → 400 `CANNOT_REMOVE_OWNER`), audit 'staff.remove'.
- `POST /v1/staff/accept` (public, authenticated session required) body `{ token }` → hash lookup (unexpired, unaccepted, unrevoked → else 400 `INVITE_INVALID`); session user must have NO membership yet (else 409 `ALREADY_HAS_TENANT`); email match NOT required (invite link is the credential; document). Creates Membership staff + sets acceptedAt (transaction). Audit 'staff.accept'.
- Tests: invite→accept flow end-to-end (new user signup → accept → /v1/admin/me shows staff+tenant); seat limit 402 (staffSeats=1 fixture); expired token 400; revoked token 400; double-accept 400; staff cannot invite (403); remove staff → their /v1/admin/me returns NO_TENANT; cross-tenant: owner of tenant B cannot revoke tenant A's invite (404).

Steps: RED → migration (literal `prisma migrate dev` — the TTY smoke if Task 1 didn't already) → implement → GREEN → commit `feat: add staff invites with seat limits`.

---

### Task 6: Launch checklist + lifecycle (draft → live, suspended semantics)

**Files:** Create `services/api/src/onboarding/launch.controller.ts` (in onboarding module); modify `services/api/src/tenants/tenant.middleware.ts` + `apps/storefront/app/page.tsx` (suspended → 503/message); modify `services/api/src/admin/admin-session.guard.ts` (read-only enforcement). Test: `services/api/test/launch.test.ts` + extend storefront test.

**Interfaces:**
- `LaunchChecklist = { storeInfo: boolean, emailVerified: boolean, hasActiveProduct: boolean, paymentsReady: boolean (codEnabled true — gateways P3), ready: boolean }` — computed: storeInfo = settings.storeInfo.contactEmail present & tenant.name set; emailVerified from the OWNER user; hasActiveProduct = any product status 'active'; ready = all true.
- `POST /v1/admin/launch` (`@Roles('owner')`) → checklist not ready → 422 `{ error: 'LAUNCH_CHECKLIST_INCOMPLETE', details: checklist }`; ready → tenant.status 'live', audit 'tenant.launch'. Idempotent (already live → 200 same shape).
- Suspended semantics (suspension tooling is P6; semantics land now): tenant middleware exposes status (already does); API: a small guard/middleware for `/v1/admin/*` — if tenant status 'suspended', allow GET, reject mutations (405-style 403 `{ error: 'TENANT_SUSPENDED' }`); storefront page renders "Tienda temporalmente no disponible" for suspended tenants (returns 503 status via Next's response? — Next App Router page can't set 503 easily: acceptable P1 form = render the unavailable message; the strict 503 lands with the storefront rebuild in P2 — note this deviation in the report).
- Tests: launch blocked with exact missing items in details; verify email + add active product + COD → launch succeeds → tenant live; staff cannot launch (403); suspended tenant (set via platformDb): admin GET ok, admin POST/PATCH → 403 TENANT_SUSPENDED, storefront shows unavailable message.

Steps: RED → implement → GREEN → commit `feat: add launch checklist and suspended-tenant semantics`.

---

### Task 7: P1b wrap-up — full gate + M1 smoke + docs

**Files:** Modify `README.md` (≤ 12 lines: onboarding/staff/launch endpoints note, mailer note).

**Steps:**
- [ ] `pnpm turbo run lint typecheck build` + `pnpm turbo run test` — green (api expected ~120+).
- [ ] Manual M1 smoke against dev stack (capture in report): fresh signup → provision tenant → onboarding steps → verify email (console URL) → create active product → enable COD → launch → storefront shows the tenant home on `{slug}.ventia.localhost`; invite a staff user → accept → staff sees catalog but 403 on settings. This is the M1 AC path (≤15 min self-serve).
- [ ] README + commit `docs: document onboarding, staff, and launch flow`.

---

## Self-Review Notes

- M1 coverage: signup/provisioning (T3), resumable wizard (T3), staff invites/revoke (T5), verification-gated launch (T2+T6), suspended semantics (T6 — storefront strict 503 deferred to P2's rebuild, documented). M8 AC (staff blocked from settings, server-side, tested) in T4+T5+T6.
- Riders from P1a phase review all land in T1 (narrowing, determinism, csv edge) and T4 (FORBIDDEN_ROLE tests); migrate-dev TTY smoke in T1/T5 migrations.
- Consistency: AdminSessionContext type change (T1) ripples through all P1a controllers — T1 must keep the whole suite green, not just its new tests.
- Judgment calls recorded: invite accept doesn't require email match (link is credential); suspended storefront renders message without literal 503 until P2; ALREADY_HAS_TENANT keeps P1 single-tenant-per-user (multi-store is out of v1 scope).
