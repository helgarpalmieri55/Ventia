import { createHash, timingSafeEqual } from 'node:crypto';
import type {
  NormalizedPaymentEvent,
  NormalizedStatus,
  OrderForPayment,
  PaymentProvider,
  RawRequest,
  TenantProviderConfig,
  TransactionStatusResult,
} from './index.js';
import { requireStorefrontBaseUrl } from './storefront-base.js';
import { fetchGateway } from './http.js';
import { WebhookVerificationUnavailableError } from './errors.js';

// --- Facts below are this task's own re-verification against real
// docs.epayco.com pages (fetched directly during this task) and, where the
// official docs stopped short, the best community sources found. Every
// point is labeled verified / corrected-from-design-doc / genuinely
// unresolved, same convention as wompi.ts/mercadopago.ts. Full URLs fetched:
// docs.epayco.com/docs/checkout-implementacion,
// docs.epayco.com/docs/url-de-confirmacion,
// docs.epayco.com/docs/checkout-respuesta-y-confirmacion, plus web searches
// for the two facts the design doc flagged as lowest-confidence.
//
//  - Login (`POST https://apify.epayco.co/login`, HTTP Basic
//    `base64(publicKey:privateKey)`, no request body): response is
//    `{ "token": "<jwt>" }` — a top-level `token` field. VERIFIED directly
//    against a real example response shown on checkout-implementacion (the
//    design doc's "likely `token`, verify" guess was correct).
//  - Session create (`POST https://apify.epayco.co/payment/session/create`,
//    `Authorization: Bearer <jwt>`): response is
//    `{ success, ..., data: { sessionId, token } }` — `sessionId` is nested
//    under `data`, NOT top-level. VERIFIED directly against a real example
//    response on the same page — this is a genuine correction: neither the
//    design doc nor the plan's condensed step list specified the nesting.
//  - `amount` on the session-create request is a MAJOR-unit decimal (COP
//    pesos), not cents — VERIFIED independently for ePayco (not assumed from
//    Mercado Pago): the real example body shows `"amount": 20000.00` /
//    `"amount": 200000` for what are clearly whole-peso amounts, and
//    `taxBase`/`tax` sub-fields in the same example are also peso-scale
//    decimals, consistent with a pesos convention throughout this endpoint.
//  - **Reference/idempotency contract, corrected from the plan's condensed
//    wording**: the plan said to send "an order name/description" without
//    mentioning how `order.orderNumber` reaches the webhook's `x_extra1`.
//    The real session-create request body (full example fetched directly)
//    nests custom pass-through fields under an `extras` object with keys
//    `extra1`..`extra11` (i.e. `extras.extra1`), NOT `x_extra1` — `x_extra1`
//    is ePayco's naming for the SAME field on the *confirmation webhook's*
//    side only (confirmed on url-de-confirmacion, design doc decision 7).
//    This adapter sets `extras.extra1 = order.orderNumber` here specifically
//    so `verifyAndParseWebhook` below can read it back as `x_extra1` — same
//    slot, different name on each side of the same real API, verified by
//    reading both the request-body example and the webhook-fields docs
//    directly rather than assuming symmetric naming.
//  - `country: 'CO'` is included in the session-create body: present in
//    every real example fetched, but this task could not confirm it's
//    strictly *required* (no explicit "required fields" list was found) —
//    included defensively since this adapter is Colombia-only anyway
//    (mirrors `wompi.ts`'s/`mercadopago.ts`'s own hardcoded `CHECKOUT_CURRENCY`
//    reasoning), not because its necessity is verified.
//  - **`response` is now POPULATED; `confirmation` is still deliberately
//    omitted.** Both are REAL, confirmed fields on this same session-create
//    request body (both appear in the real example fetched above, and the
//    example was re-fetched from docs.epayco.com/docs/checkout-implementacion
//    during the multi-tenancy fix — it still shows `"response":
//    "https://mysite.com"` and `"confirmation": "https://webhook.site/..."`,
//    with `response` documented as the browser redirect URL the shopper
//    returns to and `confirmation` as the server-to-server webhook).
//
//    Both were previously omitted for ONE shared reason: each needs a real,
//    tenant-specific PUBLIC URL, and `createCheckoutSession`'s inputs carried
//    no tenant id or domain at all. That blocker is gone —
//    `OrderForPayment.storefrontBaseUrl` now carries the per-tenant public
//    base URL, resolved per HTTP request in `checkout.service.ts` from the
//    same `TenantDomain` row `services/api/src/tenants/domain-resolver.ts`
//    already matched (an arbitrary per-tenant `domain` string, NOT derivable
//    from `PLATFORM_ROOT_DOMAIN`, since a tenant can have a fully custom
//    domain). So `response` is set, to this tenant's own
//    `/pago/epayco-retorno/{orderNumber}` route — see `createCheckoutSession`
//    below for what that does and, importantly, what it does NOT achieve.
//
//    `confirmation` stays omitted, and that is a separate judgment, not an
//    oversight: it is the URL ePayco POSTs the SIGNATURE-VERIFIED settle
//    payload to — the one input that can actually move an order to PAID
//    (`services/api/src/payments/webhooks.controller.ts`). It is configured
//    today, out of band, in ePayco's dashboard "URL Respuesta y Confirmación"
//    panel (account-wide), which also controls which transaction states fire
//    it at all — mirroring Wompi's dashboard-configured webhook URL and
//    Mercado Pago's Integrations-Panel `notification_url`. Moving that live
//    settle path onto a per-session value nobody here can test against a real
//    sandbox account would risk silently killing webhook delivery, which is
//    strictly worse than the UX problem the `response` field fixes. If a
//    shared ePayco merchant account ever has to vary the confirmation URL per
//    storefront tenant, that is its own change, with its own verification.
//
//  - **The `method` field is deliberately NOT sent.** The same real example
//    body carries `"method": "POST"`, and ePayco's docs list it as `GET |
//    POST` while stating neither a default nor which URL it governs.
//    Community/legacy sources describe the analogous `method_confirmation`
//    as choosing the HTTP method for the CONFIRMATION webhook — i.e. this
//    field plausibly controls the verified settle path, not the response
//    redirect. Sending a guessed value could silently break webhook delivery;
//    omitting it leaves ePayco's own default in place, and every first-party
//    sample of the response page (below) reads its parameters off the QUERY
//    STRING, which is what a default browser redirect produces.
//  - **Re-verified per this task's Step 1(a) instruction**: does
//    `ePayco.checkout.configure(...)` (the CLIENT-SIDE widget call, distinct
//    from the server-side session-create call above) accept a post-payment
//    redirect URL parameter? CONFIRMED NO: the real `configure()` signature
//    only takes `{ sessionId, type: 'onpage' | 'standard', test }` — no
//    redirect/return URL parameter exists on it. The redirect URL instead
//    belongs to the session-create request's own `response` field (see
//    above), a SEPARATE, server-side mechanism from `configure()`. The
//    design doc's design decision 6 open question is answered: there is no
//    `configure()`-level redirect param, but there IS a session-create-level
//    one (`response`) — this adapter just doesn't populate it, for the
//    reasons above. The widget also exposes client-side hooks
//    (`onResponse`, `onClosed`) registered via a `setHooks` call, confirmed
//    present, for Task 6's bridge page to react to completion without
//    needing a server-configured `response` URL at all.
//  - Confirmation webhook signature formula
//    `SHA256(P_CUST_ID_CLIENTE^P_KEY^x_ref_payco^x_transaction_id^x_amount^x_currency_code)`
//    — VERIFIED verbatim against url-de-confirmacion (matches design doc
//    decision 7 exactly, re-confirmed, not re-derived, by this task).
//  - **Re-verified per this task's Step 1(b) instruction — content-type of
//    the confirmation POST**: ePayco's own official PHP sample code (from
//    `github.com/epayco/resources`, linked from ePayco's own docs) reads
//    incoming fields via PHP's `$_REQUEST` superglobal, which is how a
//    classic form POST (`application/x-www-form-urlencoded`) is read in
//    PHP — consistent with the design doc's suspicion that this is one of
//    ePayco's older form-encoded confirmation schemes, NOT JSON. No official
//    docs.epayco.com page states the exact `Content-Type` header value in
//    so many words, so this is inferred from the real sample code's read
//    pattern, not read verbatim off a page that states it outright — this
//    adapter therefore parses `rawBody` as `application/x-www-form-urlencoded`
//    primarily, with a defensive JSON fallback (if the raw body's first
//    non-whitespace byte is `{`) in case a given merchant's confirmation
//    delivery is configured differently, since being lenient here costs
//    nothing and a wrong guess would otherwise hard-fail 100% of real
//    webhooks.
//  - **`x_response` string vocabulary** (`Aceptada`/`Pendiente`/`Rechazada`/
//    `Fallida`) — VERIFIED verbatim against url-de-confirmacion (matches
//    design doc decision 7). Parsed as a string here, never `x_cod_response`'s
//    numeric code, per the design doc's explicit caution.
//  - **Genuinely unresolved, flag for reviewer**: the exact idempotency/
//    unique-event-id field. ePayco's own docs describe BOTH `x_ref_payco`
//    and `x_transaction_id` as "transaction receipt number" in different
//    places (genuinely ambiguous, redundant-sounding wording, not this
//    task's misreading) without ever stating which one — or whether
//    either alone — is guaranteed unique across a webhook redelivery/retry
//    (ePayco's own docs do say confirmation deliveries can retry and warn
//    integrators to guard against processing the same transaction twice,
//    but do not name the field to key that guard on). Per the same
//    composition-for-safety reasoning `wompi.ts` used for its own
//    `transaction.id:timestamp` `eventId` (its docs had an analogous gap),
//    `eventId` here composes BOTH: `${x_ref_payco}:${x_transaction_id}`.
//    `providerRef` is `x_ref_payco` alone (not composed) — that's the exact
//    path segment ePayco's own status-lookup endpoint
//    (`/validation/v1/reference/{ref_payco}`, see `getTransactionStatus`
//    below) takes, so it must stay a single plain value a caller can pass
//    straight through, unlike `eventId` which has no such external contract.
//  - `reference: x_extra1` — this is the SAME slot `createCheckoutSession`
//    populates via `extras.extra1` (see above); confirmed consistent by
//    reading both the request-body example and the webhook-fields docs.
//  - **`getTransactionStatus`'s real endpoint — this task's step-1(b)
//    re-verification, the single lowest-confidence fact carried over from
//    the design doc**. Tried harder per the plan's instruction: found that
//    `GET https://secure.epayco.co/validation/v1/reference/{ref_payco}` IS
//    actually referenced on an OFFICIAL docs.epayco.com page
//    (`checkout-respuesta-y-confirmacion`, fetched directly during this
//    task — not just the community SDK repo the design doc found), which
//    states this is the endpoint to call "to obtain the attributes sent in
//    the dynamic response page." This raises confidence in the ENDPOINT
//    ITSELF (URL, GET method, `ref_payco` path param, `Content-Type:
//    application/json` header, no auth key required) above the design
//    doc's original "community SDK only" confidence level. HOWEVER, the
//    EXACT JSON RESPONSE SCHEMA is still NOT stated on that official page —
//    it only names the endpoint, not its response shape. For the response
//    shape, this task fell back to the same community source the design
//    doc found (`github.com/DiegoxK/epayco-checkout-sdk`, a THIRD-PARTY,
//    NOT ePayco's own, Node/browser SDK) plus a search-engine summary of
//    the same repo, both independently describing a
//    `{ success: boolean, data: { x_cod_respuesta: 1|2|3|4, ... } }` shape
//    (`1`=Aceptada, `2`=Rechazada, `3`=Pendiente, `4`=Fallida) — but this is
//    a MATERIALLY LOWER-CONFIDENCE source than, e.g., `mercadopago.ts`'s use
//    of MP's own OFFICIAL Node SDK's compiled type declarations: this is a
//    community-authored SDK, not ePayco's own, and its field name
//    (`x_cod_respuesta`) doesn't even match the confirmation webhook's own
//    documented spelling (`x_cod_response`, no accent, per the design doc's
//    verified webhook fields) — an inconsistency this task cannot resolve
//    without a real sandbox account. `getTransactionStatus` below therefore:
//    (1) prefers a string `x_response` field if the real response ever
//    includes one (reusing the verified string vocabulary/`mapStatus`, the
//    highest-confidence path), and (2) FALLS BACK to the numeric
//    `x_cod_respuesta`/`x_cod_response` code (checking both spellings) ONLY
//    if no string field is present, via the SAME 1/2/3/4 mapping the
//    community source describes. **This numeric fallback path is explicitly
//    flagged as NOT verified against an official ePayco source and should be
//    double-checked against a real sandbox response before this method is
//    trusted in production.**
//
// --- P3c Task 2 re-verification of `getTransactionStatus`'s response schema
// (the widened `TransactionStatusResult` return needs to know whether this
// endpoint carries a reference/amount at all, so the previous bullet's
// lowest-confidence status was re-attacked rather than inherited):
//  - **A FIRST-PARTY source for this endpoint's response shape was found**,
//    materially better than the third-party community SDK the bullet above
//    relies on: ePayco's OWN official sample-code repo,
//    `github.com/epayco/resources` (the same repo whose PHP confirmation
//    sample is already cited above), contains an Angular sample —
//    `epayco-ng6/src/app/services/epayco.service.ts` — whose
//    `configUrl = 'https://secure.epayco.co/validation/v1/reference/'` +
//    `http.get<EpaycoTransaction>(configUrl + refPayco)` types EXACTLY this
//    call, against `epayco-ng6/src/app/models/epayco-transaction.model.ts`.
//    That model declares, under `data`: `x_response`, `x_respuesta`,
//    `x_cod_response`, `x_cod_respuesta`, `x_amount`, `x_currency_code`,
//    `x_transaction_id`, `x_transaction_date`, `x_ref_payco`, `x_signature`,
//    `x_extra1`, `x_extra2`, `x_extra3`, and ~30 more. The same repo's
//    `onePage/response/response.html` independently reads
//    `response.data.x_response`, `response.data.x_cod_response` and
//    `response.data.x_amount` off a live call to this same URL.
//  - Three consequences, all upgrades on the bullet above: (1) the STRING
//    `x_response` preferred path is confirmed real on this endpoint, not
//    just hoped for; (2) the `x_cod_respuesta` vs `x_cod_response` spelling
//    inconsistency that the bullet above says "this task cannot resolve" is
//    resolved — ePayco's own model declares BOTH, so checking both spellings
//    (which this adapter already did) is correct, not merely defensive; and
//    (3) `x_extra1` and `x_amount` ARE on this response, which is what lets
//    `getTransactionStatus` populate `TransactionStatusResult`'s
//    order-binding fields at all.
//  - **Still NOT verified against a real sandbox response** (no ePayco
//    sandbox account was available for this task either), and `x_amount`'s
//    UNITS on this endpoint specifically are not stated by that model — see
//    `getTransactionStatus`'s own doc comment for the per-field confidence
//    levels and the units reasoning. Every one of these fields is read
//    defensively: absent or wrong-typed leaves the corresponding
//    `TransactionStatusResult` field `undefined` rather than fabricating a
//    value, so being wrong here fails safe (an order simply cannot be
//    auto-reconciled) rather than settling the wrong order.
const APIFY_BASE = 'https://apify.epayco.co';
const VALIDATION_BASE = 'https://secure.epayco.co';
const CHECKOUT_CURRENCY = 'COP';
const CHECKOUT_COUNTRY = 'CO';

// ## Storefront base URL — RESOLVED, per tenant
//
// `createCheckoutSession`'s returned `redirectUrl` points at THIS codebase's
// own storefront's `/pago/epayco` bridge page (design doc decision 6), and its
// session-create `response` field points at that same storefront's
// `/pago/epayco-retorno/{orderNumber}` route. Both need a real, public,
// per-TENANT browser-reachable base URL.
//
// That base used to come from ONE global env var
// (`PAYMENTS_STOREFRONT_BASE_URL`), which was multi-tenant-WRONG by
// construction: every tenant's shopper was redirected to the same storefront
// regardless of which tenant they checked out on. It now comes from
// `OrderForPayment.storefrontBaseUrl`, populated per HTTP request in
// `services/api/src/checkout/checkout.service.ts` from the tenant domain that
// request already resolved against the `TenantDomain` table. The env var is
// gone; `storefront-base.ts` now only VALIDATES the supplied value (and
// throws rather than substituting anything if it is missing or malformed).

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

function timingSafeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  // Same length-guard pattern as mercadopago.ts's timingSafeEqualHex:
  // node:crypto's timingSafeEqual throws (rather than returning false) on
  // mismatched-length buffers — an attacker-controlled or simply malformed
  // signature of the wrong length must fail verification, not crash.
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Maps ePayco's real `x_response` STRING vocabulary (confirmed verbatim
 * against docs.epayco.com/docs/url-de-confirmacion — see module doc
 * comment) onto this codebase's `NormalizedStatus` union. Deliberately does
 * NOT accept/parse `x_cod_response`'s numeric code here — the design doc's
 * explicit caution, re-confirmed by this task: the numeric mapping was never
 * found on an official page. Shared between `verifyAndParseWebhook` (which
 * always has the real string) and `getTransactionStatus`'s preferred path
 * (when the lookup response happens to include one), same shape as
 * `wompi.ts`/`mercadopago.ts`'s single shared `mapStatus`. */
function mapStatus(xResponse: string): NormalizedStatus {
  switch (xResponse) {
    case 'Aceptada':
      return 'PAID';
    case 'Pendiente':
      return 'PENDING';
    case 'Rechazada':
    case 'Fallida':
      return 'FAILED';
    default:
      // Unrecognized/future ePayco status string: fail closed, same
      // "never silently assume PAID" posture as the other two adapters.
      return 'FAILED';
  }
}

/** Lower-confidence numeric fallback for `getTransactionStatus` only — see
 * the module doc comment's dedicated section on why this is NOT verified
 * against an official ePayco source (a community SDK's type declarations
 * only, with an inconsistent field-name spelling versus the officially
 * documented webhook fields). Never used by `verifyAndParseWebhook`, which
 * always has the officially-verified `x_response` string instead. */
const NUMERIC_RESPONSE_CODE_MAP: Record<string, NormalizedStatus> = {
  '1': 'PAID', // Aceptada
  '2': 'FAILED', // Rechazada
  '3': 'PENDING', // Pendiente
  '4': 'FAILED', // Fallida
};

/** Converts ePayco's MAJOR-unit (pesos) amount field to cents, tolerating
 * both the number and numeric-string forms this field is seen in (JSON on
 * the validation endpoint, form-encoded on the confirmation webhook).
 * Returns `undefined` — never `NaN` — for anything unparseable, so a caller
 * comparing `amountCents === order.totalCents` is never handed a garbage
 * value that could accidentally compare equal or mask a real mismatch. */
function parseMajorUnitsToCents(raw: unknown): number | undefined {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? Math.round(raw * 100) : undefined;
  }
  if (typeof raw === 'string' && raw.trim().length > 0) {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? Math.round(parsed * 100) : undefined;
  }
  return undefined;
}

function requireEventsSecret(cfg: TenantProviderConfig): string {
  if (!cfg.eventsSecret) {
    throw new Error('epayco: TenantProviderConfig.eventsSecret (P_KEY) is required for this operation');
  }
  return cfg.eventsSecret;
}

function requireEpaycoCustomerId(cfg: TenantProviderConfig): string {
  if (!cfg.epaycoCustomerId) {
    throw new Error('epayco: TenantProviderConfig.epaycoCustomerId (P_CUST_ID_CLIENTE) is required for this operation');
  }
  return cfg.epaycoCustomerId;
}

/** Parses ePayco's confirmation POST body. Primarily
 * `application/x-www-form-urlencoded` (see module doc comment's content-type
 * finding), with a defensive JSON fallback — sniffed by the first
 * non-whitespace byte, never by a `Content-Type` header (this codebase's
 * `RawRequest` doesn't guarantee one is present/trustworthy, same posture as
 * `wompi.ts` reading `rawBody` directly rather than relying on headers). */
function parseConfirmationBody(rawBody: Buffer): Record<string, string> {
  const text = rawBody.toString('utf8');
  const trimmed = text.trimStart();
  if (trimmed.startsWith('{')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error('epayco webhook: body looks like JSON but failed to parse');
    }
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('epayco webhook: malformed JSON payload');
    }
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (value !== undefined && value !== null) out[key] = String(value);
    }
    return out;
  }
  const out: Record<string, string> = {};
  // `trimmed`, not `text`: URLSearchParams folds any leading whitespace into
  // the first field's key (e.g. `new URLSearchParams(' a=1')` parses a key of
  // `' a'`, not `'a'`), silently breaking that field's lookup.
  for (const [key, value] of new URLSearchParams(trimmed)) {
    out[key] = value;
  }
  return out;
}

/** ePayco payment provider adapter ("Smart Checkout" v2). See the module doc
 * comment above for the full list of real-API facts this class relies on
 * and this task's confidence in each. */
export class EpaycoProvider implements PaymentProvider {
  readonly id = 'epayco' as const;

  /** Steps (a)+(b) of design doc decision 6, done server-side:
   * `POST /login` (HTTP Basic) → JWT, then `POST /payment/session/create`
   * (Bearer JWT) → `sessionId`. Returns a `redirectUrl` pointing at THIS
   * tenant's own storefront `/pago/epayco` bridge page, which loads
   * `checkout-v2.js` and opens the widget client-side.
   *
   * ## The `response` field — what it fixes, and what it explicitly does NOT
   *
   * In `type: 'standard'` (the mode this integration uses, because card data
   * must never touch this app), the widget does a full-page navigation to
   * `new-checkout.epayco.co`. Established by reading ePayco's actual shipped
   * `checkout-v2.js`: the bridge page is unloaded, so every `setHooks`
   * closure dies and NO hook can fire. Until now that left the manual "Ya
   * pagué, ver mi pedido" link as the only way back — a shopper who didn't
   * click it was simply stranded on epayco.co.
   *
   * `response` is ePayco's own answer to that, and it is now populated with
   * `{storefrontBaseUrl}/pago/epayco-retorno/{orderNumber}`. Verified for this
   * change, first-party sources only:
   *  - `docs.epayco.com/docs/checkout-implementacion`'s verbatim
   *    session-create example carries `"response": "https://mysite.com"`,
   *    documented as the browser redirect URL the shopper returns to.
   *  - `docs.epayco.com/docs/paginas-de-respuestas` states the shopper is
   *    redirected there with **`ref_payco`** in the URL parameters, and warns
   *    the response page is "NOT reliable to validate the final state of the
   *    transaction" and that "parameters can be manipulated by the user".
   *  - ePayco's OWN sample repo `github.com/epayco/resources` confirms the
   *    parameter is read off the QUERY STRING:
   *    `onePage/response/response.html` does
   *    `var ref_payco = getQueryParam('ref_payco')`, and
   *    `epayco-ng6/.../response/response.component.ts` does
   *    `params['ref_payco'] || params['x_ref_payco']` — both then GET
   *    `https://secure.epayco.co/validation/v1/reference/{ref}`.
   *
   * **What this achieves: the UX dead end, and a support breadcrumb. Nothing
   * more.** The return route sends the captured `ref_payco` to the API's
   * provider-ref-hint endpoint, which stores it with
   * `providerRefSource: 'hint'`. `reconciliation.worker.ts`'s provenance gate
   * (`ACCOUNT_SCOPED_LOOKUP_PROVIDERS`) REFUSES hint-sourced refs for ePayco,
   * because the lookup endpoint above is unauthenticated and ignores the
   * caller's credentials entirely — any `ref_payco` resolves globally, so a
   * truthful "PAID" from it says nothing about money reaching THIS tenant.
   * **So this does NOT restore ePayco reconciliation coverage**: an ePayco
   * order whose confirmation webhook never arrives still cannot be settled,
   * and still falls through to the 15-minute stock-reservation expiry worker.
   * Do not read the capture as having closed that gap, and do not add
   * `'epayco'` to that Set — that needs merchant-identifier binding verified
   * against a real sandbox account.
   *
   * The order number rides in the response route's PATH, not its query
   * string, for the same reason `wompi.ts`'s does: the gateway appends its own
   * `?ref_payco=` to whatever URL it was given, and no ePayco doc promises
   * correct behavior when a query string is already present. */
  async createCheckoutSession(
    order: OrderForPayment,
    cfg: TenantProviderConfig,
    fetchImpl: typeof fetch = fetch,
  ): Promise<{ redirectUrl: string }> {
    // Validated up front, before the (network-touching) login call: a
    // missing/malformed per-tenant base must fail this checkout outright
    // rather than create a real ePayco session the shopper can never return
    // from. See `requireStorefrontBaseUrl` for the rules.
    const storefrontBase = requireStorefrontBaseUrl(order.storefrontBaseUrl, 'epayco');
    const basicAuth = Buffer.from(`${cfg.publicKey}:${cfg.privateKey}`, 'utf8').toString('base64');
    const loginRes = await fetchGateway(
      fetchImpl,
      'epayco createCheckoutSession (login)',
      `${APIFY_BASE}/login`,
      {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basicAuth}`,
        'Content-Type': 'application/json',
      },
    });
    if (!loginRes.ok) {
      throw new Error(`epayco createCheckoutSession: login HTTP ${loginRes.status}`);
    }
    const loginBody = (await loginRes.json()) as { token?: unknown };
    if (typeof loginBody.token !== 'string') {
      throw new Error('epayco createCheckoutSession: malformed login response (missing token)');
    }
    const jwt = loginBody.token;

    const sessionRes = await fetchGateway(
      fetchImpl,
      'epayco createCheckoutSession',
      `${APIFY_BASE}/payment/session/create`,
      {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        checkout_version: '2',
        name: `Order ${order.orderNumber}`,
        description: `Payment for order ${order.orderNumber}`,
        currency: CHECKOUT_CURRENCY,
        country: CHECKOUT_COUNTRY,
        amount: order.totalCents / 100,
        // The shopper's browser return URL, per tenant. See this method's doc
        // comment for the first-party sources this was verified against, and
        // for the explicit statement that capturing `ref_payco` here does NOT
        // restore ePayco reconciliation coverage.
        response: `${storefrontBase}/pago/epayco-retorno/${encodeURIComponent(order.orderNumber)}`,
        // Same slot `verifyAndParseWebhook` reads back as `x_extra1` — see
        // module doc comment's dedicated section on this naming asymmetry.
        // `Order.reference`, not the per-tenant order number. This slot is
        // read back as `x_extra1` on the confirmation webhook, and it is NOT
        // covered by ePayco's confirmation hash — which is exactly why the
        // value must be unguessable rather than derivable from a tenant and
        // an order number. See OrderForPayment.gatewayReference.
        extras: { extra1: order.gatewayReference },
      }),
    });
    if (!sessionRes.ok) {
      throw new Error(`epayco createCheckoutSession: session/create HTTP ${sessionRes.status}`);
    }
    const sessionBody = (await sessionRes.json()) as { data?: { sessionId?: unknown } };
    const sessionId = sessionBody.data?.sessionId;
    if (typeof sessionId !== 'string') {
      throw new Error('epayco createCheckoutSession: malformed session/create response (missing data.sessionId)');
    }

    // `orderNumber` added here (Task 6, closing a real gap left open by this
    // task's own original version): the bridge page at `/pago/epayco` has no
    // other way to learn which order it's bridging for, since neither
    // `configure()`'s widget config nor ePayco's hooks below carry the
    // order number back — see Task 6's report for the full reasoning. Safe,
    // additive change: order numbers are already shown to the shopper
    // unencrypted on the confirmation URL itself
    // (`/checkout/confirmacion/{orderNumber}`), so putting the same value in
    // this redirect's query string leaks nothing new.
    const params = new URLSearchParams({
      session: sessionId,
      sandbox: String(cfg.sandbox),
      orderNumber: String(order.orderNumber),
    });
    return { redirectUrl: `${storefrontBase}/pago/epayco?${params.toString()}` };
  }

  /** Verifies and parses an ePayco confirmation ("URL de confirmación")
   * webhook, then RE-VERIFIES it against ePayco's own transaction lookup.
   *
   * ## Why a lookup is mandatory here (P3 wave-1 fix 1, CRITICAL)
   *
   * ePayco's documented confirmation signature is
   * `SHA256(P_CUST_ID^P_KEY^x_ref_payco^x_transaction_id^x_amount^x_currency_code)`
   * — verified verbatim, and implemented correctly below. But that 4-tuple
   * covers NEITHER `x_response` (the payment status) NOR `x_extra1` (which
   * order the payment is for), and this method reads and reports both. A
   * genuine, fully-signed confirmation could therefore be replayed verbatim
   * with ONLY those two unsigned fields rewritten, pointing a real 100-COP
   * payment at a 999,999-COP order and reporting it PAID — reproduced with a
   * working exploit before this fix. This is inherent to ePayco's own
   * formula: any correct implementation of it has this property, so the fix
   * cannot live in the hash.
   *
   * So the status and the reference are taken from ePayco's OWN record of the
   * transaction — looked up by the SIGNED `x_ref_payco` via
   * `getTransactionStatus` below, the same binding pattern
   * `reconciliation.worker.ts` already applies on its own lookup path — and
   * the body's unsigned `x_extra1` is only accepted if the gateway's own
   * record AGREES with it. The gateway's amount (when it reports one) must
   * likewise agree with the SIGNED `x_amount`. Anything unverifiable
   * (missing reference, failed lookup) REJECTS: an unverifiable claim is
   * never treated as a verified one, and there is deliberately no fallback to
   * the unsigned fields.
   *
   * ## What this does NOT establish — read before trusting it
   *
   * ePayco's lookup endpoint (`/validation/v1/reference/{ref}`) is
   * UNAUTHENTICATED and ignores the caller's credentials entirely: any
   * reference resolves globally, for any merchant. So this re-verification
   * binds the STATUS and the ORDER REFERENCE to the signed transaction — it
   * does NOT establish that the transaction belongs to THIS merchant/tenant.
   * **Account-scoping for ePayco remains unsolved** and is explicitly out of
   * this change's scope. What actually stops a cross-account or re-pointed
   * confirmation from settling the wrong order is the unconditional
   * `event.amountCents === order.totalCents` check in
   * `services/api/src/payments/webhooks.controller.ts`, which runs for all
   * three providers before any settle.
   *
   * Throws on any verification failure, same contract as the other two
   * adapters (the caller responds 401 and the gateway retries later — the
   * right posture for a transient lookup outage). */
  async verifyAndParseWebhook(
    req: RawRequest,
    cfg: TenantProviderConfig,
    fetchImpl: typeof fetch = fetch,
  ): Promise<NormalizedPaymentEvent> {
    const eventsSecret = requireEventsSecret(cfg);
    const epaycoCustomerId = requireEpaycoCustomerId(cfg);

    const fields = parseConfirmationBody(req.rawBody);

    const xRefPayco = fields.x_ref_payco;
    const xTransactionId = fields.x_transaction_id;
    const xAmount = fields.x_amount;
    const xCurrencyCode = fields.x_currency_code;
    const xSignature = fields.x_signature;
    const xResponse = fields.x_response;
    const xExtra1 = fields.x_extra1;

    if (!xRefPayco || !xTransactionId || !xAmount || !xCurrencyCode || !xSignature) {
      throw new Error(
        'epayco webhook: missing one or more required fields (x_ref_payco, x_transaction_id, x_amount, x_currency_code, x_signature)',
      );
    }
    if (!xResponse) {
      throw new Error('epayco webhook: missing x_response');
    }
    if (!xExtra1) {
      throw new Error('epayco webhook: missing x_extra1 (order reference)');
    }

    // Formula VERIFIED verbatim against docs.epayco.com/docs/url-de-confirmacion
    // (design doc decision 7): SHA256(P_CUST_ID_CLIENTE^P_KEY^x_ref_payco^x_transaction_id^x_amount^x_currency_code).
    const computed = sha256Hex(
      `${epaycoCustomerId}^${eventsSecret}^${xRefPayco}^${xTransactionId}^${xAmount}^${xCurrencyCode}`,
    );
    if (!timingSafeEqualHex(computed, xSignature)) {
      throw new Error('epayco webhook: signature mismatch');
    }

    // The SIGNED amount, in cents. Parsed through the same shared helper the
    // lookup path uses so an unparseable `x_amount` becomes a REJECTION
    // rather than a `NaN` amount silently flowing out of this adapter (the
    // old `Math.round(Number(xAmount) * 100)` produced exactly that). This
    // value is load-bearing: it is what the controller compares against the
    // order's total.
    const signedAmountCents = parseMajorUnitsToCents(xAmount);
    if (signedAmountCents === undefined) {
      throw new Error(`epayco webhook: x_amount is not a parseable amount (${JSON.stringify(xAmount)})`);
    }

    // --- Re-verification against ePayco's own record (see doc comment).
    //
    // Wrapped so that FAILING TO REACH the gateway is reported as a different
    // kind of failure from failing the check. Everything above this line is a
    // verdict about the bytes ePayco sent — permanent, and correctly a 401.
    // This call is a network round trip, and a timeout or a 5xx on it says
    // nothing about the signature. Answering those with "your signature was
    // wrong" is both untrue and dangerous: a provider that sees an endpoint
    // 401 repeatedly may disable the webhook, turning a transient blip into
    // silently unsettled payments. See WebhookVerificationUnavailableError.
    //
    // Only the CALL is wrapped. The comparisons below it stay plain Errors —
    // a lookup that succeeds and disagrees with the payload IS a verdict, and
    // retrying it would reach the same conclusion.
    let looked: TransactionStatusResult;
    try {
      looked = await this.getTransactionStatus(xRefPayco, cfg, fetchImpl);
    } catch (err) {
      throw new WebhookVerificationUnavailableError(
        `epayco webhook: could not reach the gateway to verify this delivery — ${
          err instanceof Error ? err.message : String(err)
        }`,
        { cause: err },
      );
    }
    if (looked.reference === undefined) {
      throw new Error(
        'epayco webhook: gateway lookup carries no reference — cannot verify which order this signed transaction is for',
      );
    }
    if (looked.reference !== xExtra1) {
      throw new Error(
        `epayco webhook: gateway reference ${JSON.stringify(looked.reference)} does not match the payload's unsigned x_extra1 ${JSON.stringify(xExtra1)}`,
      );
    }
    if (looked.amountCents !== undefined && looked.amountCents !== signedAmountCents) {
      throw new Error(
        `epayco webhook: gateway amount ${looked.amountCents} does not match the signed x_amount ${signedAmountCents}`,
      );
    }
    // Same treatment as the amount immediately above, and for the same reason:
    // an amount is not a quantity of money until you know what it is
    // denominated in, so the two must agree wherever both are available. ePayco
    // is the one provider of the three whose webhook currency is
    // CRYPTOGRAPHICALLY SIGNED — `x_currency_code` is the sixth term of the
    // confirmation-hash formula verified above — so the SIGNED value is what
    // this method reports; the lookup (unauthenticated, see this method's doc
    // comment) only gets to contradict it, never to replace it. Absent on the
    // lookup response: no contradiction, no rejection — the signed value
    // stands on its own signature.
    if (looked.currency !== undefined && looked.currency !== xCurrencyCode) {
      throw new Error(
        `epayco webhook: gateway currency ${JSON.stringify(looked.currency)} does not match the signed x_currency_code ${JSON.stringify(xCurrencyCode)}`,
      );
    }

    // NOTE on `xResponse`: it is required to be PRESENT (a confirmation
    // without it is malformed), but its value is deliberately NOT used and
    // deliberately NOT required to agree with the lookup — a confirmation
    // sent while the payment was `Pendiente` and looked up after it settled
    // legitimately disagrees, and the gateway's own current record is the
    // more truthful of the two. `mapStatus` is therefore applied to the
    // LOOKUP's status inside `getTransactionStatus`, not to this field.
    return {
      provider: 'epayco',
      // `x_ref_payco:x_transaction_id` — it is genuinely unresolved which of
      // the two alone is unique across a confirmation retry, so both are
      // composed in (see module doc comment). The resolved STATUS is composed
      // in as well, for the same reason `mercadopago.ts` composes its own
      // (P3 wave-1 fix 3): the status this adapter reports now comes from the
      // gateway and CAN legitimately differ between two confirmations for one
      // transaction (`Pendiente` then `Aceptada` on a PSE flow). Without it,
      // the first, non-settling confirmation would claim the idempotency row
      // and the later settling one would be discarded as a replay. Still
      // fully deterministic: a true redelivery of one confirmation resolves to
      // the same status and therefore the same id, and still dedupes.
      eventId: `${xRefPayco}:${xTransactionId}:${looked.status}`,
      // The exact path segment ePayco's own status-lookup endpoint takes
      // (see getTransactionStatus below) — kept as a single plain value.
      providerRef: xRefPayco,
      // The GATEWAY's own reference, not the body's unsigned field (they are
      // proven equal immediately above — this is which of the two is the
      // source of truth, not a behavioural difference).
      reference: looked.reference,
      status: looked.status,
      // The SIGNED amount: cryptographically bound, and cross-checked against
      // the gateway's own figure above where one is available.
      amountCents: signedAmountCents,
      // The SIGNED currency, on the same footing as the amount (both are terms
      // of ePayco's own confirmation hash) and cross-checked the same way.
      currency: xCurrencyCode,
    };
  }

  /** Calls ePayco's transaction-reference lookup endpoint. Historically the
   * **lowest-confidence method in this adapter** — see the module doc
   * comment's dedicated section, and its "P3c Task 2 re-verification"
   * addendum, which materially RAISED (but did not fully resolve) confidence
   * in this response schema by finding a FIRST-PARTY source for it.
   *
   * ## Order-binding fields (`reference`/`amountCents`), P3c Task 2
   *
   * `TransactionStatusResult` (packages/payments/src/index.ts) asks each
   * adapter to report the gateway's OWN record of which merchant reference
   * and what amount a transaction is for, so a by-id reconciliation caller
   * can bind the status to a specific order before trusting it. What this
   * adapter can populate, and at what confidence:
   *
   *  - `reference` <- `data.x_extra1` — **medium-high confidence.** This is
   *    THIS codebase's reference slot on ePayco end to end: sent as
   *    `extras.extra1` by `createCheckoutSession` above, read back as
   *    `x_extra1` by `verifyAndParseWebhook` above (that spelling verified
   *    verbatim against docs.epayco.com/docs/url-de-confirmacion). Its
   *    presence ON THIS ENDPOINT'S RESPONSE specifically is typed in
   *    ePayco's OWN official sample repo (see the module comment's P3c
   *    addendum for the exact file), not merely assumed by symmetry.
   *  - `amountCents` <- `data.x_amount * 100` — **medium confidence.**
   *    `x_amount` is typed on that same first-party model, but its UNITS are
   *    not stated there. It is treated as MAJOR units (pesos) because the
   *    identically-named `x_amount` on ePayco's confirmation webhook is
   *    verified major-unit (this adapter's own `verifyAndParseWebhook`
   *    applies the same `* 100`), and because ePayco's session-create
   *    `amount` is likewise verified pesos. Consistent-by-source, not
   *    independently unit-verified — flagged for reviewer.
   *
   * Both are populated ONLY when actually present and of a usable type;
   * anything missing/garbage leaves the field `undefined` rather than
   * fabricating a binding value. That is the fail-safe direction: a caller
   * MUST treat a missing `reference` as "cannot reconcile", never as
   * "binding check passed" (see `TransactionStatusResult`'s doc comment). */
  async getTransactionStatus(
    providerRef: string,
    _cfg: TenantProviderConfig,
    fetchImpl: typeof fetch = fetch,
  ): Promise<TransactionStatusResult> {
    const res = await fetchGateway(
      fetchImpl,
      'epayco getTransactionStatus',
      `${VALIDATION_BASE}/validation/v1/reference/${encodeURIComponent(providerRef)}`,
      {
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) {
      throw new Error(`epayco getTransactionStatus: HTTP ${res.status}`);
    }
    const body = (await res.json()) as {
      data?: {
        x_response?: unknown;
        x_cod_respuesta?: unknown;
        x_cod_response?: unknown;
        x_extra1?: unknown;
        x_amount?: unknown;
        x_currency_code?: unknown;
      };
    };
    const data = body.data;
    if (!data) {
      throw new Error('epayco getTransactionStatus: malformed response (missing data)');
    }

    // `x_extra1` is the order reference — a plain string when present. Never
    // `String(...)`-coerced from some other type: an invented binding value
    // is strictly worse than no binding value at all.
    const reference = typeof data.x_extra1 === 'string' && data.x_extra1.length > 0 ? data.x_extra1 : undefined;
    // MAJOR units (pesos) -> cents, same conversion verifyAndParseWebhook
    // applies to the same field name. Accepts a numeric string too, since
    // ePayco delivers this field form-encoded (i.e. always as a string) on
    // its webhook side and this endpoint's own first-party sample model
    // types it as a number — tolerate both rather than guess which one a
    // real response uses. NaN never escapes as an amount.
    const amountCents = parseMajorUnitsToCents(data.x_amount);
    // `x_currency_code` is declared on the same first-party model this
    // endpoint's other fields were verified against (see the module doc
    // comment's P3c addendum), and is the SIGNED field on ePayco's
    // confirmation webhook too — so its spelling is the one part of this
    // response shape that has an officially-documented sibling. Read
    // defensively; `undefined` (not `'COP'`) when absent or wrong-typed.
    const currency =
      typeof data.x_currency_code === 'string' && data.x_currency_code.length > 0
        ? data.x_currency_code
        : undefined;

    // Preferred, highest-confidence path: a string x_response field, using
    // the same officially-verified vocabulary as the webhook.
    if (typeof data.x_response === 'string') {
      return { status: mapStatus(data.x_response), reference, amountCents, currency };
    }
    // Lower-confidence fallback: a numeric code, under either spelling seen
    // across sources (see module doc comment).
    const numericCode = data.x_cod_respuesta ?? data.x_cod_response;
    if (numericCode !== undefined && numericCode !== null) {
      const mapped = NUMERIC_RESPONSE_CODE_MAP[String(numericCode)];
      if (mapped) return { status: mapped, reference, amountCents, currency };
    }
    throw new Error(
      'epayco getTransactionStatus: malformed response (missing x_response, and x_cod_respuesta/x_cod_response is either missing or an unrecognized code)',
    );
  }

  // `refund` deliberately left unimplemented — same rationale as
  // `wompi.ts`/`mercadopago.ts`: no refund/void UI or flow exists yet in
  // this codebase, and `PaymentProvider.refund` is optional for exactly
  // this reason.
}
