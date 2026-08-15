# P3c — Payment-Status Reconciliation Job: Design

**Date:** 2026-07-30
**Source spec:** `docs/SPEC.md` §11 P3 — Online Payments + Order lifecycle; `docs/SPEC.md`
line 150 ("Reconciliation: BullMQ repeatable job — orders `PENDING` with a checkout
session older than 30 min → poll `getTransactionStatus` → settle or expire.")
**Status:** Approved
**Builds on:** P3a (payment infrastructure + Wompi, merged), P3b (Mercado Pago + ePayco,
merged) — both explicitly deferred this job; P3a's own design doc: "The 30-minute
reconciliation job (P3c) — P3a's expiry job only handles the 15-minute stock-reservation
TTL, a different concern (releasing stock) from reconciliation (catching a webhook that
never arrived at all for an order that's actually been paid)."

## Goal

A merchant's online-payment order is never permanently stuck at `PENDING`/`PENDING` just
because a webhook got lost (tenant's endpoint briefly down, gateway retry budget
exhausted, network blip). A new BullMQ repeatable job periodically re-checks orders
whose webhook should have arrived by now, using each gateway's own authenticated status
API — the same `getTransactionStatus` every adapter already implements — and settles
them (`markPaid`/`markFailed`, both already built and already reviewed) the moment it
can confirm the real status, without waiting for (or ever needing) a webhook retry.

## Fresh research done for this phase (read before touching any adapter)

Before designing the job itself, I re-verified each gateway's own official docs
(WebFetch, not memory) for whether a payment/transaction can be looked up by OUR OWN
reference (order number) rather than the gateway's own transaction id — since
`getTransactionStatus(providerRef, cfg)` needs a `providerRef`, and today **no code
anywhere persists one onto a queryable column** (only inside an `OrderEvent`'s JSON
blob, written by `markPaid`/`markFailed` themselves — useless for finding a
providerRef for an order that has NEVER had ANY webhook processed for it, which is
exactly the case reconciliation exists to handle).

- **Mercado Pago: yes.** `GET /v1/payments/search?external_reference={ourReference}`
  is a real, official, documented endpoint (confirmed against two live
  `mercadopago.com.co/developers` reference pages today) — same
  `Authorization: Bearer {access_token}` as the existing by-id call, returns a
  paginated `results` array (handles the shopper-retries-checkout case, where more
  than one payment attempt shares one `external_reference`). Caveat: search only
  covers the last 12 months and recommends a `range`/date-window param; no documented
  indexing lag was stated, but it's a search index, not the strongly-consistent by-id
  read — don't assume sub-second freshness.
- **Wompi: no.** Checked three official `docs.wompi.co` pages directly
  (transacciones, widget-checkout-web, seguimiento-de-transacciones) — `GET
  /v1/transactions/{id}` (by Wompi's own id only) is the only status-lookup endpoint
  documented. No list/search-by-reference endpoint exists. Wompi's Web Checkout DOES
  support an optional `redirect-url` param (confirmed on the widget-checkout-web page)
  that appends `?id={transactionId}` when the shopper's browser returns — but Wompi's
  own docs explicitly warn: **"Do not use the redirection as a validation method of
  your transactions, only for informative purposes for your users."** This app's
  `WompiProvider.createCheckoutSession` doesn't set `redirect-url` at all today, so
  there is currently no return path for Wompi whatsoever (unlike ePayco, which already
  has a bridge page).
- **ePayco: no.** Checked Apify's docs, the API index, and both dashboard-adjacent
  "Registros"/"Listas" pages — the only lookup-by-reference-shaped endpoint anywhere in
  official docs is `GET /validation/v1/reference/{ref_payco}`, keyed by ePayco's OWN
  id, not ours. No search-by-merchant-reference capability exists, official or
  third-party.

**Guiding principle this converges on, and it's already this project's own stated
policy** (`docs/SPEC.md` line 84: *"Payment status truth: webhooks are the source of
truth, never the client redirect."*): a redirect-return id (Wompi's `?id=`; ePayco's
`onResponse` hook payload was investigated and resolved to carry nothing usable — see
decision 2's third bullet) is usable **only as a
hint telling us WHAT to look up**, via each gateway's own authenticated,
server-verified API — never as proof of payment by itself. This is not a new rule
invented for this phase; it's the existing spec principle applied to a new capture
point.

## Decisions made during brainstorming

1. **`Order.providerRef String?` — new nullable column, not the existing (100% unused)
   `Payment` table.** Grepped the whole `services/api/src` tree: no code anywhere
   creates, reads, or updates a `Payment` row — that model has been dead schema since
   P0. Wiring up an entire second table for one nullable string this phase needs is
   scope creep; a column directly on `Order` matches the existing pattern
   (`paymentProvider`, `stockReservedUntil` already live there, not in a side table).
   Reviving `Payment` is out of scope for this phase — noted as a pre-existing gap,
   not something P3c is responsible for fixing.

2. **`providerRef` is written from THREE sources, all best-effort, none authoritative
   on its own:**
   - `markPaid`/`markFailed` (`payments.service.ts`) already receive `providerRef` as
     a parameter (from a real, signature-verified webhook) — they already write it
     into an `OrderEvent`'s JSON `data`; this phase ALSO stamps it onto
     `Order.providerRef` in the same transaction, purely so a LATER webhook retry or
     reconciliation pass for the SAME order (e.g. a `FAILED` attempt followed by a
     shopper retry that later succeeds) has a fresher value to start from. This is
     the lowest-risk source: it only ever runs after a real signature check already
     passed.
   - **Wompi: add `redirect-url` to `createCheckoutSession`**, pointing at a NEW,
     small storefront route (mirrors ePayco's existing bridge-page pattern, which
     Wompi currently has no equivalent of at all) that reads Wompi's `?id=` param,
     `PATCH`es a new, narrow API endpoint that stores it onto `Order.providerRef`
     **without touching `paymentStatus`/`status` at all**, then redirects on to the
     existing `/checkout/confirmacion/:orderNumber` page exactly as before. Per
     Wompi's own explicit warning (see research above), this value is NEVER trusted
     as proof of anything — it only gives the reconciliation job something to feed
     into the ALREADY-authenticated `getTransactionStatus` call.
   - **ePayco: RESOLVED AS UNAVAILABLE — this capture source does not exist.** The
     original plan here was to forward `x_ref_payco` out of the bridge page's existing
     `setHooks({onResponse})` callback (wired in P3b's Task 6, used only to trigger
     navigation), conditional on the payload actually carrying it. **Task 3 resolved
     that condition as NO, on both counts, and implemented nothing.** Evidence — the
     actual shipped `https://checkout.epayco.co/checkout-v2.js` (421,029 bytes,
     downloaded and read during Task 3; minified but with control flow and string
     literals intact), which outranks the docs as a source:
     - **The hooks cannot fire in `type: "standard"`, the mode this app uses**
       (design decision 6 mandates `standard`). Verbatim from the script:
       `handleStandardFlow(e){this.redirectToCheckout(e)}` and
       `redirectToCheckout(e){...;window.location.href=e}` — `open()` is a full-page
       navigation to `https://new-checkout.epayco.co/checkout-standard/{sessionId}`,
       which unloads the bridge page and every closure registered on it. This
       independently corroborates docs.epayco.com/docs/checkout-implementacion's own
       verbatim statement that "estos hooks están disponibles para los tipos de
       implementación `onpage`" — the restriction is structural, not arbitrary.
       *Confidence: HIGH.*
     - **On the `sessionId` path this app uses, `onResponse` is never invoked at
       all**: `renderWithSessionId(...)`'s full body contains no `this.onResponse(...)`
       call on any branch. *Confidence: HIGH.*
     - **Where `onResponse` IS invoked (the legacy inline-`createTransaction` flow,
       not used here), its argument is the transaction-CREATE response object — the
       same object passed to `onCreated` — fired immediately after render and BEFORE
       the shopper pays.** It structurally cannot carry a payment reference. Note this
       contradicts the docs' own prose ("se dispara cuando el pago ha sido
       procesado... recibe... el resultado de la transacción"); the shipped code is
       the authority. *Confidence: HIGH.*
     - **`ref_payco`/`x_ref_payco` appear 0 times in the entire 421 KB script.**
       *Confidence: HIGH (mechanical).* The only payload the script does not itself
       author is `component` mode's iframe `postMessage` passthrough
       (`e.data.response`) — shape UNKNOWN/unverifiable without a sandbox, and
       irrelevant, since this app uses `standard`, not `component`.
     - **ePayco publishes no first-party sample of these hooks**: a code search of
       ePayco's own official sample repo `github.com/epayco/resources` for
       `setHooks`/`onResponse` returns zero hits.

     **The design still holds, exactly as this bullet originally anticipated it might
     have to** — ePayco simply falls back to case 3 below. See the "disclosed
     limitation" note under decision 3, and the FUTURE AVENUE assessment after it.

3. **No reference-search fallback for Wompi/ePayco — by design, not an oversight.**
   For an order where NONE of the three capture points above ever produced a
   `providerRef` (webhook truly never arrived AND the shopper's browser never
   completed the redirect/hook round trip either), Wompi and ePayco orders are simply
   **not reconcilable via any API call** — confirmed by this phase's own research,
   not assumed. These orders fall through to the EXISTING P3a stock-reservation
   TTL-expiry worker exactly as they do today (this phase changes nothing about that
   worker or its 15-minute timeout) — a real, disclosed limitation, not silently
   glossed over. Mercado Pago orders in this same "no providerRef at all" state DO get
   one more chance via `searchByReference` (decision 5).

   **ePayco is strictly worse off than Wompi here, and this is the phase's single
   biggest disclosed limitation.** After decision 2's third bullet resolved negative,
   ePayco has only ONE `providerRef` source at all — `markPaid`/`markFailed` stamping
   it from a real, signature-verified confirmation webhook. **ePayco has no
   redirect-return fallback whatsoever**, where Wompi has one (`redirect-url` +
   `?id=`) and Mercado Pago has both a webhook and `searchByReference`. Concretely:
   if an ePayco order's confirmation webhook never arrives, that order will NEVER
   acquire a `providerRef`, so reconciliation can never look it up, and it will always
   fall through to the 15-minute stock-reservation expiry worker. For ePayco,
   reconciliation therefore only ever helps in the narrower "a webhook arrived once
   (e.g. a `FAILED` attempt) and a later one was lost" case — not the "no webhook ever
   arrived" case reconciliation primarily exists for. This is a real gap in coverage
   for one of three providers, and it should be stated plainly wherever this phase's
   coverage is summarized (README, spec DoD), not left implicit.

   **FUTURE AVENUE (assessed by Task 3, deliberately NOT implemented): ePayco's
   response-page redirect.** ePayco's session-create request accepts a `response`
   field (the shopper's post-payment browser return URL), which
   `packages/payments/src/epayco.ts` deliberately omits today — read that module's doc
   comment for the full reasoning. Task 3 assessed whether it would carry the
   reference the hooks don't, and the answer looks like **yes**:
   - ePayco's OWN first-party sample repo `github.com/epayco/resources` reads the
     reference off the response page's QUERY STRING in two independent samples:
     `onePage/response/response.html` does `var ref_payco = getQueryParam('ref_payco');`
     then `var urlapp = "https://secure.epayco.co/validation/v1/reference/" + ref_payco;`,
     and `epayco-ng6/src/app/components/response/response.component.ts` does
     `this.refPayco = params['ref_payco'] || params['x_ref_payco'];` then
     `this.epaycoService.getTransactionResponse(this.refPayco)`. Both feed EXACTLY the
     endpoint `EpaycoProvider.getTransactionStatus` already calls. *Confidence: HIGH
     that a `ref_payco` (or `x_ref_payco`) query param is appended to the merchant's
     configured response URL.*
   - *Confidence: MEDIUM-HIGH, not certain,* that setting the session-create
     `response` field specifically (rather than the account-wide dashboard "URL
     Respuesta y Confirmación" panel) is what those samples' URLs were configured by —
     neither sample states which mechanism registered the URL it is running on.
   - **RESOLVED AFTER P3c — this blocker is gone and `response` is now wired.** The
     per-tenant URL was threaded through as `OrderForPayment.storefrontBaseUrl`
     (populated in `checkout.service.ts` from the request's own resolved
     `TenantDomain` row), `PAYMENTS_STOREFRONT_BASE_URL` was deleted, and `epayco.ts`
     sets `response` to that tenant's `/pago/epayco-retorno/{orderNumber}` route. The
     MEDIUM-HIGH confidence note above still stands: no sandbox account was available
     to confirm the session-create field is what registers the URL, versus the
     dashboard panel. **The reconciliation half of this idea did NOT land and must not
     be assumed:** a response-page ref is `hint`-sourced and the provenance gate still
     refuses it for ePayco. The paragraph below is kept verbatim as the historical
     record of why it was deferred.
   - **Blocker, and the reason this stays unimplemented:** it needs a real, public,
     PER-TENANT storefront URL. `PAYMENTS_STOREFRONT_BASE_URL` only approximates one
     (a single global base for every tenant — see `packages/payments/src/storefront-base.ts`'s
     own load-bearing-limitation warning). Wiring `response` to a wrong-tenant domain
     would send shoppers to another merchant's storefront, which is worse than having
     no return page. Doing this properly requires threading the per-request tenant
     domain (`services/api/src/tenants/domain-resolver.ts`) into
     `createCheckoutSession` — out of scope for P3c.
   - Worth noting it would fix a UX gap too, not just reconciliation: in `standard`
     mode the shopper finishes payment on `new-checkout.epayco.co` and currently has
     no automatic way back to the storefront at all.

4. **Reconciliation threshold is SHORTER than the existing 15-minute stock-reservation
   TTL, not the spec's literal 30 minutes — a deliberate, documented deviation.**
   Traced the alternative (reconciling strictly after 30 min, as the spec's rough
   pre-P3a wording says) and found a real ordering bug: by 30 minutes, the EXISTING
   P3a expiry worker (unchanged, already shipped, already reviewed) would have
   already fired at the 15-minute mark — restocked the product, cancelled the order,
   set `paymentStatus: EXPIRED`. A reconciliation pass arriving 15 minutes AFTER that
   would either find nothing (if its query is `status = 'PENDING'`, which no longer
   matches a cancelled order) or, if widened to also catch already-expired orders,
   would need to UN-cancel an order and RE-decrement stock that may have already been
   sold to someone else in the meantime — a genuinely higher-risk "undo" operation
   this phase deliberately avoids building. Instead: reconciliation runs on its own
   BullMQ repeatable job (a distinct concern from stock release, per P3a's own design
   doc), targeting orders `paymentStatus = 'PENDING' AND paymentProvider IS NOT NULL
   (i.e. not cod) AND stockReservedUntil IS NOT NULL AND createdAt < now() - 5min`
   — comfortably before the 15-minute stock release, so it always gets multiple
   chances (job runs every 2 minutes) to resolve a real payment BEFORE the existing
   worker would ever consider expiring it. If reconciliation successfully calls
   `markPaid`, it clears `stockReservedUntil` as part of that existing transaction —
   so the OTHER worker's own query (`stockReservedUntil < now()`) simply no longer
   matches that order on its next run. No race, no "undo," no new locking needed:
   `markPaid`/`markFailed`'s existing per-order advisory lock + strict
   `status==='PENDING' && paymentStatus==='PENDING'` precondition (already reviewed
   twice in P3a/P3b) is reused completely unchanged.

5. **Mercado Pago gets one extra capability: `searchByReference` — a NEW OPTIONAL
   method on `PaymentProvider`, not a change to the shared interface's REQUIRED
   surface.** `searchByReference?(reference: string, cfg: TenantProviderConfig):
   Promise<{providerRef: string; status: NormalizedStatus} | null>` — implemented
   only by `MercadoPagoProvider` (calls the real `/v1/payments/search` endpoint,
   picks the most relevant result if multiple attempts share one reference — most
   recent `APPROVED` payment if any, else the most recent attempt of any status),
   left undefined for Wompi/ePayco (matching how `refund?` is already optional and
   only sometimes implemented). The reconciliation job calls this ONLY when
   `provider === 'mercadopago' && !order.providerRef` — for every other case
   (providerRef already known, or provider is wompi/epayco with none) it goes
   straight to `getTransactionStatus`.

6. **A `getTransactionStatus`/`searchByReference` call that itself throws (network
   error, gateway downtime, malformed response) is a fail-safe no-op for that order
   THIS run, not a settle-or-expire decision.** Logged, tried again next run. This
   matters because the alternative (treating an unreachable-gateway error as "must be
   FAILED, expire it") would restock a product for an order that may have genuinely
   been paid, purely because OUR reconciliation call itself had a transient failure —
   a strictly worse outcome than just waiting for the next 2-minute run.

7. **This job never independently expires/restocks anything.** It only ever calls the
   EXISTING `markPaid`/`markFailed` when a gateway's own authenticated response
   resolves the order to `PAID`/`FAILED`/`EXPIRED`. An order the job can't resolve
   (still genuinely `PENDING` per the gateway, or unreconcilable at all) is left
   completely alone — the existing, unmodified P3a stock-reservation-expiry worker
   remains the ONLY thing that ever cancels/restocks an abandoned reservation. This
   keeps the blast radius of this phase to "one new job that can only ever move an
   order toward a state a real webhook would have produced anyway," not "a second
   place that can cancel orders."

## Architecture

### 0. Schema change (one migration)

- `Order.providerRef String?` (new, nullable, no default) — decision 1/2.

### 1. `packages/payments`: `PaymentProvider.searchByReference?` (optional interface
addition) + `MercadoPagoProvider` implementation (decision 5). `WompiProvider`/
`EpaycoProvider` unchanged (the method stays undefined for both, exactly like
`refund?`).

### 2. `services/api/src/payments/payments.service.ts`: `markPaid`/`markFailed` also
write `providerRef` onto `Order` (decision 2, first bullet) — a one-line addition to
each method's existing `tx.order.update` call, no new transaction/locking logic.

### 3. `services/api/src/payments/reconciliation.worker.ts` (new) — a BullMQ
repeatable job mirroring `stock-reservation.worker.ts`'s existing registration shape
in `payments.module.ts` (same queue/connection setup, a sibling repeatable job, not a
new BullMQ wiring pattern). Every 2 minutes, across all tenants: find orders matching
decision 4's query; for each, resolve a status per decisions 2/3/5/6 above and call
`markPaid`/`markFailed` when resolved.

### 4. Wompi return-capture (decision 2, second bullet):
- `packages/payments/src/wompi.ts`: add `redirect-url` to `createCheckoutSession`'s
  built params, pointing at a new storefront route.
- `apps/storefront/app/pago/wompi-retorno/page.tsx` (or similar — implementer's call
  on the exact path) — reads `?id=` and `?orderNumber=` (this app will need to pass
  its OWN order number through as a query param on the `redirect-url` it hands to
  Wompi, the same way `EpaycoProvider`'s `redirectUrl` already carries `orderNumber`
  today — check `epayco.ts`'s existing pattern before inventing a new one), calls a
  new, narrow API endpoint to store the hint, then redirects to
  `/checkout/confirmacion/:orderNumber` exactly like the ePayco bridge page does.
- `services/api/src/checkout/checkout.controller.ts` (or a new small controller): a
  new `PATCH /v1/storefront/checkout/:orderNumber/provider-ref-hint`-shaped endpoint
  (exact path/verb is the implementer's call, matching existing route-naming
  conventions in that controller) that ONLY writes `Order.providerRef` — no
  `paymentStatus`/`status` touch, no auth beyond the existing `PublicTenantGuard` (this
  is genuinely public, unauthenticated info the shopper's own browser is reporting —
  same trust level as any other client-supplied value this app already treats as a
  hint, not a fact).

### 5. ePayco return-capture: **NOT BUILT — resolved as impossible, see decision 2's
third bullet.** The plan was to extend the existing `setHooks` wiring in
`apps/storefront/app/pago/epayco/page.tsx` to forward `x_ref_payco` to the same
provider-ref-hint endpoint as Wompi. Task 3's research against the actual shipped
`checkout-v2.js` established that (a) the hooks cannot fire at all in the `standard`
mode this app uses (`open()` is a `window.location.href` full-page redirect), (b)
`onResponse` is never invoked on the `sessionId` code path regardless, and (c) its
payload is the pre-payment transaction-CREATE object and carries no transaction
reference on any path. **No code was written.** The hint endpoint from §4 therefore
has exactly ONE caller (the Wompi return page), not two. `apps/storefront/app/pago/epayco/page.tsx`'s
module doc comment carries the full finding with per-claim confidence levels.

## Out of scope for P3c (explicitly deferred)

- Reviving the `Payment` table (decision 1) — a pre-existing gap, not this phase's
  job to fix.
- Any UI surfacing "this order was reconciled automatically" to the merchant — the
  existing order-events timeline already records `payment_confirmed`/whatever event
  type `markPaid`/`markFailed` already write; no new admin-facing distinction between
  "webhook-confirmed" and "reconciliation-confirmed" is required by the spec's DoD.
- Refunds (still explicitly Phase-2-marked in the spec, same as every prior phase).
- Any change to the existing P3a stock-reservation-expiry worker's own logic/timeout —
  decision 4 deliberately keeps it completely untouched to avoid regressing
  already-reviewed code.
