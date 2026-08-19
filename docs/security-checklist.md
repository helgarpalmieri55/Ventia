# Security checklist — SPEC §9

An audit of SPEC.md §9's security requirements against the code, done as the
P6 DoD item ("security checklist pass"). Each row states what was **verified**,
not what was intended. Where a requirement is unmet, it says so.

---

## Security

| Requirement | Status | Verified how |
|---|---|---|
| httpOnly sessions | ✅ | `test/session-cookie.test.ts` asserts the real `Set-Cookie` from a live sign-in |
| CSRF on admin mutations | ✅ — but see note | `/v1/auth/*` by better-auth's origin check (`trustedOrigins`, admin.module.ts). `/v1/admin/*` by `SameSite`, now pinned |
| Zod validation at every boundary | ✅ | Every controller parses through `@ventia/core` schemas via `parseOr400`; the agent's tool inputs likewise |
| Rate limiting on auth, checkout, agent, webhooks | ✅ | Four limiters in `main.ts`; `test/rate-limit-wiring.test.ts` proves each is mounted |
| Provider credentials encrypted (AES-256-GCM) | ✅ | `payments/encryption.ts`; same scheme reused for WhatsApp credentials |
| Audit log on all admin/platform mutations | ✅ — **was not** | Order transitions had zero audit calls. Fixed in `96347cc` |
| Cross-tenant isolation suite | ✅ | `packages/db/test/rls.test.ts` at the RLS layer, plus per-feature API-layer tests |
| Platform-operator access requires two independent grants | ✅ | `PLATFORM_ADMIN_EMAILS` (deployment config) **and** `User.isPlatformAdmin` (a column no product code path writes), plus a verified email. `test/platform-admin.test.ts` pins each direction separately |
| Connection-pool exhaustion under checkout load | ✅ — **was not** | A `tenantDb()` read inside `platformDb.$transaction()` deadlocked at 100 concurrent checkouts: 7 served, 93 bare 500s. Fixed; `scripts/load-test.mjs` reproduces and now passes 100/100 on the default pool |

### Note on CSRF for `/v1/admin/*`

This is the one requirement whose mechanism is invisible in this repo's source.
`/v1/auth/*` has an explicit, greppable origin check. Products, orders,
settings, staff and WhatsApp numbers have **no** CSRF token and **no** origin
check — their entire protection is the session cookie's `SameSite` attribute,
which is a default inside a dependency.

That is adequate but was unpinned: a future better-auth release, or a config
change made for an unrelated reason, could flip it to `None` and turn every
admin mutation into a cross-site-triggerable action, with no test in this repo
failing. `test/session-cookie.test.ts` now asserts it.

If the admin app ever needs cross-site cookie delivery for some other reason,
`SameSite=None` becomes necessary and this protection evaporates — at which
point a real CSRF token is required, not optional.

## Found and fixed while auditing

**Order transitions were not audit-logged.** Thirteen files called
`writeAudit`; `orders.controller.ts` and `orders.service.ts` called it zero
times. That left order state as the one consequential merchant action with no
trail — and it is the action a dispute is argued over, moves money and stock,
and is routinely performed by staff rather than the owner. Fixed in `96347cc`,
with the audit written *after* the transition so a rejected one leaves no row.

**Two plan limits failed open.** `productsMax` and `staffSeats` returned early
on a missing `TenantLimits` row while the other four failed closed. Addressed
in `7ab3713`; the posture is now a required named argument at each call site.
The fail-open default itself is documented there as deliberately not yet
flipped, with the reason and the flip path.

## Privacy (Ley 1581 — Habeas Data)

| Requirement | Status |
|---|---|
| Per-tenant privacy policy template, autofilled with store data | ✅ Generator in `services/api/src/settings/privacy-policy.template.ts` |
| Customer data deletion → anonymize orders, strip PII, keep amounts | ✅ `POST /v1/admin/customers/:id/anonymize` |
| Agent conversations under the same retention/purge policy | ✅ Nightly sweep, `AGENT_RETENTION_MONTHS` (default 12) |
| Prior, express and informed authorization at collection (art. 9) | 🚧 See below |

All three SPEC §9 requirements are built. Notes on what each one actually
guarantees, since "✅" is doing a lot of work in a table:

**The policy template** follows Decreto 1074 de 2015 art. 2.2.2.25.3.1's
minimum contents rather than plausible-sounding sections, and states only what
the code actually does — data categories are read off `checkoutAddressSchema`
and the real columns, gateways are listed from those the tenant has credentials
for, and the WhatsApp/AI paragraphs appear only for a tenant configured for
them. Generation never publishes; the merchant reviews and saves. The
merchant-facing disclaimer says plainly that Ventia is *Encargado* and the
merchant is *Responsable*, and it never enters the published text. A store that
has published nothing still gets no fabricated policy — that would be a legal
statement made in the merchant's name.

**Anonymization, not deletion**, because Colombian accounting law requires the
transaction to survive. Amounts, dates, status, order numbers and
`InventoryMovement` are untouched; names, emails, phones, addresses,
conversations, notification recipients, audit payloads and webhook payloads are
rewritten in place. The load-bearing test does not trust the ORM: it enumerates
every base table in `information_schema` and scans each for the PII strings,
so it covers columns this service never mentions. Idempotent without a schema
flag. Known gaps are listed in the commit and in the service's doc comments —
webhook rows with a null `orderId`, web-widget conversations with a null
`shopperRef`, and `Payment.raw` (verified PII-free today, not guaranteed
against a future writer).

**Retention** protects escalated conversations at any age, and protects any
conversation with activity since the cutoff — the latter matters more than it
sounds, because a returning WhatsApp shopper writes into the same row for
years, so an age-since-creation test would delete live threads. `AgentUsage`
survives; it carries no PII and deleting it would corrupt billing history.

**The remaining gap is consent at collection.** Checkout takes the shopper's
name, email, phone and address; a completed purchase is defensible as a
*conducta inequívoca* under Decreto 1377 art. 7, which is how the generated
policy words it, but art. 9 wants authorization prior, express and informed,
and art. 8 gives the Titular a right to *prueba de la autorización*. That is
tracked and being built.

## Reliability

| Requirement | Status |
|---|---|
| Nightly `pg_dump` + weekly restore drill | 🚧 Scripts in `scripts/`; see `docs/operations.md` for what was actually executed |
| Offsite copy of the backup (SPEC §10's R2) | ✅ `scripts/backup-upload.mjs` — verified by read-back, and the *downloaded* copy passed the full restore drill 15/15. Exercised against the compose MinIO; real R2 credentials are a deploy-time step |
| Health endpoints | ✅ `/v1/health`, deliberately excluded from tenant resolution so it does not depend on DB/Redis |
| Sentry alerts | ❌ Not wired |
| BullMQ dashboards | ❌ Not wired |

The cron itself is not set up, and nothing alerts on a failed nightly run — a
backup script whose failures go to a logfile nobody reads is a backup nobody
has. That is the honest state of §10, and it is a deployment task rather than a
code one.

## What this audit did not cover

- **Dependency vulnerabilities.** No `pnpm audit` gate in CI.
- **Penetration testing** of the storefront and admin apps.
- **Secrets in CI.** The GitHub Actions workflow was not reviewed for secret
  handling.
- **The live payment gateways.** No real sandbox account was available at any
  point in this project, so the Wompi/Mercado Pago/ePayco adapters remain
  verified against recorded fixtures only — as does the WhatsApp Cloud API
  adapter (see `docs/deploying-whatsapp.md`).
