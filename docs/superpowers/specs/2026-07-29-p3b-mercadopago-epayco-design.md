# P3b — Mercado Pago + ePayco: Design

**Date:** 2026-07-29
**Source spec:** `docs/SPEC.md` (M5 Payments), `docs/SPEC.md#11` P3 — Online Payments +
Order lifecycle
**Status:** Approved
**Builds on:** P3a (payment infrastructure + Wompi — encryption, provider registry,
webhook routing, stock reservation, admin UI, checkout wiring, all merged and reviewed)

## Goal

A shopper can choose "Mercado Pago" or "ePayco" as a payment method at the same
single-page checkout P3a already extended with "Wompi," gets redirected to that
gateway's hosted checkout, and — once its webhook confirms payment — the order
transitions automatically, exactly the way a `wompi` order already does. The merchant
enters Mercado Pago/ePayco credentials in new sections of the existing admin "Pagos"
tab. No new shared infrastructure is needed: P3a's encryption, provider registry,
webhook routing (already dispatches generically on the `:provider` URL segment), stock
reservation, and advisory-lock transition machinery are all provider-agnostic already —
P3b's job is exactly two new `PaymentProvider` implementations plus the mechanical
wiring P3a's own code already anticipated (`PROVIDERS` is typed
`Partial<Record<PaymentProviderId, PaymentProvider>>` specifically so P3b can add two
more map entries; `PaymentProviderId` already includes `'mercadopago' | 'epayco'`).

**Research posture:** per `docs/SPEC.md`'s explicit instruction ("never implement from
memory — read the official docs at implementation time; APIs change"), every API fact
below was fetched from Mercado Pago's and ePayco's real developer documentation during
this design task (source URLs cited inline), not recalled from training data — mirroring
how P3a's Wompi adapter cited its own sources. Facts that could only be confirmed via a
search-engine summary rather than a directly-fetched page are explicitly flagged as
lower-confidence, and one open question (ePayco's post-payment return-redirect
mechanism) is explicitly left for the implementation task to verify directly, matching
P3a Task 2's own precedent of flagging a genuinely-uncertain response-shape detail
rather than guessing it.

## Decisions made during brainstorming

1. **Both gateways in one phase (P3b), reusing 100% of P3a's infrastructure.**
   Per `docs/SPEC.md`'s explicit implementation order (Wompi → Mercado Pago → ePayco)
   and this phase's own scope choice (user selected "P3b — Mercado Pago + ePayco" as
   one combined phase, matching the spec's P3b grouping). No new tables, no new
   webhook-routing logic, no new stock-reservation mechanism — all of that is
   provider-agnostic today. The only genuinely shared, non-mechanical work is
   `checkout.service.ts`'s wompi-specific branches (see decision 2).

2. **Generalize `checkout.service.ts`'s `paymentMethod === 'wompi'` branches to "any
   non-`cod` method," rather than duplicating a near-identical branch per provider.**
   Reading the current code (P3a), every online-payment-specific check is a literal
   `=== 'wompi'` string comparison (credential-check, stock-reservation branch,
   `Order.paymentProvider`/`paymentStatus` assignment, the post-commit
   `createCheckoutSession` call) — none of that logic is actually Wompi-specific, it's
   "any hosted-redirect gateway." `CheckoutInput.paymentMethod` widens from
   `'cod' | 'wompi'` to `'cod' | 'wompi' | 'mercadopago' | 'epayco'`
   (`PaymentProviderId`, already defined in `@ventia/payments`, is the natural type to
   reuse here instead of hand-rolling a new union), every `=== 'wompi'` check becomes
   `!== 'cod'`, and the one hardcoded `getProvider('wompi')` call becomes
   `getProvider(input.paymentMethod as Exclude<PaymentMethod, 'cod'>)`. This is a
   mechanical refactor with zero behavior change for the existing `cod`/`wompi` paths —
   the full P2b/P2c/P3a test suite (including every wompi-specific test) must stay
   byte-for-byte green after it, proving the generalization didn't change wompi's own
   behavior.

3. **`TenantProviderConfig` widens by exactly one new optional field:
   `epaycoCustomerId?: string`.** Neither Mercado Pago nor ePayco needs
   `integritySecret` (that field is specifically Wompi's *outbound*
   checkout-URL-signing secret — neither other gateway computes a client-side-signed
   redirect URL, see decisions 4/5). `eventsSecret` is repurposed as a shared,
   provider-agnostic "the secret used to verify an *inbound* webhook/confirmation
   signature" — Wompi's `eventsSecret`, Mercado Pago's per-application webhook signing
   secret, and ePayco's `P_KEY` (used in its confirmation-hash formula) are all,
   conceptually, exactly this same role, so all three fit the existing field without
   forcing a rename. ePayco's confirmation-signature formula (decision 5) needs a
   SECOND value alongside `P_KEY` — `P_CUST_ID_CLIENTE` — which has no existing
   analog in `TenantProviderConfig` at all, hence the one new field. Named
   `epaycoCustomerId` (not a generic `customerId`) specifically to avoid any confusion
   with this codebase's own `Customer` model (a shopper), which this field has nothing
   to do with — it's ePayco's *merchant account* identifier.
   `publicKey`/`privateKey` map directly onto each gateway's own like-named
   credential pair for both new providers (see decisions 4/5 for exactly which real
   credential goes in which field).

4. **Mercado Pago's `createCheckoutSession` becomes a real server-side HTTP call**
   (`POST /checkout/preferences`), unlike Wompi's pure-local signed-URL construction.
   Source: [Checkout Pro overview](https://www.mercadopago.com.co/developers/en/docs/checkout-pro/overview),
   [configure-back-urls](https://www.mercadopago.com.ar/developers/en/docs/checkout-pro/configure-back-urls) —
   confirmed directly. Request: `items: [{title, unit_price, quantity, currency_id: 'COP'}]`,
   `external_reference: order.orderNumber` (confirmed round-trip field, same role as
   Wompi's `reference`), `back_urls: {success, failure, pending}` pointing at the
   storefront's order-confirmation route + `auto_return: 'approved'`, `notification_url`
   pointing at this tenant's `/webhooks/payments/mercadopago/:tenantId`. Auth:
   `Authorization: Bearer <privateKey>` where `privateKey` holds MP's real "Access
   Token" (the server-side secret) — confirmed via the
   [Credentials page](https://www.mercadopago.com.ar/developers/en/docs/checkout-pro/additional-content/credentials).
   `publicKey` holds MP's real "Public Key" — confirmed to be a frontend-only,
   card-tokenization credential this adapter's redirect-only flow never actually calls,
   collected anyway for consistency with the two-key admin-UI pattern and in case a
   future (non-redirect) MP integration needs it; **this is a deliberate,
   documented "collected but unused by this adapter" field**, not an oversight — say so
   in the adapter's own doc comment so a future reader isn't confused about why
   `publicKey` is never read. Response returns `init_point` (production) and
   `sandbox_init_point` (test) — `cfg.sandbox` selects which one `createCheckoutSession`
   returns as `redirectUrl`; **the API base URL itself does NOT change between sandbox
   and production** (single `api.mercadopago.com` host for both, confirmed on
   [configure-development-environment](https://www.mercadopago.com.ar/developers/en/docs/checkout-pro/configure-development-enviroment)) —
   unlike Wompi's differing sandbox/production API hosts, `cfg.sandbox` for Mercado
   Pago only ever selects which field of the SAME response to read, never a different
   base URL. **Lower confidence, flag for implementation-time verification**: the exact
   test-credential prefix string — MP's own Credentials page explicitly hedges that
   this "may vary depending on the solution you are integrating" and gives no
   canonical example; do not hardcode a prefix check anywhere.

5. **Mercado Pago webhooks: `x-signature` HMAC-SHA256, verified against a specific
   manifest string, followed by a mandatory follow-up GET.** IPN is explicitly
   deprecated by Mercado Pago's own docs ("IPN notifications will be discontinued...
   they do not allow validation through the secret key" —
   [IPN page](https://www.mercadopago.com.co/developers/en/docs/your-integrations/notifications/ipn)),
   so this only implements the current webhooks mechanism. The delivered payload is
   lightweight (`{type, data: {id}}`, confirmed on the
   [webhooks page](https://www.mercadopago.com.co/developers/en/docs/your-integrations/notifications/webhooks)) —
   `verifyAndParseWebhook` must therefore, after verifying the signature, make a
   SECOND real HTTP call (`GET /v1/payments/{data.id}`, Bearer `privateKey`) to fetch
   the actual `status`/`transaction_amount`/`external_reference` before it can return a
   `NormalizedPaymentEvent` — a genuine two-step verify-then-fetch shape, unlike
   Wompi's single-payload verification. `x-signature` header format is
   `ts=<unix-seconds>,v1=<hex-hmac>`; the manifest to HMAC-SHA256 (secret =
   `cfg.eventsSecret`) is the literal template `id:{data.id};request-id:{x-request-id};ts:{ts};`
   (omitting any pair whose value is absent), compared against `v1` — confirmed
   directly on the [payment-notifications page](https://www.mercadopago.com.mx/developers/en/docs/checkout-pro/payment-notifications.md)
   and cross-referenced on the co webhooks page. `x-request-id` is a second required
   header (available via `RawRequest.headers`, same as Wompi's header-agnostic
   `RawRequest` shape already anticipates — MP is the first adapter to actually need a
   header, not just `rawBody`). **Lower confidence, flag for implementation-time
   verification**: `GET /v1/payments/:id`'s exact full response schema — the
   interactive API-reference page 404'd on every direct fetch attempt during this
   design's research (it's client-side-rendered), so the field names above
   (`status`, `transaction_amount`, `external_reference`, `id`) are cross-referenced
   from multiple independent search summaries, not read verbatim off an official page
   the way the webhook signature formula was — verify against a real sandbox response
   before trusting the exact shape.
   **Status mapping — a deliberate, explicit judgment call** (MP's real vocabulary,
   confirmed across multiple pages, has more terminal states than Wompi's):
   `approved → PAID`; `pending`/`in_process`/`authorized`/`in_mediation → PENDING`;
   `rejected → FAILED`; **`cancelled → FAILED`** (not `EXPIRED` — reasoning below);
   **`refunded`/`charged_back → EXPIRED`** (reasoning below). This mapping is chosen
   with direct reference to how `services/api/src/payments/webhooks.controller.ts`
   (P3a, unchanged by this phase) actually treats each `NormalizedStatus` today: `PAID`
   calls `markPaid`, `FAILED` calls `markFailed` (both real, actionable mutations),
   while `PENDING`/`EXPIRED` both fall into the SAME no-mutation "durably record, log,
   no-op" branch. `cancelled` represents a preference that will never be paid — the
   same real-world category as Wompi's `DECLINED`/`VOIDED` (which already map to
   `FAILED`), so mapping it to the actionable `FAILED` state (not the silent `EXPIRED`
   no-op) is the MORE useful, MORE consistent-with-precedent choice: it lets the
   merchant/shopper see an accurate `paymentStatus: FAILED` and retry, exactly like a
   declined Wompi transaction already does. `refunded`/`charged_back`, by contrast,
   represent a PREVIOUSLY-`PAID` transaction being reversed after the fact — an order
   that may already be `CONFIRMED`, decremented, or even shipped. Neither `FAILED` (would
   misleadingly suggest the payment never succeeded) nor any automatic un-confirm/
   restock action (P3a/P3b build no such flow, and blindly reversing a possibly-already-
   shipped order with zero merchant visibility is actively dangerous) is safe here — so
   these two map to the SAME no-op-logged bucket as `EXPIRED`, guaranteeing the event is
   durably recorded (a `WebhookEvent` row, visible for a human to notice) but never
   automatically mutates a real order. This is the same reasoning shape Wompi's design
   used for `VOIDED → FAILED` (documented, deliberate, not silently picked) — just
   landing on a different bucket because refund/chargeback genuinely is a different
   real-world situation than a simple decline.

6. **ePayco's checkout flow is architecturally different from both other gateways — a
   client-side JS widget, not a server-computable redirect URL — and needs one new
   thin storefront route to bridge that gap without touching the shared
   `PaymentProvider` interface.** ePayco's current "Smart Checkout" v2 product
   (confirmed current name, not the legacy "Checkout Onepage") requires: (a) a
   server-side `POST https://apify.epayco.co/login` (HTTP Basic, `base64(publicKey:
   privateKey)`) returning a JWT, (b) `POST https://apify.epayco.co/payment/session/create`
   (Bearer JWT) returning a `sessionId` — both confirmed on
   [checkout-implementacion](https://docs.epayco.com/docs/checkout-implementacion) —
   and then (c) the BROWSER loading `https://checkout.epayco.co/checkout-v2.js` and
   calling `ePayco.checkout.configure({sessionId, type: 'standard', test: cfg.sandbox}).open()`
   client-side. There is no step that hands back a plain URL the storefront can
   redirect to directly the way Wompi's/Mercado Pago's checkouts do — `.open()` is
   what actually triggers ePayco's hosted, PCI-DSS-certified `type: 'standard'` redirect
   (confirmed: `standard` mode is the one that satisfies this codebase's "no card data
   ever touches Ventia" constraint; `onpage` mode embeds the widget on the merchant's
   own domain and is NOT used here). **Resolution, so `EpaycoProvider.createCheckoutSession`
   can still satisfy the shared `Promise<{redirectUrl: string}>` contract unchanged for
   all three providers**: `createCheckoutSession` does steps (a)+(b) server-side as
   normal, then returns `redirectUrl: '{STOREFRONT_URL}/pago/epayco?session={sessionId}&sandbox={cfg.sandbox}'`
   — a new, thin, storefront-owned page (this phase's Task 6) that does nothing but
   load `checkout-v2.js` and immediately call `.configure(...).open()` with the given
   `sessionId`/`test` flag on mount. The browser is redirected to THIS page (a normal
   same-origin storefront route, same shape as this codebase's existing thin
   intermediary routes like `/api/cart`'s proxy), which then itself drives the actual
   ePayco widget/redirect. This keeps `PaymentProvider`'s interface identical across
   all three adapters (no ePayco-specific carve-out leaking into `checkout.service.ts`
   or the interface itself) at the cost of one small new storefront page — a
   reasonable, explicitly-justified trade-off given ePayco really doesn't offer a pure
   URL-based flow, not a design smell. **Open question, explicitly left for the
   implementation task to verify directly (not guessed here)**: whether
   `ePayco.checkout.configure(...)` accepts a post-payment return/redirect URL
   parameter (Wompi's redirect and Mercado Pago's `back_urls` both have this built in;
   the research for this design could not confirm ePayco's real widget-config option
   for it) — the implementation task must fetch ePayco's actual `checkout-v2.js`
   configuration docs and confirm the real parameter name before wiring the storefront
   back to the order-confirmation page, rather than assume one.

7. **ePayco credentials and confirmation-signature verification — a different shape
   than Wompi's two-secret model.** `publicKey`/`privateKey` map to ePayco's real
   `PUBLIC_KEY`/`PRIVATE_KEY` (used only for the login/session-create calls above).
   The confirmation POST's signature (`x_signature`) uses a SEPARATE pair —
   `P_CUST_ID_CLIENTE` and `P_KEY` — found in the ePayco dashboard's own "Secret Keys"
   section, structurally unrelated to `PUBLIC_KEY`/`PRIVATE_KEY`. Per decision 3:
   `P_KEY` → `cfg.eventsSecret`, `P_CUST_ID_CLIENTE` → the new `cfg.epaycoCustomerId`
   field. Confirmed verbatim on
   [url-de-confirmacion](https://docs.epayco.com/docs/url-de-confirmacion): the exact
   formula is `SHA256(P_CUST_ID_CLIENTE + '^' + P_KEY + '^' + x_ref_payco + '^' + x_transaction_id + '^' + x_amount + '^' + x_currency_code)`,
   `^`-joined, compared against the posted `x_signature`. Reference/idempotency:
   `x_extra1`–`x_extra10` are documented, genuine pass-through custom fields —
   `x_extra1` carries `order.orderNumber` out and back, same role as Wompi's
   `transaction.reference`/MP's `external_reference`; `x_ref_payco` + `x_transaction_id`
   are usable for `providerRef`/`WebhookEvent`'s idempotency key. Status vocabulary
   (`x_response`: `Aceptada`/`Rechazada`/`Pendiente`/`Fallida`, confirmed verbatim on
   the official page) maps `Aceptada → PAID`, `Pendiente → PENDING`,
   `Rechazada`/`Fallida → FAILED` (both real-world "didn't result in payment" outcomes,
   collapsed the same way Wompi's `DECLINED`/`ERROR` already are). Sandbox: a plain
   `test: true/false` boolean passed at widget-configure time (decision 6), not a
   separate base URL or key prefix — confirmed on the same implementación page.
   **Lower confidence, flag for implementation-time verification**: (a) the numeric
   `x_cod_response` code-to-label mapping (only found via a community GitHub sample,
   not an official page — the STRING values `x_response` itself carries ARE
   officially confirmed, so parse on the string, not a numeric code, unless the
   implementation task finds a real official page confirming the numeric mapping);
   (b) `getTransactionStatus`'s real REST endpoint — search results point at
   `GET https://secure.epayco.co/validation/v1/reference/{reference_id}` from a
   community-maintained SDK repo, not an official docs.epayco.com page; fetching it
   during this design's research returned only a generic error body, not a documented
   schema. This is the single least-verified fact in this whole design — the
   implementation task must confirm the real endpoint/auth/response shape against
   ePayco's actual docs (or a real sandbox account, if the SPEC's "read the docs, don't
   guess" instruction still can't fully resolve it) before shipping `getTransactionStatus`
   for ePayco, following the exact caution Wompi Task 2 itself modeled for its own
   lowest-confidence detail.

## Architecture

### 0. Schema changes

None. No new tables, no new columns — `Tenant.settings.payments.providers.<provider>`
(P3a's existing JSON namespace) already accommodates arbitrary provider keys; this
phase just adds `mercadopago`/`epayco` alongside the existing `wompi` key. The only
interface-level (not schema-level) change is `TenantProviderConfig` gaining
`epaycoCustomerId?: string` (decision 3).

### 1. `packages/payments` — two new adapters

- `packages/payments/src/mercadopago.ts`: `MercadoPagoProvider implements PaymentProvider`
  (decisions 4/5). `createCheckoutSession` is a real `fetch` call (injectable
  `fetchImpl` parameter, matching `WompiProvider.getTransactionStatus`'s existing
  testability convention). `verifyAndParseWebhook` needs BOTH `req.headers` (for
  `x-signature`/`x-request-id` — the first adapter to actually read headers, not just
  `rawBody`) and a follow-up `fetch` call (also `fetchImpl`-injectable). `getTransactionStatus`
  is a clean 1:1 `GET /v1/payments/:id` call.
- `packages/payments/src/epayco.ts`: `EpaycoProvider implements PaymentProvider`
  (decisions 6/7). `createCheckoutSession` makes two real `fetch` calls (login,
  session/create) and returns the storefront's own `/pago/epayco` URL, NOT an
  epayco.co URL. `verifyAndParseWebhook` is a pure computation (no network call) once
  the confirmation POST's fields are in hand — reads `req.rawBody`, recomputes the
  SHA-256 signature, compares. `getTransactionStatus` — implement against whatever the
  implementation task's own doc verification confirms (decision 7's flagged open
  item); if genuinely no reliable documented endpoint exists, this is the one place a
  narrower implementation (e.g., relying solely on the confirmation webhook rather than
  a polling-capable status endpoint) may be the honest outcome — say so explicitly in
  the shipped code's doc comment rather than fabricating a call against an unverified
  endpoint.
- `packages/payments/src/index.ts`: add `epaycoCustomerId?: string` to
  `TenantProviderConfig` (decision 3), export `MercadoPagoProvider`/`EpaycoProvider`
  alongside the existing `WompiProvider` export.

### 2. `services/api/src/payments/` — no new files, only registry + service extension

- `provider-registry.ts`: `PROVIDERS` gains `mercadopago: new MercadoPagoProvider()`,
  `epayco: new EpaycoProvider()`. `getProvider`/`PAYMENT_PROVIDER_NOT_CONFIGURED`
  unchanged — already generic.
- `payments.service.ts`: `getTenantProviderConfig`/`saveProviderCredentials` already
  read/write through a generic `provider: PaymentProviderId` parameter and a
  `providers[provider]` JSON lookup — check whether `StoredWompiCredentials`
  (currently Wompi-specifically-named) needs to become a shared, more generic stored
  shape (it likely already structurally fits `mercadopago`/`epayco` too, modulo the new
  `epaycoCustomerId` field needing its own encrypted-storage slot analogous to
  `integritySecretEncrypted`/`eventsSecretEncrypted`) — confirm and rename/generalize
  during implementation rather than leaving a misleadingly Wompi-specific name once
  it's genuinely shared by three providers.
- `webhooks.controller.ts`: **no changes anticipated** — it already dispatches purely
  on the `:provider` URL segment via `PROVIDERS[providerParam]`, with zero
  Wompi-specific logic in the controller itself. If implementation reveals a genuine
  need for a provider-specific branch here, that's a signal the abstraction leaked and
  worth flagging to a reviewer, not silently working around.
- `stock-reservation.worker.ts`: **no changes anticipated** — it already sweeps
  `Order.stockReservedUntil` generically, with no provider-specific logic.

### 3. Checkout wiring (`services/api/src/checkout/checkout.service.ts`,
`checkout.controller.ts` — generalized, not rewritten; see decision 2)

- `CheckoutInput.paymentMethod` widens to `'cod' | PaymentProviderId` (reusing
  `@ventia/payments`'s existing union rather than hand-rolling a parallel one).
- Every `=== 'wompi'` conditional becomes `!== 'cod'`; the one hardcoded
  `getProvider('wompi')` call becomes `getProvider(input.paymentMethod)` (now
  correctly typed, since `paymentMethod` here is statically known to be a
  `PaymentProviderId` in that branch).
- `checkout.controller.ts`'s body-validation (`parseCheckoutBody` or equivalent)
  widens whatever allow-list it currently hardcodes for `paymentMethod` to include
  `'mercadopago'`/`'epayco'`.
- The `cod` branch itself: zero changes, and the full existing `cod`+`wompi` test
  suite must remain byte-for-byte green — this generalization's whole point is that
  it changes NOTHING about either already-shipped path's behavior.

### 4. Admin UI (`apps/admin/components/pagos-tab.tsx` — extend, following its
existing per-gateway-section pattern)

- `PagosTab` currently renders `<CodSection>` + `<WompiSection>`. Add
  `<MercadoPagoSection>` + `<EpaycoSection>` alongside, same component shape
  (public/private key masked inputs, sandbox toggle, "Probar conexión" button) —
  `EpaycoSection` additionally needs an `epaycoCustomerId` field (decision 3) and,
  per its docs' actual field naming (`P_CUST_ID_CLIENTE`/`P_KEY`), copy that's
  clear this is a SEPARATE secret pair from the public/private key above, not a
  restatement of it — a real source of merchant confusion this UI must actively guard
  against (unlike Wompi's `integritySecret`/`eventsSecret`, which are visually and
  conceptually adjacent to the login keys; ePayco's confirmation-signature secret pair
  is dashboard-located in an entirely different section from its API keys, per its
  own docs).
- `PATCH /v1/admin/settings/payments`'s `providers` object widens to accept optional
  `mercadopago`/`epayco` keys (new `mercadopagoCredentialsSchema`/
  `epaycoCredentialsSchema` in `@ventia/core`'s `settings-schemas.ts`, mirroring
  `wompiCredentialsSchema`'s shape+optionality conventions), each independently
  mergeable (same merge-in-place posture as `wompi`'s addition in P3a).

### 5. Storefront (`apps/storefront/app/pago/epayco/page.tsx` — new; `apps/storefront/app/checkout/page.tsx` — extend)

- New thin route: loads `checkout-v2.js`, calls `.configure({sessionId, type:
  'standard', test}).open()` on mount, reading `sessionId`/`sandbox` from its own
  query string (set by `EpaycoProvider.createCheckoutSession`, decision 6). No cart/
  checkout state of its own — purely a bridge page.
- Checkout page's existing payment-method choice (`cod`/`wompi` radio/select, built in
  P3a) widens to include `mercadopago`/`epayco` options, same submit-and-redirect
  pattern already established for `wompi`.

## Task sequence, at a glance (full detail in the implementation plan)

Mirrors P3a's Task 2/5/7 split, doubled for two providers, plus the one shared
generalization task and one combined wrap-up:

1. Generalize `checkout.service.ts`/`.controller.ts`'s wompi-specific branches to any
   `PaymentProviderId` (decision 2) — mechanical, zero behavior change, full suite
   green as proof.
2. `MercadoPagoProvider` adapter (decisions 4/5) + its unit tests.
3. `EpaycoProvider` adapter (decisions 6/7) + its unit tests.
4. Wire both into the provider registry + `payments.service.ts`'s credential storage
   (generalizing `StoredWompiCredentials` if warranted) + `TenantProviderConfig`'s new
   field + `@ventia/core` schema additions.
5. Admin credentials UI: `MercadoPagoSection` + `EpaycoSection`.
6. Storefront: checkout page's payment-method widening + the new `/pago/epayco`
   bridge page + Mercado Pago's `back_urls`/order-confirmation-return wiring.
7. Wrap-up: full gate, manual/sandbox smoke test for both gateways (same posture as
   P3a Task 9 — if no real sandbox account is available in this environment, exercise
   the real encryption/signature-verification code paths with well-formed fake
   credentials and say so explicitly, not silently skip verification), docs, README
   phase-status update (P3b done, P3c remains).

## Out of scope for P3b (explicitly deferred)

- The 30-minute payment-status reconciliation job (P3c) — unchanged from P3a's own
  scoping; still a separate concern (catching a webhook that never arrived) from
  anything P3b builds.
- Refunds for any of the three gateways (`PaymentProvider.refund?` stays unimplemented
  for `mercadopago`/`epayco` too, same reasoning as Wompi's — spec marks this
  "Phase 2").
- A "waiting for payment" storefront UI state beyond what P3a already built (the
  order-confirmation page showing current order state) — Mercado Pago's `back_urls`/
  ePayco's bridge page both still land the shopper back on that same existing page.
- Any change to `WebhookEvent`'s schema, the stock-reservation worker, or the
  advisory-lock transition machinery — all confirmed provider-agnostic already and
  expected to need zero changes (flag to a reviewer if implementation reveals
  otherwise).
- DIAN/billing-fields (deferred since P2b, unrelated to this phase).
