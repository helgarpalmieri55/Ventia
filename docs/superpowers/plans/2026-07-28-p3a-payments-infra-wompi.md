# P3a — Payment Infrastructure + Wompi Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A shopper can choose "Wompi" as a payment method at checkout, gets
redirected to Wompi's hosted checkout, and — once Wompi's webhook confirms
payment — the order automatically transitions to `CONFIRMED`/`PAID` with no
merchant action needed. Stock is held for 15 minutes while payment is
pending and released by a background job if abandoned. The merchant enters
Wompi credentials (encrypted at rest) in a new admin UI with a
"test connection" button.

**Architecture:** A new `services/api/src/payments/` module (encryption,
provider registry, webhook endpoint, stock-reservation expiry worker) plus a
real `WompiProvider` in `packages/payments`. `services/api/src/checkout/`
(P2b) gains a `wompi` branch alongside its existing `cod` one. P2c's
`orders.service.ts` gets one deliberate, scoped edit (widen the cancel-restock
condition) and exports its `adjustStockLine` helper for reuse. One schema
migration (`Order.stockReservedUntil`). First use of BullMQ in this codebase
— reuses the existing `REDIS_URL` connection.

**Tech Stack:** NestJS 10 · Prisma 6 (one migration) · `bullmq` (new
dependency) · Node's built-in `crypto` (AES-256-GCM, no new dependency) ·
Vitest + Testcontainers (Postgres, Redis) · a recorded-HTTP-fixture or
sandbox-credential approach for Wompi's real API (no live sandbox account
is available in CI — tasks below specify exactly what's faked vs. real).

## Global Constraints

- All UI copy es-CO Spanish; code/comments/commits English. TypeScript
  strict. Conventional commits.
- Every existing COD code path (checkout's `cod` branch, `settings.payments`'
  `codEnabled` toggle, the full P2b/P2c test suites) must remain byte-for-byte
  unregressed — run the FULL `pnpm --filter @ventia/api test` suite after
  every task, not just the new file.
- All new domain writes go through `tenantDb(tenantId)` except where an
  existing precedent already requires `platformDb`'s manual-RLS-escape
  pattern (checkout's advisory-lock transaction, order transitions' advisory-
  lock transaction) — the webhook handler and the stock-reservation worker
  both fall into the latter category (cross-tenant-scope operations/raw SQL
  needs), follow `checkout.service.ts`'s/`orders.service.ts`'s established
  `SET LOCAL ROLE ventia_app` + `set_config('app.tenant_id', ...)` pattern
  exactly.
- Typed error convention: `{ error: CODE, details? }` — this phase's new
  codes: `PAYMENT_PROVIDER_NOT_CONFIGURED`, `WEBHOOK_INVALID_SIGNATURE`,
  `WEBHOOK_UNKNOWN_PROVIDER`.
- No Mercado Pago/ePayco (P3b), no 30-minute reconciliation job (P3c), no
  refunds — see the design doc's "Out of scope" section.
- `PAYMENTS_ENCRYPTION_KEY` is a new REQUIRED env var (no default — see
  design doc decision 6) — every test file that boots the full app needs it
  set (add to `.env.example` and any test setup that currently hand-sets env
  vars like `AUTH_SECRET`).

## Task sequence

### Task 1: Schema migration + encryption utility + BullMQ dependency

**Files:**
- Modify: `packages/db/prisma/schema.prisma` (add `Order.stockReservedUntil
  DateTime?`), new migration under `packages/db/prisma/migrations/`
- Modify: `packages/core/src/env.ts` (add `PAYMENTS_ENCRYPTION_KEY:
  z.string().min(1)`, required, no default — validate it decodes to exactly
  32 bytes when base64-decoded, throwing a clear message at `loadEnv()` time
  if not, since a wrong-length key would otherwise fail cryptically deep
  inside `crypto.createCipheriv`)
- Modify: `services/api/package.json` (add `bullmq`), `.env.example` (add
  `PAYMENTS_ENCRYPTION_KEY=` with a comment showing how to generate one:
  `openssl rand -base64 32`)
- Create: `services/api/src/payments/encryption.ts`
- Test: `packages/core/test/env.test.ts` (extend), `services/api/test/encryption.test.ts`

**Interfaces:**
```ts
// services/api/src/payments/encryption.ts
export function encrypt(plaintext: string, key: Buffer): string; // "base64(iv):base64(tag):base64(ciphertext)"
export function decrypt(ciphertext: string, key: Buffer): string; // throws on tampered/malformed input (GCM auth tag mismatch)
export function loadEncryptionKey(): Buffer; // reads+base64-decodes process.env.PAYMENTS_ENCRYPTION_KEY, throws a clear error if not exactly 32 bytes
```

**Tests:** `encryption.test.ts` — encrypt/decrypt round-trips a variety of
strings (empty string, unicode, a realistic-length API key); decrypting a
tampered ciphertext (flip one byte) throws rather than silently returning
wrong plaintext (GCM's whole point); two encryptions of the SAME plaintext
produce DIFFERENT ciphertexts (random IV, not deterministic — a reviewer
should be able to see this proven, not just asserted); `loadEncryptionKey()`
throws a clear, specific error for a missing/wrong-length env var (test via
constructing the function to accept an injectable env source, matching
`loadEnv`'s own `source` parameter pattern, rather than mutating
`process.env` in a test).

Steps: RED → implement → migrate → tests green → typecheck → commit
`feat: add payments encryption utility, stockReservedUntil column, bullmq dep`.

---

### Task 2: Wompi adapter (`packages/payments/src/wompi.ts`)

**Files:**
- Modify: `packages/payments/src/index.ts` (export `WompiProvider` from a new
  file), create `packages/payments/src/wompi.ts`
- Test: `packages/payments/test/wompi.test.ts`

**Interfaces:** `WompiProvider implements PaymentProvider` (the interface
already in `packages/payments/src/index.ts` — do not change its shape).

Research Wompi's REAL API during this task (do not guess field names):
their public docs for "Web Checkout" (redirect-based integration),
transaction-status endpoint, and events/webhook signature scheme
(`https://docs.wompi.co` as of when this task runs — if unreachable from
this environment, the task brief's own research notes plus any cached
knowledge of Wompi's integrity-signature scheme are the fallback; flag
explicitly in the task report which fields were verified against real docs
vs. inferred).

- `createCheckoutSession(order, cfg)`: builds Wompi's checkout redirect URL
  directly (no server-side "create session" call exists in their real API —
  it's a signed URL: `https://checkout.wompi.co/p/?public-key=...&currency=COP&amount-in-cents=...&reference=...&signature:integrity=...`).
  The integrity signature is `SHA256(reference + amountInCents + currency +
  integritySecret)` hex-encoded — `cfg` needs an `integritySecret` field
  alongside `publicKey`/`privateKey` (extend `TenantProviderConfig` if the
  existing 3-field shape doesn't cover it — check whether this requires a
  4th field or whether Wompi's real integrity secret is derivable from the
  private key; verify against real docs, don't assume).
- `verifyAndParseWebhook(req, cfg)`: Wompi signs webhooks with a `checksum`
  field inside the event payload itself (not an HTTP header — verify this
  against real docs, it may differ from the interface's `RawRequest`
  header-based framing, in which case parse the checksum from the JSON body
  instead) computed over specific event fields + an `events` secret (distinct
  from the `integritySecret` used for checkout signing — confirm whether
  Wompi uses one shared secret or two separate ones). Returns
  `NormalizedPaymentEvent` with `status` mapped from Wompi's own transaction
  status strings (`APPROVED` → `PAID`, `DECLINED`/`ERROR` → `FAILED`,
  `PENDING`/`VOIDED` → whatever the interface's `NormalizedStatus` union
  supports — `VOIDED` may need `FAILED` if there's no better fit; document
  the mapping choice).
- `getTransactionStatus(providerRef, cfg)`: `GET
  https://api.wompi.co/v1/transactions/:id` (sandbox:
  `https://sandbox.wompi.co/v1/transactions/:id`), no auth header needed for
  this GET per Wompi's public-read transaction endpoint (verify — some of
  their endpoints need the private key as a bearer token, confirm which).

**Tests:** `wompi.test.ts` — since there's no live Wompi sandbox account
available in this environment, mock `fetch` (inject a `fetchImpl` param on
every method, matching this codebase's established testability convention —
see `fetchTenantForHost`/`fetchStorefront`'s own `fetchImpl` params) and
assert: `createCheckoutSession` builds the exact expected URL + signature
for a known reference/amount/secret (hand-compute the expected SHA256 hex
digest in the test to independently verify the implementation, don't just
assert "some string" was produced); `verifyAndParseWebhook` accepts a
validly-signed fixture payload and rejects a tampered one (wrong checksum);
`getTransactionStatus` maps each of Wompi's real status strings to the
correct `NormalizedStatus`.

Steps: RED → implement (citing which parts came from real docs vs. best
inference in commit body) → tests green → typecheck → commit `feat: add
Wompi payment provider adapter`.

---

### Task 3: Payments service (credentials CRUD + test-connection + markPaid) + provider registry

**Files:**
- Create: `services/api/src/payments/provider-registry.ts`,
  `services/api/src/payments/payments.service.ts`,
  `services/api/src/payments/payments.module.ts`
- Modify: `services/api/src/settings/settings.controller.ts` (extend
  `PATCH /shipping`'s sibling `PATCH /payments` to accept an optional nested
  `providers.wompi` object — merge-in-place with `codEnabled`, per design
  decision 8 — and add `POST /v1/admin/settings/payments/:provider/test-connection`)
- Test: `services/api/test/payments-service.test.ts`,
  `services/api/test/payments-settings.test.ts`

**Interfaces:**
```ts
// provider-registry.ts
export const PROVIDERS: Record<PaymentProviderId, PaymentProvider> = { wompi: new WompiProvider() };

// payments.service.ts
class PaymentsService {
  async getTenantProviderConfig(tenantId: string, provider: PaymentProviderId): Promise<TenantProviderConfig | null>; // null if not configured — decrypts privateKey/integritySecret in-memory only
  async saveProviderCredentials(tenantId: string, provider: PaymentProviderId, creds: {publicKey: string; privateKey: string; integritySecret?: string; sandbox: boolean}): Promise<void>; // encrypts before writing to settings.payments.providers.<provider>
  async testConnection(tenantId: string, provider: PaymentProviderId): Promise<{ok: boolean; error?: string}>; // calls PROVIDERS[provider].getTransactionStatus with a sentinel/known-invalid ref, or whatever least-destructive real connectivity check Task 2 identified — DOES NOT throw on a real provider-side rejection, returns {ok:false, error} so the admin UI can show it inline
  async markPaid(tenantId: string, orderId: string, provider: string, providerRef: string): Promise<void>; // see design decision 3 — advisory-lock-per-order transaction, validates status===PENDING && paymentStatus===PENDING, sets PAID/CONFIRMED, clears stockReservedUntil, writes OrderEvent; a call on an order NOT in that exact state is a no-op (idempotent for a webhook retry that arrives after markPaid already ran once), not an error
}
```
`getTenantProviderConfig`'s response (and the admin settings GET response)
must NEVER include the decrypted `privateKey`/`integritySecret` — the admin
UI only ever needs to know "is Wompi connected" (boolean) + a masked
`publicKey` suffix, matching design decision 6 exactly; write a test that
asserts `GET /v1/admin/settings`'s JSON body does not contain the raw
plaintext credential anywhere in its serialized form (not just "the field
isn't named privateKey" — actually stringify the response and search for the
plaintext test credential value, the same rigor the original session/auth
secret handling gets elsewhere in this codebase).

**Tests:** `payments-service.test.ts` — round-trips save→get with real
encryption (not mocked), `markPaid` is idempotent (calling it twice only
transitions once, second call is a no-op, verified via `OrderEvent` count
staying at 1), `markPaid` on an order NOT in PENDING/PENDING (e.g. already
CONFIRMED) is a safe no-op not an error. `payments-settings.test.ts` — owner
can PATCH `providers.wompi` credentials without touching `codEnabled`
(merge-in-place, not wholesale-replace — write a test that sets `codEnabled`
first, then PATCHes only `providers.wompi`, then asserts `codEnabled` is
still what it was), staff gets 403, test-connection endpoint calls through
to a mocked/injected provider and surfaces `{ok:false}` without 500ing on a
provider-side failure.

Steps: RED → implement → tests green → typecheck → commit `feat: add
payments service with encrypted credentials and provider registry`.

---

### Task 4: Webhook endpoint

**Files:**
- Create: `services/api/src/payments/webhooks.controller.ts`
- Modify: `services/api/src/main.ts` or wherever body-parsing is configured
  (the webhook route needs the RAW request body for signature verification —
  check how NestJS's default `express` body-parser is wired today and add a
  raw-body exception for this one route, e.g. via `bodyParser.raw()` scoped
  to `/webhooks/*` before Nest's default JSON parser runs, or Nest's
  `rawBody: true` app option + `req.rawBody` — pick whichever this Nest
  version supports cleanly, verify it actually preserves the raw bytes with
  a test, not just by reading the config)
- Test: `services/api/test/webhooks.test.ts`

**Interfaces:** `POST /webhooks/payments/:provider/:tenantId` — no
`PublicTenantGuard` (this isn't a browser request; tenant comes from the
URL path, not header/Host resolution). `:provider` not in `PROVIDERS` → 404
`WEBHOOK_UNKNOWN_PROVIDER`. Signature verification failure →
`verifyAndParseWebhook` throwing/returning invalid → 401
`WEBHOOK_INVALID_SIGNATURE`, and the raw payload is still logged (per spec's
AC) even though it's rejected. On success: insert `WebhookEvent {provider,
eventId, tenantId, payload, processedAt: null}` — a duplicate `(provider,
eventId)` insert hits the existing `@@unique` constraint; catch that specific
conflict and return 200 immediately without calling `markPaid` again (true
idempotency, not just "processed twice but harmlessly" — verify no
double-email/double-mutation is even attempted on a replay, not just that
the end state happens to be correct). For a genuinely new event with
`status: 'PAID'`: call `paymentsService.markPaid(...)`, then update the
`WebhookEvent` row's `processedAt`/`result`. For `status: 'FAILED'`: set
`Order.paymentStatus = 'FAILED'` only (no status/stock change — design
decision, a failed attempt doesn't cancel the order, the shopper may retry).

**Tests:** `webhooks.test.ts` — valid Wompi-shaped payload with correct
signature → 200, order transitions to CONFIRMED/PAID, stock decremented
exactly once (asserted via `Product.stock` before/after, not just the
response). Invalid signature → 401, order untouched, a
`WebhookEvent`/error log exists. **Replay test (spec-required AC): the exact
same valid payload sent 10× → exactly ONE state transition** — assert
`OrderEvent` count for this order stays at whatever it was after event #1
(not 10), and `Product.stock` only decremented once. Unknown provider in the
URL → 404. A `FAILED` event → `paymentStatus` becomes `FAILED`, `status`
stays `PENDING`, stock is NOT restocked by this path (that's the expiry
job's job, Task 6, not the webhook's).

Steps: RED → implement → tests green (including the 10x-replay test — this
is the single most important test in this task, per spec's explicit AC,
don't skip or weaken it) → typecheck → commit `feat: add payments webhook
endpoint with signature verification and idempotency`.

---

### Task 5: Checkout wiring — `wompi` payment method

**Files:**
- Modify: `services/api/src/checkout/checkout.controller.ts`,
  `checkout.service.ts` (extend `paymentMethod` to `'cod' | 'wompi'`),
  `services/api/src/orders/orders.service.ts` (export `adjustStockLine` for
  reuse — check its current visibility, it's likely a module-private
  function today)
- Test: extend `services/api/test/checkout.test.ts`

**Interfaces:** `CheckoutInput.paymentMethod: 'cod' | 'wompi'`. The `cod`
branch inside `CheckoutService.checkout()`'s transaction is UNCHANGED (do
not refactor it while adding the new branch — a reviewer will diff this
task against a byte-for-byte-preserved `cod` path). New `wompi` branch,
still inside the same `platformDb.$transaction`: skip `isCodAllowed` (COD-
only concept), for each line call `adjustStockLine(tx, tenantId, item,
-item.qty, 'order_reserved', order.id, 'system')` (reuses P2c's atomic
floor-checked UPDATE — if a line's real-time stock can't cover the
reservation, this throws the SAME `STOCK_BELOW_ZERO`-shaped error
`adjustStockLine` already throws elsewhere, which is a reasonable analog to
`INSUFFICIENT_STOCK` for this path — decide and document whether to map it
to `INSUFFICIENT_STOCK` for consistency with the `cod` branch's error
vocabulary, since a shopper shouldn't see an internal `STOCK_BELOW_ZERO` code
from checkout), set `stockReservedUntil: new Date(Date.now() + 15 * 60_000)`,
`paymentProvider: 'wompi'`, `paymentStatus: 'PENDING'` (already the
`Order` model's default, but be explicit), create the `Order`/`OrderItem`s/
`OrderEvent` same as the `cod` branch, then AFTER the transaction commits
(same fire-and-forget-adjacent posture as the existing post-commit email
call, but this one's result IS needed synchronously for the HTTP response,
so it's awaited, not fire-and-forget): call
`PROVIDERS.wompi.createCheckoutSession(...)`, return `{orderNumber,
totalCents, redirectUrl}`. `paymentMethod !== 'wompi' && !== 'cod'` → 400
`VALIDATION_FAILED` (same posture as every other checkout field).

**Tests:** extend `checkout.test.ts` — a `wompi` checkout: 201, response
includes a `redirectUrl` string; `Order.paymentProvider === 'wompi'`,
`paymentStatus === 'PENDING'`, `stockReservedUntil` is set ~15 minutes out;
`Product.stock` is decremented immediately (NOT left untouched the way a
`cod` order's is) — this is the one behavioral difference from every
existing `cod` test in this file, make the assertion explicit and comment
why. Insufficient stock for a `wompi` checkout → same 400 error shape as
the `cod` insufficient-stock test (confirm exact code/shape parity).
Re-run every EXISTING test in this file afterward — zero regressions on the
`cod` path is the bar.

Steps: RED → implement → tests green (full file, not just new ones) →
typecheck → commit `feat: wire wompi payment method into checkout`.

---

### Task 6: Cancel-restock widening + stock-reservation expiry worker

**Files:**
- Modify: `services/api/src/orders/orders.service.ts` (widen the `cancel`
  branch's restock condition per design decision 4 — this is the one
  required edit to already-shipped P2c code, keep it minimal and comment
  why)
- Create: `services/api/src/payments/stock-reservation.worker.ts`,
  register in `services/api/src/payments/payments.module.ts`
- Test: extend `services/api/test/order-transitions.test.ts` (or whatever
  the existing P2c transition test file is actually named — check first),
  new `services/api/test/stock-reservation-worker.test.ts`

**Interfaces:** The widened condition: `RESTOCKABLE_STATUSES.has(order.status)
|| order.stockReservedUntil !== null` (exact boilerplate from the design
doc's decision 4 — read that section again before writing this, it's a
one-line change with a specific reason, don't over-engineer it into a
bigger refactor).

`stock-reservation.worker.ts`: a BullMQ repeatable job (every 60s in
production; the test file should be able to trigger the job's underlying
function directly — export the sweep logic as a plain testable function,
e.g. `expireReservations(): Promise<number>` returning the count processed,
with the BullMQ scheduling wrapper as a thin separate piece, matching this
codebase's established "keep the testable logic separate from the
framework/scheduling glue" convention). The sweep: `SELECT` all `Order` rows
where `stockReservedUntil IS NOT NULL AND stockReservedUntil < now() AND
status = 'PENDING'` (across ALL tenants — this is a platform-level sweep,
not tenant-scoped, so it runs on `platformDb` with the SAME manual-RLS-escape
`SET LOCAL ROLE`+`set_config` pattern per-order as it processes each one, OR
— simpler and worth considering — since this is inherently a cross-tenant
admin-level operation with no per-request tenant context, check whether
`platformDb` queries here can run under a DIFFERENT Postgres role that
bypasses RLS entirely for just this read+the per-order writes, the same way
a genuinely platform-wide job would; decide and document which approach was
taken and why). For each expired order: inside its own advisory-lock
transaction (same `pg_advisory_xact_lock(hashtext(orderId))` pattern,
re-validate `status === 'PENDING'` inside the lock in case an admin/webhook
raced it to a different state between the SELECT and this transaction —
skip it if so, don't blindly restock/cancel), restock every line
(`adjustStockLine(..., +item.qty, 'order_expired', ...)`), set `status:
'CANCELLED'`, `paymentStatus: 'EXPIRED'`, `stockReservedUntil: null`, write
an `OrderEvent`.

**Tests:** cancel-widening — a `wompi` order in `PENDING` with
`stockReservedUntil` set, cancelled via the existing merchant `cancel`
action, correctly restocks (previously would NOT have, since PENDING isn't
in `RESTOCKABLE_STATUSES`) — write this as a NEW test, and confirm every
EXISTING cancel test (COD, PENDING, no restock) still passes unchanged.
`stock-reservation-worker.test.ts`: an expired reserved order gets
restocked + CANCELLED/EXPIRED; a NOT-yet-expired reserved order is left
untouched; an order whose `stockReservedUntil` is set but which somehow
already moved to CONFIRMED (race with a webhook) is skipped, not
double-processed — construct this race directly in the test (set the
order to CONFIRMED between the sweep's SELECT and its per-order transaction,
if the implementation structure allows simulating that, or reason through
and test the re-validation-inside-the-lock guard directly).

Steps: RED → implement → tests green (full API suite) → typecheck → commit
`feat: add stock-reservation expiry worker and widen cancel-restock`.

---

### Task 7: Admin credentials UI

**Files:**
- Modify: `apps/admin/app/(app)/configuracion/page.tsx`'s `PagosTab` (or
  extract a sibling tab if adding Wompi fields would make `PagosTab` too
  large inline — check current file size first, matching the judgment call
  P2b Task 6 made for Shipping)
- Create (if extracted): `apps/admin/components/wompi-tab.tsx` or similar,
  `apps/admin/lib/wompi-form.ts` (mirrors `shipping-form.ts`'s defensive-
  parse pattern for whatever the admin settings GET response's masked
  `providers.wompi` shape ends up being — coordinate with Task 3's actual
  response shape)
- Test: `apps/admin/test/wompi-form.test.ts` (if a form-state helper is
  extracted)

**Interfaces:** Public key input, private key input (`type="password"`,
NEVER pre-filled with a real value even if already configured — same masked-
write-only posture as any secret field elsewhere in this app), integrity
secret input if Task 2 confirmed Wompi needs one, a sandbox/production
toggle, "Probar conexión" button calling `POST
/v1/admin/settings/payments/wompi/test-connection` and showing its
`{ok, error?}` result inline (success/error `Alert`, same pattern every
other tab already uses). Save button `PATCH`es `/v1/admin/settings/payments`
with `{providers: {wompi: {...}}}` — codEnabled untouched (merge-in-place,
per Task 3).

**Tests:** whatever form-state helper is extracted gets the same defensive-
parse test coverage `shipping-form.ts`/`theme-form.ts` already established
(undefined/malformed input never crashes the page).

Steps: RED (if applicable) → implement → `pnpm --filter @ventia/admin build
&& typecheck && lint` → commit `feat: add Wompi credentials UI to admin
configuración`.

---

### Task 8: Storefront checkout redirect wiring

**Files:**
- Modify: `apps/storefront/app/checkout/page.tsx` (or wherever P2b's
  checkout page lives — confirm the exact path first) to offer "Wompi" as a
  payment-method option alongside "Contra entrega" and, on a successful
  `wompi` checkout response, `window.location.href = redirectUrl` instead of
  navigating to the order-confirmation page directly
- Test: extend whatever the existing storefront checkout page test file is

**Interfaces:** No new client-state architecture needed — this is a small
addition to an existing form's payment-method radio/select and its submit
handler's success branch (`if (result.redirectUrl) { window.location.href =
result.redirectUrl; } else { router.push(...) }` or equivalent, matching
however the existing COD success path already navigates).

**Tests:** submitting with `paymentMethod: 'wompi'` and a mocked
`redirectUrl` in the response triggers a redirect to that URL (assert via
whatever this app's existing test convention is for asserting a navigation/
`window.location` call — check an existing test for the pattern rather than
inventing a new mocking approach).

Steps: RED → implement → `pnpm --filter @ventia/storefront build && typecheck
&& lint` → commit `feat: wire Wompi payment option into storefront
checkout`.

---

### Task 9: P3a wrap-up — full gate + manual/sandbox smoke + docs

**Files:** `README.md` (document the new env var, webhook URL shape, and
that P3a covers Wompi only — Mercado Pago/ePayco are P3b), no code changes
expected beyond fixing whatever the gate surfaces.

**Steps:**
- Full monorepo gate: `pnpm turbo run lint typecheck build test` — zero
  regressions across every existing test file from every prior phase.
- Manual smoke test against the real dev stack, as thoroughly as prior
  phases' wrap-up tasks (P2a-9/P2b-10/P2c-6 all did real Playwright/curl
  smoke passes, not just unit tests) — for Wompi specifically, since a real
  sandbox account may not be available in this environment: at minimum,
  drive a `wompi` checkout through the real API with a MOCKED/faked
  `PROVIDERS.wompi` (documented clearly as such, not presented as a real
  sandbox transaction) to confirm the reservation → webhook → confirm →
  stock-decremented-once chain works end to end through real HTTP + a real
  Postgres, not just the unit-test suite's in-process assertions. If real
  Wompi sandbox credentials genuinely can't be obtained, say so explicitly
  in the report rather than silently skipping this verification.
- Update README's Phase status: P3 stays ⬜ overall (P3b/P3c remain), but
  add a sub-note that P3a (payment infra + Wompi) is done, matching how
  P2a/P2b were noted as sub-phases before all of P2 flipped to ✅.

Steps: run gate → smoke test → update docs → commit `docs: P3a wrap-up —
payment infrastructure + Wompi end-to-end`.

---

## After Task 9

A phase-scoped review (same posture as every prior phase's review) should
run before starting P3b: read every commit in this plan's range, verify the
webhook idempotency/signature tests are genuinely rigorous (not just
present), verify the stock-reservation race conditions (webhook vs. expiry
worker vs. merchant cancel, all touching the same order concurrently) are
actually safe, and verify no credential ever leaks in a response body.
