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
| Per-tenant privacy policy template | ✅ Seeded as `policy_privacy` tenant content |
| Customer data deletion → anonymize orders, strip PII, keep amounts | ❌ **Not built** |
| Agent conversations under the same retention/purge policy | ❌ **Not built** |

These two are the largest outstanding gap in this document, and they are a
**legal** requirement in Colombia rather than a nice-to-have. Neither is
technically difficult — the shape is a request endpoint plus a job that nulls
PII columns while preserving `totalCents` for accounting, and a purge job for
conversations older than the retention window (SPEC §7 says 12 months). They
are called out here rather than silently omitted because a platform selling to
Colombian SMBs cannot ship to real merchants without them.

## Reliability

| Requirement | Status |
|---|---|
| Nightly `pg_dump` + weekly restore drill | 🚧 Scripts in `scripts/`; see `docs/operations.md` for what was actually executed |
| Health endpoints | ✅ `/v1/health`, deliberately excluded from tenant resolution so it does not depend on DB/Redis |
| Sentry alerts | ❌ Not wired |
| BullMQ dashboards | ❌ Not wired |

## What this audit did not cover

- **Dependency vulnerabilities.** No `pnpm audit` gate in CI.
- **Penetration testing** of the storefront and admin apps.
- **Secrets in CI.** The GitHub Actions workflow was not reviewed for secret
  handling.
- **The live payment gateways.** No real sandbox account was available at any
  point in this project, so the Wompi/Mercado Pago/ePayco adapters remain
  verified against recorded fixtures only — as does the WhatsApp Cloud API
  adapter (see `docs/deploying-whatsapp.md`).
