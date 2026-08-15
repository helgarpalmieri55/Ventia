# P3b — Mercado Pago + ePayco Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A shopper can choose "Mercado Pago" or "ePayco" alongside the existing
"Contra entrega"/"Wompi" options at checkout, gets redirected to that gateway's
hosted checkout, and its webhook/confirmation POST automatically transitions the
order — exactly the way `wompi` already does (P3a). The merchant enters Mercado
Pago/ePayco credentials in new sections of the existing admin "Pagos" tab.

**Architecture:** Two new `PaymentProvider` implementations in `packages/payments`
(`mercadopago.ts`, `epayco.ts`). `services/api/src/payments/`'s registry, webhook
controller, and stock-reservation worker are already provider-agnostic (P3a) and
need no changes beyond two new registry entries. `services/api/src/checkout/`'s
wompi-specific branches generalize to any non-`cod` `PaymentProviderId` (a
mechanical refactor, zero behavior change for `cod`/`wompi`). One genuinely new
piece of infrastructure: a thin storefront bridge page for ePayco, whose real
checkout flow is a client-side JS widget rather than a plain redirect URL (see
design doc decision 6) — everything else reuses P3a's plumbing untouched.

**Tech Stack:** NestJS 10 · `@ventia/core` (2 new zod schemas) · Node's built-in
`crypto` (SHA-256 for ePayco's confirmation signature, HMAC-SHA256 for Mercado
Pago's webhook signature — no new dependency) · Vitest + Testcontainers ·
mocked-`fetch` unit tests for both adapters (no live sandbox account available in
this environment, same posture as P3a Task 2's Wompi tests).

## Global Constraints

- All UI copy es-CO Spanish; code/comments/commits English. TypeScript strict.
  Conventional commits.
- Every existing `cod`/`wompi` code path (the full P2b/P2c/P3a test suites) must
  remain byte-for-byte unregressed — run the FULL `pnpm turbo run test` after every
  task, not just the new/changed file's own suite. Task 1 (the checkout
  generalization) is the highest-risk task for an accidental regression here, since
  it touches already-shipped, already-reviewed code.
- **Read the real docs at implementation time — do not implement from memory.**
  Design doc decisions 4–7 already cite real, fetched source URLs and explicitly
  flag which facts are lower-confidence (Mercado Pago's test-credential prefix and
  `GET /v1/payments/:id` response schema; ePayco's `x_cod_response` numeric mapping,
  `getTransactionStatus` endpoint, and post-payment return-redirect widget
  parameter). Each adapter task below must re-verify anything flagged lower-confidence
  in the design doc against a real, directly-fetched page before shipping code that
  depends on it — do not silently propagate an unverified guess into production code.
  Report explicitly, in each task's commit body, which facts were freshly verified
  vs. carried over from the design doc's own citations.
- Typed error convention unchanged: `{ error: CODE, details? }`. No new error codes
  are anticipated — `PAYMENT_PROVIDER_NOT_CONFIGURED`/`WEBHOOK_INVALID_SIGNATURE`/
  `WEBHOOK_UNKNOWN_PROVIDER` (P3a) already cover every failure mode this phase
  introduces, since the registry/webhook controller are unchanged.
- No refunds, no P3c reconciliation job, no new "waiting for payment" storefront
  state — see the design doc's "Out of scope."
- No schema migration needed (see design doc's Architecture §0) — only
  `TenantProviderConfig` (a `packages/payments` TS interface, not a DB shape) gains
  one new optional field.

## Task sequence

### Task 1: Generalize checkout's payment-method branching to any online provider

**Files:**
- Modify: `services/api/src/checkout/checkout.service.ts`,
  `services/api/src/checkout/checkout.controller.ts`
- Test: extend `services/api/test/checkout.test.ts` (no new describe blocks
  needed if the existing `cod`/`wompi` tests all still pass unchanged — that IS
  the test for this task; add one small new test only if you introduce any new
  branch point worth covering directly, e.g. the widened `paymentMethod` type
  accepting `'mercadopago'`/`'epayco'` at the validation layer before a real
  adapter exists for them yet — see the note below)

**This task intentionally ships BEFORE either new adapter exists.** After this
task, `checkout.controller.ts` accepts `paymentMethod: 'mercadopago' | 'epayco'`
at the validation layer and routes to `getProvider(...)` exactly like `wompi`
does — which will correctly throw `PAYMENT_PROVIDER_NOT_CONFIGURED` (via
`provider-registry.ts`'s existing `Partial<Record<...>>` + `getProvider`'s
existing not-found branch, unchanged) until Tasks 2–4 actually populate those
registry entries. This is deliberate sequencing, not a bug: it lets this
mechanical, most-regression-risky task be reviewed and merged on its own, fully
covered by the EXISTING test suite, before any new adapter's code exists to
confound a review of it.

**Interfaces:**
- `CheckoutInput.paymentMethod` widens from `'cod' | 'wompi'` to
  `'cod' | PaymentProviderId` (import `PaymentProviderId` from `@ventia/payments`
  rather than hand-rolling a parallel union — it already includes `'wompi' |
  'mercadopago' | 'epayco'`).
- Every `input.paymentMethod === 'wompi'` conditional in `checkout.service.ts`
  becomes `input.paymentMethod !== 'cod'`. The credential-check block (currently
  `if (input.paymentMethod === 'wompi') { wompiConfig = ... }`) becomes generic:
  `if (input.paymentMethod !== 'cod') { providerConfig =
  await this.paymentsService.getTenantProviderConfig(tenantId, input.paymentMethod); ... }`
  — rename the local variable from `wompiConfig` to something provider-neutral
  (e.g. `onlineProviderConfig`) throughout the method, and update every doc
  comment that currently says "wompi" to say "the chosen online provider" where
  the logic itself is genuinely generic now (leave any comment that's
  specifically ABOUT the `integritySecret`/`eventsSecret` completeness check
  as-is if it's still accurate — Wompi is still the only provider requiring
  BOTH fields non-empty at checkout time per the P3a review fix; confirm during
  this task whether Mercado Pago/ePayco's own credential-completeness
  requirements differ, and if this check needs to become provider-aware rather
  than a blanket "both optional fields must be set" rule — flag this explicitly
  in the task report if the requirement turns out to differ per provider,
  since Tasks 2–4 haven't been implemented yet to know for certain).
- The one hardcoded `getProvider('wompi')` call becomes
  `getProvider(input.paymentMethod)` — TypeScript should narrow
  `input.paymentMethod`'s type correctly to `PaymentProviderId` inside the
  `!== 'cod'` branch; if it doesn't narrow cleanly (a plain `!==` check against a
  union member sometimes needs an explicit type guard), add one rather than
  reaching for an `as` cast.
- `checkout.controller.ts`'s hand-rolled body validator (whatever currently
  hardcodes an allow-list check for `paymentMethod === 'cod' || paymentMethod ===
  'wompi'`) widens to accept any `PaymentProviderId` value alongside `'cod'`.

**Steps:** make the change → run the FULL existing `checkout.test.ts` suite
(every `cod` AND every `wompi` test) and confirm 100% unchanged pass, byte for
byte, with zero new failures or altered assertions needed → `pnpm --filter
@ventia/api typecheck` → `pnpm turbo run test` (whole monorepo, not just this
package) → commit `refactor: generalize checkout's payment-method branching
beyond wompi`.

---

### Task 2: Mercado Pago adapter (`packages/payments/src/mercadopago.ts`)

**Files:**
- Modify: `packages/payments/src/index.ts` (add `epaycoCustomerId?: string` to
  `TenantProviderConfig` — do this in THIS task even though epayco doesn't exist
  yet, since it's a single shared interface file; export `MercadoPagoProvider`)
- Create: `packages/payments/src/mercadopago.ts`
- Test: `packages/payments/test/mercadopago.test.ts`

**Interfaces:** `MercadoPagoProvider implements PaymentProvider` (do not change
the interface's method signatures — `epaycoCustomerId`'s addition to
`TenantProviderConfig` is additive/optional only).

Design doc decisions 3–5 already cite verified real API facts and source URLs —
read them before starting. Re-verify anything the design doc flagged as
lower-confidence: the exact test-credential prefix format, and `GET
/v1/payments/:id`'s full response schema (fetch
`https://www.mercadopago.com.ar/developers/en/reference/payments/_payments_id/get`
directly if possible; if it's still unreachable/JS-rendered from this
environment as it was during design, try the co/mx locale variants, or a
`curl`-style raw fetch of any OpenAPI/JSON schema Mercado Pago publishes for its
reference docs — exhaust real options before falling back to the
search-summarized field names the design doc already has, and say explicitly in
the commit body which path this task ended up taking).

- `createCheckoutSession(order, cfg, fetchImpl = fetch)`: `POST
  https://api.mercadopago.com/checkout/preferences`, `Authorization: Bearer
  ${cfg.privateKey}` (MP's real "Access Token" — see design doc decision 4 for
  why `privateKey`, not `publicKey`, holds this). Body: `items: [{title:
  'Order' or similar generic line item — MP's Checkout Pro needs at least one
  item, and this codebase's Order doesn't carry a single "item name" the way a
  single-SKU purchase would; a generic line item covering the whole order total
  is fine, don't try to break out per-OrderItem line items unless
  OrderForPayment already carries them (it doesn't, per the interface — verify
  this before inventing fields), unit_price: totalCents / 100 (pesos — confirm
  MP's `unit_price` wants a decimal major-unit number, not cents, since this
  differs from Wompi's cents-based `amount-in-cents` — re-verify this
  specifically, it's a real footgun if wrong), quantity: 1, currency_id:
  'COP'}]`, `external_reference: order.orderNumber`, `back_urls: {success,
  failure, pending}` (all three pointing at the storefront's order-confirmation
  route — confirm the real query-param shape MP appends on redirect, e.g.
  `?payment_id=...&status=...&external_reference=...`, since the
  order-confirmation page doesn't currently need to read anything off these
  params but a future task might), `auto_return: 'approved'`,
  `notification_url` pointing at `{API_URL}/webhooks/payments/mercadopago/{tenantId}`
  (mirror however `checkout.service.ts`/`wompi.ts` currently constructs the
  equivalent webhook URL for Wompi, if it does so explicitly anywhere, or
  confirm this is instead configured once in the MP dashboard per design doc
  decision 4's note that `notification_url` can be set per-preference OR at the
  panel level — pick per-preference for consistency with this codebase's
  per-tenant, per-request explicitness elsewhere). Response: `cfg.sandbox ?
  body.sandbox_init_point : body.init_point` as `redirectUrl`.
- `verifyAndParseWebhook(req, cfg, fetchImpl = fetch)`: parse `req.rawBody` as
  JSON for `{type, data: {id}}`. Verify `x-signature` (format
  `ts=<n>,v1=<hex>`, parse both parts out of the header value) — recompute
  `HMAC-SHA256(cfg.eventsSecret, `id:${data.id};request-id:${xRequestId};ts:${ts};`)`
  (read `x-request-id` off `req.headers`; omit either the `id:` or
  `request-id:` segment entirely, per design doc decision 5, if that value is
  genuinely absent from the payload/headers — confirm this omission rule
  against the real docs page rather than assuming) and compare against `v1` —
  **use `crypto.timingSafeEqual` for this comparison, not `===`** (P3a's
  phase review flagged Wompi's own `!==` checksum comparison as a
  cheap-to-fix, worth-doing backlog item for exactly this reason — don't
  reintroduce the same issue in a brand-new adapter when it's known and easy to
  avoid from the start). On success, make the follow-up `GET
  /v1/payments/{data.id}` call (Bearer `cfg.privateKey`) and map its response
  into a `NormalizedPaymentEvent` (`eventId: String(id)` — MP's own stable
  payment id, no composition needed unlike Wompi's `transaction.id:timestamp`
  workaround; `providerRef: String(id)`; `reference: external_reference`;
  `status:` mapped per design doc decision 5's table
  (`approved→PAID`, `pending`/`in_process`/`authorized`/`in_mediation→PENDING`,
  `rejected→FAILED`, `cancelled→FAILED`, `refunded`/`charged_back→EXPIRED` —
  implement this exact mapping, don't re-derive a different one without
  updating the design doc first); `amountCents: Math.round(transaction_amount * 100)`
  (re-confirm the units direction here matches whatever `createCheckoutSession`
  actually sent, per the units caution above).
- `getTransactionStatus(providerRef, cfg, fetchImpl = fetch)`: `GET
  /v1/payments/:id`, Bearer `cfg.privateKey`, map `status` through the same
  mapping function `verifyAndParseWebhook` uses (share one `mapStatus` helper
  between both methods, same shape as `wompi.ts`'s single `mapStatus`).

**Tests:** `mercadopago.test.ts`, mocked `fetch` (inject `fetchImpl` on every
method per this codebase's established convention) — `createCheckoutSession`
builds the right request body/headers and returns `sandbox_init_point` vs.
`init_point` correctly based on `cfg.sandbox`; `verifyAndParseWebhook` accepts a
correctly-signed fixture (hand-compute the expected HMAC-SHA256 hex digest
independently in the test, don't just assert "some event was returned") and
rejects a tampered signature, a tampered `ts`, and a payload missing
`x-request-id`; the follow-up `GET /v1/payments/:id` call's mocked response is
asserted to map every one of MP's real status strings to the correct
`NormalizedStatus` per the table above, including both `refunded` AND
`charged_back` mapping to `EXPIRED` (two separate test cases, not just one,
since they're distinct status strings landing in the same bucket) and
`cancelled` mapping to `FAILED` (distinct from the `EXPIRED` bucket — a test
that would fail loudly if a future edit accidentally swapped this).

**Steps:** RE-VERIFY the two lower-confidence facts against real docs first
(state findings in the commit body) → RED → implement → tests green →
`pnpm --filter @ventia/payments typecheck` → commit `feat: add Mercado Pago
payment provider adapter`.

---

### Task 3: ePayco adapter (`packages/payments/src/epayco.ts`)

**Files:**
- Modify: `packages/payments/src/index.ts` (export `EpaycoProvider`)
- Create: `packages/payments/src/epayco.ts`
- Test: `packages/payments/test/epayco.test.ts`

**Interfaces:** `EpaycoProvider implements PaymentProvider`.

Design doc decisions 3/6/7 already cite verified real API facts. Re-verify the
two facts the design doc flagged as its lowest-confidence findings in the whole
document: (a) whether `ePayco.checkout.configure(...)`'s real client-side widget
config accepts a post-payment return/redirect URL parameter — fetch ePayco's
actual `checkout-v2.js` integration docs page directly and find the real
parameter name (do not guess one; if it genuinely doesn't exist, the
`/pago/epayco` bridge page (Task 6) will need its OWN client-side redirect to
the order-confirmation page once the widget's `onClose`/completion callback
fires, which the same docs page should also document — confirm this too, it's
the other half of the same open question); (b) `getTransactionStatus`'s real
REST endpoint — the design doc's research hit only a community SDK reference
and a generic error body from a direct fetch attempt; try harder here (search
for "ePayco API reference transacciones consultar estado", check
`docs.epayco.com`'s own top-level API index page for a status/query endpoint
section this design's research may have missed) before accepting the
community-sourced endpoint as the implementation. If, after a genuine attempt,
no officially-documented status-lookup endpoint can be confirmed, implement
`getTransactionStatus` against the best-available real endpoint but say so
explicitly and prominently in both the code's doc comment and the commit body
— do not silently ship it with false confidence, and flag it clearly for the
phase review to weigh in on.

- `createCheckoutSession(order, cfg, fetchImpl = fetch)`: `POST
  https://apify.epayco.co/login`, `Authorization: Basic
  ${base64(cfg.publicKey + ':' + cfg.privateKey)}` → extract the JWT from the
  response (confirm the exact response field name during implementation, the
  design doc's research didn't capture this level of detail — likely `token` or
  similar, verify against the real docs page rather than guessing). Then `POST
  https://apify.epayco.co/payment/session/create`, `Authorization: Bearer
  {jwt}`, body including `checkout_version: '2'`, an order name/description,
  `currency: 'COP'`, `amount: (order.totalCents / 100)` (re-confirm units —
  major-unit pesos, not cents, per the design doc's finding; this is the SAME
  units footgun as Mercado Pago, verify independently for ePayco rather than
  assuming it matches MP just because both turned out the same way) → extract
  `sessionId` from the response. Return `redirectUrl:
  '{STOREFRONT_URL}/pago/epayco?session={sessionId}&sandbox={cfg.sandbox}'`
  (design doc decision 6 — `STOREFRONT_URL` should come from wherever this
  codebase already threads the storefront's own base URL through to
  server-side code that needs to build a link to it; check how
  `services/api/src/storefront/revalidate.ts` or the order-confirmation
  email's storefront link, if any, already does this, and reuse the same env
  var/convention rather than inventing a new one).
- `verifyAndParseWebhook(req, cfg)`: no network call — parse `req.rawBody` as
  form-encoded or JSON per whatever ePayco's real confirmation POST actually
  sends (the design doc's research cited field names like `x_ref_payco`,
  `x_transaction_id` etc. without confirming the exact content-type/encoding —
  verify this: ePayco's older APIs are commonly `application/x-www-form-urlencoded`,
  confirm which this one really is before assuming JSON). Recompute
  `SHA256(cfg.epaycoCustomerId + '^' + cfg.eventsSecret + '^' + x_ref_payco +
  '^' + x_transaction_id + '^' + x_amount + '^' + x_currency_code)` hex, compare
  against `x_signature` using `crypto.timingSafeEqual` (same reasoning as Task
  2 — don't use `!==`/`===` for a security-sensitive signature comparison in
  new code). Map `x_response` (`'Aceptada'→PAID`, `'Pendiente'→PENDING`,
  `'Rechazada'`/`'Fallida'→FAILED`) — parse the STRING value, not
  `x_cod_response`'s numeric code (per the design doc's explicit caution that
  the numeric mapping is unverified). `eventId`: `x_transaction_id` (or
  composed with `x_ref_payco` if `x_transaction_id` alone isn't guaranteed
  unique across retries — verify against the real docs which of these two, or
  both together, is the right idempotency key). `reference: x_extra1` (or
  whichever `x_extraN` slot `createCheckoutSession` actually populates with
  `order.orderNumber` — this must be the SAME slot number on both the sending
  and receiving side; pick one, e.g. `x_extra1`, and use it consistently).
  `amountCents: Math.round(Number(x_amount) * 100)`.
- `getTransactionStatus(providerRef, cfg, fetchImpl = fetch)`: implement against
  whatever endpoint this task's own re-verification (above) confirms, with the
  honesty caveat already noted.

**Tests:** `epayco.test.ts` — `createCheckoutSession` asserts the two mocked
`fetch` calls (login then session/create) happen in order with the right
headers/bodies and that the returned `redirectUrl` is the storefront's own
`/pago/epayco` URL with the right query params (NOT an epayco.co URL — this is
the one adapter where asserting the redirect target is a THIRD-PARTY vs.
FIRST-PARTY URL actually matters and is worth a dedicated assertion, unlike
Wompi/MP where the redirect always goes to the gateway); `verifyAndParseWebhook`
hand-computes the expected SHA-256 hex digest independently (same rigor as
Wompi's own integrity-signature test) and asserts a validly-signed fixture is
accepted, a tampered `x_signature` is rejected, and each of the four
`x_response` strings maps to the correct `NormalizedStatus`.

**Steps:** RE-VERIFY both flagged facts against real docs first (state findings
in the commit body, including if either genuinely couldn't be confirmed) → RED
→ implement → tests green → `pnpm --filter @ventia/payments typecheck` →
commit `feat: add ePayco payment provider adapter`.

---

### Task 4: Wire both providers into the registry + payments service + schemas

**Files:**
- Modify: `services/api/src/payments/provider-registry.ts` (add both entries),
  `services/api/src/payments/payments.service.ts` (generalize
  `StoredWompiCredentials`/`isStoredWompiCredentials` if they're still
  Wompi-specifically named/shaped — check whether this needs to become a
  shared `StoredProviderCredentials` interface now that three providers share
  it, including a new `epaycoCustomerIdEncrypted?: string` field alongside the
  existing `integritySecretEncrypted`/`eventsSecretEncrypted` — decide whether
  ePayco's `epaycoCustomerId` needs encryption at rest at all: it's an account
  identifier, not a secret on its own, but it's one half of a signature
  formula whose OTHER half (`eventsSecret`/`P_KEY`) is already encrypted —
  encrypting it too costs nothing and avoids a asymmetric "is this one
  sensitive or not" judgment call being baked into the stored-shape's own
  design; default to encrypting it unless there's a concrete reason not to),
  `packages/core/src/settings-schemas.ts` (new
  `mercadopagoCredentialsSchema`/`epaycoCredentialsSchema`, `paymentsSettingsSchema`'s
  `providers` object widens to include both as optional nested keys)
- Test: extend `services/api/test/payments-service.test.ts` and
  `services/api/test/payments-settings.test.ts` with mercadopago/epayco
  equivalents of every existing wompi-specific test case (credential
  save/read round-trip, cross-tenant isolation, the "raw secret never appears
  in a response body or AuditLog row" leak test — this last one is the single
  most important test to duplicate for the two new providers, not just the
  happiest-path CRUD test, per the P3a phase review's emphasis on credential
  leakage as a top priority)

**Interfaces:**
```ts
export const mercadopagoCredentialsSchema = z.object({
  publicKey: z.string().min(1),
  privateKey: z.string().min(1),
  eventsSecret: z.string().min(1).optional(),
  sandbox: z.boolean(),
});
export const epaycoCredentialsSchema = z.object({
  publicKey: z.string().min(1),
  privateKey: z.string().min(1),
  eventsSecret: z.string().min(1).optional(),      // P_KEY
  epaycoCustomerId: z.string().min(1).optional(),  // P_CUST_ID_CLIENTE
  sandbox: z.boolean(),
});
```
(Mirror `wompiCredentialsSchema`'s exact field-optionality choices unless a
concrete reason emerges to diverge — e.g. if Task 2/3's implementation reveals
that Mercado Pago's `eventsSecret`/ePayco's `eventsSecret`+`epaycoCustomerId`
are actually REQUIRED for that gateway to function at all (no equivalent of
Wompi's "can save partial credentials, checkout blocks it later" gap the P3a
review found and fixed) — if so, consider making them non-optional here
directly rather than optional-plus-a-checkout-time-guard, since Task 1 already
flagged this as worth revisiting per-provider.)

**Steps:** implement → run the full existing payments-service/payments-settings
test suites plus the new mercadopago/epayco cases → `pnpm --filter @ventia/core
build && typecheck` (other packages consume its built `dist/`) → `pnpm --filter
@ventia/api typecheck` → commit `feat: wire mercadopago and epayco into the
payment provider registry`.

---

### Task 5: Admin credentials UI — Mercado Pago + ePayco sections

**Files:**
- Modify: `apps/admin/components/pagos-tab.tsx` (add `MercadoPagoSection` +
  `EpaycoSection`, following `WompiSection`'s existing shape exactly)
- Maybe modify: `apps/admin/lib/wompi-form.ts` — check whether its
  helpers are generic enough to share (rename to a provider-neutral module if
  so) or whether each provider warrants its own small form-state file matching
  this codebase's established per-module-copy convention for small,
  provider-specific shapes (P2b Task 6's shipping-form.ts precedent) — your
  call, but state the reasoning either way.
- Test: extend `apps/admin/test/wompi-form.test.ts` or add sibling test files,
  matching whichever structural choice above.

**Interfaces:** Each section: public key, private key (masked
`<input type="password">`, never pre-filled with the real value, same posture
as `WompiSection`), sandbox toggle, "Probar conexión" button. `EpaycoSection`
additionally needs an `epaycoCustomerId` field — per design doc decision 4's
UI note, this field's label/copy must make unmistakably clear it's a SEPARATE
secret pair from the public/private key above (e.g. a distinct sub-heading
"Firma de confirmación (P_CUST_ID_CLIENTE / P_KEY)" or similar, sourced from
ePayco's own real dashboard terminology so a merchant can actually find these
values) — this is a genuine, called-out UX risk (design doc decision 4), not a
cosmetic nice-to-have; verify the copy against a real ePayco dashboard
screenshot/docs page during this task if possible, don't invent field labels
ePayco's own dashboard doesn't use.

**Steps:** RED (form-state tests, if a new form-state module is warranted) →
implement → `pnpm --filter @ventia/admin build && typecheck && lint` → full
`pnpm --filter @ventia/admin test` → commit `feat: add mercadopago and epayco
credentials UI to admin configuración`.

---

### Task 6: Storefront — checkout payment-method widening + ePayco bridge page

**Files:**
- Modify: `apps/storefront/app/checkout/page.tsx` (payment-method
  choice widens from `cod`/`wompi` to include `mercadopago`/`epayco`, same
  submit-and-redirect pattern already built for `wompi`)
- Create: `apps/storefront/app/pago/epayco/page.tsx` (the bridge page, design
  doc decision 6) — a client component, reads `session`/`sandbox` from its own
  search params, loads `https://checkout.epayco.co/checkout-v2.js` (via a
  `<script>` tag / dynamic import, whichever this codebase's existing
  `next/script` usage elsewhere — if any — already establishes as the
  convention for a third-party script; check before inventing a new pattern),
  calls `ePayco.checkout.configure({sessionId, type: 'standard', test:
  sandbox === 'true'}).open()` on mount. Wires the real post-payment
  return-redirect mechanism Task 3 confirmed (either a widget config
  parameter, or a completion-callback-driven client-side redirect to the
  order-confirmation route) — do not ship this page without SOME way for the
  shopper to end up back on the order-confirmation page after paying; if Task
  3's research came back genuinely inconclusive on this point, that's a
  blocking gap for THIS task to resolve (re-attempt the research here with
  fresh eyes, or treat it as the single most important open question to
  surface explicitly for the phase review) rather than shipping a bridge page
  that strands the shopper on ePayco's widget with no way back.

**Steps:** implement → manual check against a real or well-formed-fake session
(same posture as P3a Task 9's Wompi smoke test, since no live ePayco sandbox
account is expected to be available here either) → `pnpm --filter
@ventia/storefront build && typecheck && lint` → full `pnpm --filter
@ventia/storefront test` → commit `feat: wire mercadopago/epayco into
storefront checkout`.

---

### Task 7: Wrap-up — full gate + manual/sandbox smoke + docs

**Files:** `README.md` (document the two new providers, note P3b done and P3c
remaining, matching P3a's own README update's exact section shape), no code
changes expected beyond fixing whatever the gate surfaces.

**Steps:**
- Full monorepo gate: `pnpm turbo run lint typecheck build test` — zero
  regressions across every existing test file from every prior phase (this is
  the real proof that Task 1's generalization and every subsequent task didn't
  quietly break `cod`/`wompi`).
- Manual smoke test against the real dev stack for BOTH new gateways, as
  thoroughly as every prior phase's wrap-up task (P2a-9/P2b-10/P2c-6/P3a-9 all
  did real Playwright/curl smoke passes, not just unit tests) — since no real
  Mercado Pago/ePayco sandbox account is expected to be available in this
  environment, drive each gateway's checkout through the real API with
  MOCKED/faked `PROVIDERS.mercadopago`/`PROVIDERS.epayco` credentials
  (documented clearly as such, not presented as a real sandbox transaction),
  confirming the reservation → webhook/confirmation → confirm →
  stock-decremented-once chain works end to end through real HTTP + a real
  Postgres for each gateway independently, mirroring P3a Task 9's exact
  verification shape. If real sandbox credentials for either gateway genuinely
  can become available, prefer using them and say so explicitly.
- Update README's Phase status: P3 stays whatever P3a left it at overall
  (⬜, since P3c remains), flip the P3b sub-note to done, matching how P3a's
  own sub-note was added alongside P3's overall ⬜.

Steps: run gate → smoke test both gateways → update docs → commit `docs: P3b
wrap-up — Mercado Pago + ePayco end-to-end`.

---

## After Task 7

A phase-scoped review (same posture as every prior phase's review, including
P3a's own) should run before starting P3c: read every commit in this plan's
range, verify BOTH new adapters' webhook/confirmation signature verification
and idempotency are genuinely rigorous (not just present) — same three
priorities P3a's own review used (signature/idempotency rigor,
concurrency/race safety across the now-THREE gateways all sharing the same
stock-reservation worker and advisory-lock transition machinery, credential
leakage) — plus explicitly re-check every fact this plan flagged as
lower-confidence or "re-verify at implementation time" actually got resolved
with a real, cited source rather than quietly shipped as a guess.
