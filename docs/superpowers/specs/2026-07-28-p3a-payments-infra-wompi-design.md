# P3a — Payment Infrastructure + Wompi: Design

**Date:** 2026-07-28
**Source spec:** `docs/SPEC.md` (M5 Payments, partial), `docs/SPEC.md#11` P3 — Online
Payments + Order lifecycle
**Status:** Approved
**Builds on:** P2 (storefront, cart, checkout, order lifecycle, tracking — merged to
`main` via PR #3/#4)

## Goal

A shopper can pay online with a real card/PSE/Nequi/botón-Bancolombia transaction via
Wompi's hosted checkout, from the same single-page checkout P2b already built (contact →
address → shipping → **payment method**, now offering "Wompi" alongside "Contra
entrega"). The merchant enters Wompi credentials in a new admin UI and tests the
connection. A webhook confirms payment and the order transitions the same way a COD
order does when the merchant confirms it — automatically, without a click. Stock is
held for 15 minutes while payment is pending and released if it's abandoned.
Mercado Pago/ePayco (P3b) and the reconciliation job (P3c) are explicitly out of scope —
Wompi is the only concrete gateway wired end-to-end here, but every piece of shared
infrastructure (encryption, provider registry, webhook endpoint routing, stock
reservation) is built generically so P3b only has to add a second `PaymentProvider`
implementation, not touch this phase's plumbing.

## Decisions made during brainstorming

1. **P3a/P3b/P3c split.** P3a = shared payment infrastructure (credential encryption,
   provider registry, webhook endpoint, stock reservation + TTL expiry job, admin
   credentials UI) + Wompi wired end-to-end, since building the infrastructure without
   a real gateway to prove it against would be guesswork. P3b = Mercado Pago + ePayco,
   reusing every piece of P3a's infrastructure. P3c = the reconciliation job (spec's
   "orders `PENDING` older than 30 min → poll `getTransactionStatus`") + any
   cross-gateway hardening a P3a/P3b review surfaces. This mirrors the P2a/b/c split.

2. **Stock reservation reuses the existing atomic stock-adjustment machinery, not a
   new ledger table.** P2c's `orders.service.ts` already has `adjustStockLine` — an
   atomic `UPDATE ... WHERE stock + delta >= 0 RETURNING stock` + `InventoryMovement`
   write, exercised and reviewed for COD's confirm/cancel-restock flow. Rather than
   inventing a separate "reserved quantity" column, an online-payment checkout
   **actually decrements** `Product`/`ProductVariant.stock` at order-creation time
   (same mechanism, a new `InventoryMovement.reason: 'order_reserved'`) and stamps
   `Order.stockReservedUntil = now() + 15min` (new nullable column — `null` for every
   COD order, and for any order past the pending/reserved stage). "Reserved" in the
   spec's language IS this decrement; going to `PAID` doesn't decrement a second time,
   it just stops the reservation from being reversible (clears
   `stockReservedUntil` to `null`). This is simpler and lower-risk than a parallel
   reservation ledger, reuses code that's already been adversarially reviewed twice,
   and needs only one schema column + one new `InventoryMovement` reason string.

3. **Webhook-confirmed payment is a NEW, narrow transition path — it does NOT reuse
   `OrdersService.transition('confirm')` verbatim.** That method unconditionally
   decrements stock on `confirm` (correct for COD, where nothing was decremented yet).
   Reusing it for a webhook `PAID` event would double-decrement stock already
   reserved at checkout. Instead, `PaymentsService.markPaid(...)` is a new, small
   method: validates `status === 'PENDING' && paymentStatus === 'PENDING'`, sets
   `paymentStatus: 'PAID'`, `status: 'CONFIRMED'`, `stockReservedUntil: null`, writes
   one `OrderEvent` — under the same advisory-lock-per-order pattern
   `OrdersService.transition()` already established (`pg_advisory_xact_lock(hashtext(orderId))`),
   for the identical reason: a webhook retry racing an admin action on the same order
   must serialize, not corrupt state.

4. **`OrdersService.transition()`'s existing `cancel` branch needs one deliberate,
   scoped change**: an online-payment order sitting in `PENDING` *can* have
   already-decremented (reserved) stock — unlike a COD `PENDING` order, which never
   does. The restock condition widens from `RESTOCKABLE_STATUSES.has(order.status)` to
   `RESTOCKABLE_STATUSES.has(order.status) || order.stockReservedUntil !== null`, so a
   merchant (or shopper-initiated abandon, if ever exposed) cancelling a reserved
   `PENDING` order restocks correctly. This is the one required edit to already-shipped
   P2c code; everything else P3a adds is new files.

5. **TTL expiry runs as a BullMQ repeatable job, not a cron script or a lazy
   check-on-read.** Spec explicitly calls for BullMQ (already true of the
   reconciliation job in P3c and matching the spec's M4 AC: "released by a BullMQ
   job"). This is the first BullMQ usage in the codebase — `bullmq` + a Redis
   connection (reusing `REDIS_URL`, already a required env var for
   `DomainResolver`'s cache) are new dependencies for `services/api`. The job runs
   every minute, queries `Order` rows where `stockReservedUntil IS NOT NULL AND
   stockReservedUntil < now() AND status = 'PENDING'`, and for each: restocks (reusing
   `adjustStockLine`, reason `'order_expired'`), sets `status: 'CANCELLED'`,
   `paymentStatus: 'EXPIRED'`, `stockReservedUntil: null`, writes an `OrderEvent`. This
   is a NEW function (not a call into `transition()`'s `cancel` action, which is a
   merchant-actor, single-order, HTTP-triggered path) — a plan task builds it as its
   own tenant-agnostic sweep across all tenants' expired reservations in one pass
   (BullMQ jobs aren't naturally tenant-scoped the way HTTP requests are).

6. **Credential encryption: AES-256-GCM, key from a new required env var
   (`PAYMENTS_ENCRYPTION_KEY`), stored in `Tenant.settings.payments.providers.wompi`
   (JSON, same established per-provider-namespace pattern as `settings.shipping`/
   `settings.storeInfo`).** Only the encrypted ciphertext (+ IV + auth tag) is
   persisted; the plaintext key/secret is decrypted in-memory only at the moment
   `createCheckoutSession`/`verifyAndParseWebhook`/`getTransactionStatus` need it. No
   plaintext credential is ever included in `GET /v1/admin/settings`'s response — the
   admin UI can display "connected" + a masked suffix (e.g. last 4 chars of the public
   key, which isn't secret) but never the private key, matching the codebase's existing
   posture of never returning a session/auth secret in any API response.

7. **Provider registry: a small, explicit `Record<PaymentProviderId, PaymentProvider>`
   map**, not a dynamic plugin/discovery mechanism — 3 gateways total per spec, no
   reason to over-engineer. `packages/payments` already exports the `PaymentProvider`
   interface (P0 scaffold, unchanged); this phase adds `packages/payments/src/wompi.ts`
   implementing it, and `services/api/src/payments/provider-registry.ts` wiring
   `{wompi: new WompiProvider()}` — P3b adds two more map entries, nothing else in the
   registry's shape changes.

8. **Checkout's `paymentMethod` field widens from the literal `'cod'` to
   `'cod' | 'wompi'`.** For `'wompi'`: skip the COD-availability check entirely (that
   only applies to COD), create the order as `status: 'PENDING'`,
   `paymentStatus: 'PENDING'`, `paymentProvider: 'wompi'`, reserve stock (decision 2),
   call `WompiProvider.createCheckoutSession(...)`, and return `{orderNumber,
   totalCents, redirectUrl}` instead of just `{orderNumber, totalCents}` — the
   storefront checkout page (already built in P2b) redirects the browser to
   `redirectUrl` instead of going straight to the order-confirmation page. The
   order-confirmation page itself needs no change: Wompi redirects the shopper back to
   it after payment (a `?order=<number>` style return URL), and by the time they land
   there the webhook has very likely already flipped the order to `CONFIRMED`/`PAID` —
   if it hasn't yet (webhook lag), the confirmation page shows the order's *current*
   state (still `PENDING`), which is honest and requires no new "waiting for payment"
   UI for this phase (a nice-to-have, not spec-required).

9. **Webhook signature verification and idempotency are non-negotiable, tested
   explicitly** (spec AC: "a webhook with an invalid signature returns 401 and is
   logged"; "replaying the same webhook 10× results in exactly one state transition").
   `WebhookEvent`'s existing `@@unique([provider, eventId])` (P0 schema) is the
   idempotency key — the webhook handler inserts a `WebhookEvent` row FIRST (or relies
   on the unique constraint's conflict to short-circuit a duplicate before any order
   mutation), and only calls `markPaid`/records a failure once per unique event.

## Architecture

### 0. Schema changes (one migration)

- `Order.stockReservedUntil DateTime?` (new, nullable, no default) — decision 2/4.
- `Order.paymentProvider` already exists (`String?`) — no change, just starts getting
  populated with `'wompi'`.
- No new `StockReservation`/`PaymentCredential` tables: reservation state lives on
  `Order` (decision 2), credentials live in `Tenant.settings.payments.providers.wompi`
  JSON (decision 6) — both deliberately reuse existing JSON-settings/columns rather
  than adding tables, matching this codebase's established "don't add a table for a
  small, tenant-scoped config blob" convention (shipping methods, store info, theme all
  already live in `Tenant.settings`).
- `Payment`/`WebhookEvent` (P0 schema) are otherwise unchanged and finally get their
  first real writes in this phase.

### 1. `packages/payments` — Wompi adapter

- `packages/payments/src/wompi.ts`: `WompiProvider implements PaymentProvider`.
  Wompi's real API (hosted "Web Checkout"): a checkout session is really just a
  signed redirect URL built client-side from `publicKey` + an integrity signature
  (`SHA256(reference + amountInCents + currency + integritySecret)`) — no server-side
  "create session" API call is actually needed for `createCheckoutSession`, it
  computes the signature and builds the URL. `verifyAndParseWebhook` validates
  Wompi's own webhook signature scheme (`checksum` header, computed from an
  `events` secret over specific payload fields per Wompi's docs — read their real
  webhook-signature spec during implementation, don't guess the exact field list).
  `getTransactionStatus` calls Wompi's real transaction-status REST endpoint
  (`GET /v1/transactions/:id`) with the tenant's private key as a bearer token.
- Sandbox vs. production is a a Wompi-specific base-URL + key-prefix distinction
  (sandbox keys are prefixed `pub_test_`/`prv_test_`, production `pub_prod_`/
  `prv_prod_`) — `TenantProviderConfig.sandbox: boolean` picks the base URL; the key
  prefix itself is Wompi's own signal, not something this code needs to enforce.

### 2. `services/api/src/payments/` — new module

- `encryption.ts`: `encrypt(plaintext, key): string` / `decrypt(ciphertext, key): string`
  — AES-256-GCM, a random IV per encryption, IV + auth tag + ciphertext concatenated
  into one stored string (e.g. `base64(iv):base64(tag):base64(ciphertext)`). `key`
  comes from `process.env.PAYMENTS_ENCRYPTION_KEY` (32 raw bytes, base64-encoded in
  the env var) — added to `@ventia/core`'s env schema as a required field (no
  default — an unset encryption key must fail loudly at boot, not silently produce
  garbage credentials).
- `provider-registry.ts`: `PROVIDERS: Record<PaymentProviderId, PaymentProvider> =
  {wompi: new WompiProvider()}`.
- `payments.service.ts`: `getTenantProviderConfig(tenantId, provider)` (reads +
  decrypts from `Tenant.settings.payments.providers.<provider>`),
  `saveProviderCredentials(tenantId, provider, {publicKey, privateKey, sandbox})`
  (encrypts + writes), `testConnection(tenantId, provider)` (calls
  `getTransactionStatus` with a known-bad reference or the provider's own
  connectivity-check idiom — Wompi's is simplest via a merchant-info GET endpoint;
  confirm the least destructive real check during implementation), `markPaid(tenantId,
  orderId, provider, providerRef)` (decision 3).
- `webhooks.controller.ts`: `POST /webhooks/payments/:provider/:tenantId` — no
  session/tenant-resolution guard (this is called by Wompi's servers, not a browser;
  `:tenantId` and `:provider` are path params, not header-resolved). Reads the raw
  request body (needed for signature verification — NestJS's default JSON body
  parsing must be bypassed/preserved as a raw buffer for this one route, same concern
  spec's `RawRequest` interface already anticipates), looks up `PROVIDERS[provider]`,
  calls `verifyAndParseWebhook` — a thrown/failed verification returns 401 and logs
  (not a generic 500). On success: insert `WebhookEvent` (unique constraint catches a
  replay), then only for a genuinely-new event, call `PaymentsService.markPaid(...)`
  for a `PAID` normalized status (a `FAILED` normalized status sets
  `paymentStatus: 'FAILED'` without touching `status`/stock — spec doesn't require
  auto-restocking on a failed attempt, since the shopper may just retry the same
  order).
- `stock-reservation.worker.ts`: the BullMQ repeatable job (decision 5), registered in
  `payments.module.ts`.

### 3. Checkout wiring (`services/api/src/checkout/checkout.controller.ts`,
`.service.ts` — extended, not rewritten)

- `paymentMethod: 'cod' | 'wompi'` (decision 8). The `cod` branch is untouched
  (byte-for-byte the same code path P2b/review already hardened). A new `wompi`
  branch: skip `isCodAllowed`, reserve stock via `adjustStockLine` (imported from
  `orders.service.ts` — exported for reuse, since it's already the right atomic
  primitive) + stamp `stockReservedUntil`, create the `Order` with
  `paymentProvider: 'wompi'`, call `PROVIDERS.wompi.createCheckoutSession(...)`,
  return `{orderNumber, totalCents, redirectUrl}`.

### 4. Admin UI (`apps/admin/app/(app)/configuracion/page.tsx` — extend the existing
"Pagos" tab, or split Wompi credentials into a sibling tab if "Pagos" would get
crowded — same "check the file's size first" judgment call P2b Task 6 made for
Shipping)

- Public key, private key (masked `<input type="password">`, never pre-filled with
  the real decrypted value — same "write-only from the UI's perspective" posture a
  session/auth secret gets), sandbox toggle, "Probar conexión" button calling a new
  `POST /v1/admin/settings/payments/wompi/test-connection` endpoint.
- `PATCH /v1/admin/settings/payments` (existing endpoint, currently just
  `{codEnabled}`) extends to accept an optional nested `providers.wompi` object —
  mirrors how `shipping`'s wholesale-replace endpoint was added in P2b Task 3, but
  this one is a genuine merge-in-place (like `storeInfo`), since accidentally wiping
  `codEnabled` by only sending `providers` (or vice versa) would be a real regression
  risk worth calling out to the implementer explicitly.

## Out of scope for P3a (explicitly deferred)

- Mercado Pago, ePayco (P3b).
- The 30-minute reconciliation job (P3c) — P3a's expiry job only handles the
  15-minute stock-reservation TTL, a different concern (releasing stock) from
  reconciliation (catching a webhook that never arrived at all for an order that's
  actually been paid).
- Refunds (`PaymentProvider.refund?` is optional in the interface for a reason —
  spec marks it "Phase 2" in its own comment, i.e., later than P3).
- A "waiting for payment" storefront UI state (decision 8) — the confirmation page
  just shows current order state.
- DIAN/billing-fields (already deferred since P2b, unrelated to this phase).
