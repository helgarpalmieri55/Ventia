# P3c — Payment-Status Reconciliation Job: Implementation Plan

**Design doc:** `docs/superpowers/specs/2026-07-30-p3c-payment-reconciliation-design.md`
— read it in full before starting any task. Every task below assumes its decisions.

**Ground rules (same as every prior phase's plan):** TDD (RED before implementation),
run the FULL monorepo gate (`pnpm turbo run lint typecheck build test`) after every
task — zero regressions across P0–P3b's entire existing suite is the real proof this
phase didn't break anything, not just this phase's own new tests. Commit after each
task. Git identity (`git config user.email noreply@anthropic.com && git config
user.name Claude`) if not already set.

---

### Task 1: Schema migration + `providerRef` writes + `searchByReference?` interface addition

**Files:**
- Migration (new): `Order.providerRef String?` (nullable, no default) —
  `packages/db/prisma/schema.prisma` + `prisma migrate dev` to generate it.
- Modify: `services/api/src/payments/payments.service.ts` — `markPaid`/`markFailed`
  each add `providerRef` to their existing `tx.order.update({data: {...}})` call
  (design decision 2, first bullet). No new transaction/locking logic — same
  advisory-lock + `status==='PENDING' && paymentStatus==='PENDING'` precondition
  both methods already have, untouched.
- Modify: `packages/payments/src/index.ts` — `PaymentProvider` gains one new
  OPTIONAL method (mirrors how `refund?` is already optional and not implemented by
  every provider):
  ```ts
  searchByReference?(
    reference: string,
    cfg: TenantProviderConfig,
  ): Promise<{ providerRef: string; status: NormalizedStatus } | null>;
  ```
- Modify: `packages/payments/src/mercadopago.ts` — implement `searchByReference`
  calling `GET https://api.mercadopago.com/v1/payments/search?external_reference={reference}`
  (confirmed real/documented — see design doc's research section for the exact
  endpoint path, which differs from an earlier, now-404ing URL shape; re-verify the
  endpoint yourself against `mercadopago.com.co/developers` before trusting this plan's
  citation, since docs sites restructure). Same `Authorization: Bearer {privateKey}`
  as the existing by-id `getTransactionStatus`. Response is `{paging, results: [...]}`
  — if `results` is empty, return `null`; if non-empty, pick the most recent `APPROVED`
  payment if any exists among them, else the most recent attempt of any status
  (multiple retries can share one `external_reference` — don't just take `results[0]`
  blindly without checking whether the array is meaningfully ordered by the API's own
  default sort; if the docs don't guarantee an order, sort by the payment's own
  `date_created`/`date_approved` field client-side before picking).
- `packages/payments/src/wompi.ts` / `epayco.ts`: unchanged (the method stays
  undefined for both, exactly like `refund?`).
- Test: `packages/payments/test/mercadopago.test.ts` (extend) — `searchByReference`
  with mocked `fetch`: empty results → `null`; single `APPROVED` result → returns it;
  multiple results with a mix of statuses → picks the `APPROVED` one over
  non-approved ones regardless of array position; a non-2xx response → throws (same
  posture as the existing `getTransactionStatus`, don't swallow). `services/api/test/`
  — extend `payments-service.test.ts` (or wherever `markPaid`/`markFailed` are
  currently tested) with an assertion that `Order.providerRef` is actually persisted
  after each call, not just the `OrderEvent`.

**Steps:** RED → implement → `pnpm --filter @ventia/db generate` (regenerate the
Prisma client — every later task's typecheck depends on this) → run the full
`packages/payments`/`services/api` test suites → `pnpm --filter @ventia/payments
build && typecheck`, `pnpm --filter @ventia/api typecheck` → commit `feat: add
Order.providerRef column and Mercado Pago's searchByReference`.

---

### Task 2: Shared provider-ref-hint endpoint + Wompi return-capture

**Files:**
- Modify: `services/api/src/checkout/checkout.controller.ts` (or a small new
  controller in the same module — implementer's call, matching this file's existing
  route-naming conventions): a new endpoint, e.g.
  `PATCH /v1/storefront/checkout/:orderNumber/provider-ref-hint`, guarded by the
  existing `PublicTenantGuard` only (this is a public, unauthenticated hint — see
  design doc decision 4's trust-level note). Body: `{providerRef: string}`. Looks up
  the order by `(tenantId, number)`, writes `Order.providerRef` ONLY — never touches
  `paymentStatus`/`status`. A nonexistent order number → `404 NOT_FOUND` (same
  convention as every other storefront lookup-by-number endpoint in this file); an
  order that already has a DIFFERENT non-null `providerRef` → overwrite is fine (a
  later, more-authoritative source — e.g. a real webhook that already ran — should
  win; write unconditionally, don't guard on "only if null", since this hint is
  advisory either way and the reconciliation job re-verifies via the gateway's own
  API regardless of where the value came from).
- Modify: `packages/payments/src/wompi.ts` — `createCheckoutSession` adds
  `redirect-url` to its built `params` (design decision 2, second bullet), pointing at
  a new storefront route (see below) with the order number carried as a query param —
  mirror `epayco.ts`'s existing `resolveStorefrontBase()` pattern EXACTLY (same
  `STOREFRONT_BASE_ENV_VAR`-style env var — check whether to reuse ePayco's literal
  `EPAYCO_STOREFRONT_BASE_URL` or add a provider-neutral one; given this same
  per-tenant-domain gap affects Wompi identically to how it already affects ePayco
  [see that file's own doc comment on why it's a known, disclosed, cross-provider
  limitation, not something to silently fix differently per adapter], a single shared
  `PAYMENTS_STOREFRONT_BASE_URL` env var used by BOTH adapters is cleaner than two
  near-identical provider-specific ones — rename ePayco's if you do this, and update
  its own doc comment to say so).
- Create: `apps/storefront/app/pago/wompi-retorno/page.tsx` (or similar path —
  implementer's call) — mirrors `apps/storefront/app/pago/epayco/page.tsx`'s
  `useSearchParams()` + `Suspense` shape (read that file in full first): reads `?id=`
  (Wompi's transaction id) and `?orderNumber=`, `PATCH`es the new endpoint from above
  with `{providerRef: id}` (fire-and-forget is fine — this is a best-effort hint, a
  failed PATCH here must never block the shopper from reaching their confirmation
  page), then redirects to `/checkout/confirmacion/:orderNumber` exactly like the
  ePayco bridge page's `goToConfirmation` does. No `id`/`orderNumber` present (a
  malformed/direct visit) → same graceful-degradation posture as the ePayco bridge's
  own missing-param branches (a clear message + a link back to the cart, not a crash).
- Test: `services/api/test/checkout.test.ts` (or a new file) — the new hint endpoint:
  writes `providerRef`, never touches `paymentStatus`, 404s for a nonexistent order
  number, overwrites an existing value. `apps/storefront/test/` — a new test file for
  the Wompi return page mirroring however the ePayco bridge page's own tests (if any
  exist — check) are structured, or a `lib/`-level test for whatever pure-function
  logic you extract from the page (matching this app's established
  pure-helper-over-component-test convention — see P2b Task 7's precedent).

**Steps:** RED → implement → `pnpm --filter @ventia/api typecheck && lint`,
`pnpm --filter @ventia/storefront typecheck && lint && build` → manual check: drive a
`wompi` checkout with a well-formed fake `redirect-url` round trip (simulate the
browser return by hitting the new endpoint directly with curl, since a real Wompi
sandbox redirect can't be produced without a live account) and confirm
`Order.providerRef` ends up populated → commit `feat: capture Wompi's redirect-return
transaction id as a reconciliation hint`.

---

### Task 3: ePayco return-capture wiring

**Files:**
- Modify: `apps/storefront/app/pago/epayco/page.tsx` — first, verify (against a real
  sandbox response if at all obtainable, else the community SDK
  `github.com/DiegoxK/epayco-checkout-sdk`'s documented `onResponse` payload shape,
  clearly flagging which source you used, matching this file's own existing
  honesty-note convention) whether the `onResponse` hook's `response` argument
  actually contains `x_ref_payco`. If yes: extend `onResponse` to also `PATCH` the
  SAME shared endpoint from Task 2 with `{providerRef: response.x_ref_payco}` before
  calling `goToConfirmation()` (fire-and-forget, same non-blocking posture as Task
  2's Wompi page). If the payload does NOT reliably contain it (or can't be verified
  either way), do not fabricate a working integration — leave this task's report
  explicit that ePayco's redirect-hint source is unavailable/unverified, matching
  design doc decision 2's explicit acknowledgment that this source might not pan out
  for ePayco specifically; the design doesn't depend on it (Mercado Pago's
  `searchByReference` and the existing webhook path both remain unaffected either
  way).
- Test: extend whatever test coverage exists for this page/its extracted logic
  (matching Task 2's approach) with the new hook-firing assertion, IF the payload
  shape was confirmed; otherwise, no new test is expected here — don't test against
  a shape you couldn't verify is real.

**Steps:** RED (if applicable) → implement or explicitly document non-viability →
`pnpm --filter @ventia/storefront typecheck && lint && build` → commit `feat: capture
ePayco's onResponse ref_payco as a reconciliation hint` (or, if the payload can't be
verified, `docs: record that ePayco's onResponse hook doesn't reliably expose
ref_payco` — whichever is honest).

---

### Task 4: Reconciliation BullMQ worker

**Files:**
- Create: `services/api/src/payments/reconciliation.worker.ts` — mirrors
  `stock-reservation.worker.ts`'s existing shape (read that file in full first: its
  BullMQ Queue/Worker construction, its deliberate no-Nest-lifecycle-hook posture so
  tests never accidentally start real BullMQ machinery, its `start()`/`stop()` method
  shape). Repeatable job, every 2 minutes (design decision 4). Per run, across ALL
  tenants (same tenant-agnostic sweep posture as the stock-reservation worker — BullMQ
  jobs aren't naturally tenant-scoped the way HTTP requests are): query `Order` rows
  where `paymentStatus = 'PENDING' AND paymentProvider IS NOT NULL AND paymentProvider
  != 'cod' AND stockReservedUntil IS NOT NULL AND createdAt < now() - 5 minutes` (the
  5-minute floor and 15-minute stock-TTL ceiling are both design decision 4's explicit
  ordering choice — do not change either without re-reading that decision's reasoning
  first). For each matching order:
  1. If `order.providerRef` is set: call
     `getProvider(order.paymentProvider).getTransactionStatus(order.providerRef, cfg)`.
  2. Else if `order.paymentProvider === 'mercadopago'`: call
     `getProvider('mercadopago').searchByReference!(String(order.number), cfg)`; if it
     returns a result, use ITS `providerRef`/`status`.
  3. Else (wompi/epayco with no providerRef): skip this order entirely this run — no
     API path exists (design decision 3).
  - A thrown error from step 1/2 (network/gateway failure): log, skip this order this
    run (design decision 6) — never treat a failed reconciliation ATTEMPT as a FAILED
    payment.
  - Resolved `PAID` → `paymentsService.markPaid(tenantId, orderId, provider,
    providerRef)`. Resolved `FAILED`/`EXPIRED` → `paymentsService.markFailed(...)`.
    Resolved `PENDING` (gateway itself still says pending) → no action this run, try
    again next run (will eventually fall through to the existing 15-minute
    stock-expiry worker if the shopper never completes payment — this job never
    expires/restocks anything itself, design decision 7).
- Modify: `services/api/src/payments/payments.module.ts` — register
  `ReconciliationWorker` as an ordinary provider (same non-`@Global()`, no-lifecycle-
  hook posture as `StockReservationWorker` — read that class's own doc comment on
  exactly why, and match it).
- Modify: `services/api/src/main.ts` — the existing `if (require.main === module)`
  real-boot block that calls `app.get(StockReservationWorker).start()` gets a sibling
  `app.get(ReconciliationWorker).start()` call.
- Test: `services/api/test/reconciliation-worker.test.ts` (new) — real Testcontainers
  Postgres + Redis (matching `stock-reservation-worker.test.ts`'s existing pattern —
  read it first), mocked provider adapters (inject fakes implementing
  `getTransactionStatus`/`searchByReference` with scripted responses, same style
  `webhooks.test.ts`/`payments-service.test.ts` already use for exercising real
  encryption without a real gateway). Cases: (a) an order with a known `providerRef`
  whose gateway reports `PAID` → order ends up `CONFIRMED`/`PAID`,
  `stockReservedUntil` cleared, exactly once (run the worker's sweep twice against
  the same fixture set and confirm no double-transition/error the second time —
  `markPaid`'s own idempotent-no-op guard should make this automatic, but PROVE it,
  don't assume); (b) same but `FAILED` → order's `paymentStatus` becomes `FAILED`,
  `status`/`stockReservedUntil` untouched (matches `markFailed`'s existing contract);
  (c) an order younger than 5 minutes → NOT touched (query excludes it); (d) an order
  with `paymentProvider: 'mercadopago'` and no `providerRef` → `searchByReference` is
  called and, given a scripted `APPROVED` result, resolves to `PAID`; (e) same shape
  but `paymentProvider: 'wompi'` and no `providerRef` → left completely alone, no
  crash, no API call attempted; (f) a scripted `getTransactionStatus` that throws →
  order left at `PENDING`, no exception escapes the worker's sweep (one bad order
  must never abort processing the rest of the batch — iterate with a try/catch PER
  ORDER, not one try/catch around the whole loop); (g) **the core safety claim from
  design decision 4**: seed an order 6 minutes old with `stockReservedUntil` still 9
  minutes in the future (i.e. within its 15-minute hold), run ONLY the reconciliation
  worker's sweep (not the stock-expiry worker), confirm it resolves to `PAID` and
  clears the reservation BEFORE the stock-expiry worker would ever have touched it —
  i.e. prove the two jobs' thresholds are actually ordered the way the design claims,
  don't just trust the constants.

**Steps:** RED → implement → run the new test file until green → run the FULL
`services/api` test suite (zero regressions in `stock-reservation-worker.test.ts`
specifically — this task must not change that worker's own behavior at all) →
`pnpm --filter @ventia/api typecheck && lint` → commit `feat: add payment-status
reconciliation worker`.

---

### Task 5: Wrap-up — full gate + manual/sandbox smoke + docs

**Files:** none (verification + docs only), same posture as every prior phase's own
wrap-up task (P2a-9/P2b-10/P2c-6/P3a-9/P3b-7) — no substantive code changes expected
beyond fixing whatever the gate surfaces.

**Steps:**
- Full monorepo gate: `pnpm turbo run lint typecheck build test` — zero regressions
  across every existing test file from every prior phase.
- Manual smoke test against the real dev stack, as thoroughly as every prior phase's
  wrap-up did (real Playwright/curl passes, not just unit tests). Since no real
  gateway sandbox account is expected to be available: seed an order directly via
  Prisma with `paymentProvider: 'mercadopago'`, `paymentStatus: 'PENDING'`, an age
  past the 5-minute reconciliation floor, and no `providerRef`; run the
  reconciliation worker's sweep against the REAL API + a REAL Postgres with a
  MOCKED/faked Mercado Pago `searchByReference` response (documented clearly as
  such); confirm the order transitions to `CONFIRMED`/`PAID` end to end through real
  HTTP, not just the unit-test suite's in-process assertions. Do the same for the
  Wompi redirect-hint round trip: hit the new provider-ref-hint endpoint with curl
  (simulating the browser's redirect-return), confirm `Order.providerRef` persists,
  then run reconciliation with a faked `getTransactionStatus` response and confirm it
  resolves correctly.
- Update README's Phase status: flip P3's overall `⬜` to `✅` (P3a, P3b, and P3c are
  now all done — this is the LAST P3 sub-phase per every prior doc's own "remains
  undone" notes), matching how P1/P2 flipped from sub-notes to a single overall ✅
  once every sub-phase was in. Add a concise summary of P3c's own scope (the
  reconciliation job, its 5-minute/2-minute cadence, the Wompi/ePayco redirect-hint
  capture, Mercado Pago's `searchByReference`, and the explicit disclosed limitation
  that a Wompi/ePayco order with NO providerRef at all cannot be reconciled via any
  API — same honesty-forward style every prior phase's own README summary already
  uses, including P3b's explicit disclosure of what it could/couldn't verify live).
- Update `docs/SPEC.md`'s own P3 DoD line if any of its literal wording (the "30 min"
  figure specifically) needs a footnote pointing at this phase's documented deviation
  reasoning (design decision 4) — don't silently leave a contradiction between the
  spec's rough draft-time figure and the concrete shipped behavior unexplained.

Steps: run gate → smoke test → update docs → commit `docs: P3c wrap-up — payment-
status reconciliation end-to-end`.

---

## After Task 5

A phase-scoped review (same posture as every prior phase's review) should run before
this branch's PR: read every commit in this plan's range, verify the reconciliation
job's ordering claim against the stock-expiry worker (design decision 4) holds under
a REAL concurrent run of both jobs (not just Task 4's own isolated test), verify the
provider-ref-hint endpoint can't be abused (e.g. can an attacker who guesses/enumerates
order numbers plant a bogus `providerRef` that then causes reconciliation to call
`getTransactionStatus` with an attacker-controlled string against a REAL gateway
API — confirm this is harmless, since the gateway's own authenticated response is
still what decides anything, but verify there's no SSRF-shaped or credential-leak risk
in constructing that outbound request from an unauthenticated hint), and verify no
credential ever leaks in a response body (same top-three priorities P3a's and P3b's
own reviews used). This is also the point to decide whether P3 as a whole (P3a+P3b+P3c)
is ready for a cross-phase whole-branch review + PR, mirroring how P2a+P2b+P2c got one
combined review before PR #3.
