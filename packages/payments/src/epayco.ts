import { createHash, timingSafeEqual } from 'node:crypto';
import type {
  NormalizedPaymentEvent,
  NormalizedStatus,
  OrderForPayment,
  PaymentProvider,
  RawRequest,
  TenantProviderConfig,
} from './index.js';

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
//  - **Deliberate scope decision, mirroring `mercadopago.ts`'s identical
//    `back_urls`/`notification_url` omission and reasoning**: `response`
//    (the browser post-payment return URL) and `confirmation` (the webhook
//    URL) are REAL, confirmed fields on this same session-create request
//    body (both appear in the real example fetched above) — but BOTH are
//    deliberately omitted here. Reasoning: both need a real, tenant-specific
//    PUBLIC URL, and `createCheckoutSession`'s only inputs
//    (`OrderForPayment`, `TenantProviderConfig`) carry no tenant id or
//    domain at all — this codebase resolves a tenant's real public domain
//    dynamically, per HTTP request, from the `TenantDomain` table
//    (`services/api/src/tenants/domain-resolver.ts`'s `DomainResolver`,
//    keyed on an arbitrary `domain` string per tenant — NOT derivable from
//    `PLATFORM_ROOT_DOMAIN` alone, since a tenant can have a fully custom
//    domain registered there), and neither `STOREFRONT_INTERNAL_URL` (a
//    single global, internal, Docker-network-only URL used for ISR
//    revalidation — confirmed by reading `packages/core/src/env.ts` and
//    `.env.example` directly, NOT a public per-tenant one) nor any other env
//    var in this codebase carries that per-tenant domain today. Forcing a
//    value here would mean fabricating a wrong domain for every tenant
//    except (at best) one. VERIFIED this is safe to omit for now, not just
//    convenient: a web search of ePayco's own account-settings docs found
//    that ePayco's dashboard has a "URL Respuesta y Confirmación" panel
//    section (account-wide, out-of-band configuration) that both a) lets a
//    merchant configure a response/confirmation URL once per account
//    (mirroring Wompi's dashboard-configured webhook URL and Mercado Pago's
//    Integrations-Panel `notification_url`, the exact precedent
//    `mercadopago.ts` relies on for the identical gap) and b) lets the
//    account choose which transaction states actually fire the webhook.
//    THIS IS A REAL, LOAD-BEARING GAP for whoever wires this adapter into
//    `checkout.service.ts` (Task 4/6): if per-tenant `response`/
//    `confirmation` URLs are ever required (e.g. because a shared ePayco
//    merchant account can't vary the panel-level URL per storefront tenant),
//    `OrderForPayment` or this method's inputs will need a tenant
//    domain/base-URL threaded through — out of scope here, flagged for
//    whoever picks it up next. Separately: since the shopper's browser is
//    redirected to the tenant's OWN storefront's `/pago/epayco` bridge page
//    FIRST (see the `redirectUrl`/`resolveStorefrontBase` section below)
//    before the widget ever opens, that bridge page (Task 6) already knows
//    its own real origin client-side (`window.location.origin`) and can
//    build any final post-payment navigation itself via the widget's
//    `onResponse`/`onClosed` hooks — so the missing per-tenant `response`
//    URL may turn out to be fully avoidable rather than something Task 6
//    strictly needs solved server-side. Flagged as an open design question
//    for Task 6, not resolved here.
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
const APIFY_BASE = 'https://apify.epayco.co';
const VALIDATION_BASE = 'https://secure.epayco.co';
const CHECKOUT_CURRENCY = 'COP';
const CHECKOUT_COUNTRY = 'CO';

// **Interim, explicitly-provisional mechanism for the storefront-redirect
// architectural gap (see the module doc comment's `response`/`confirmation`
// section above for the full reasoning on why no per-tenant public base URL
// reaches this adapter today).** `createCheckoutSession`'s returned
// `redirectUrl` must point at THIS codebase's own storefront's
// `/pago/epayco` bridge page (design doc decision 6) — a real, public,
// per-TENANT browser-reachable base URL, which neither `OrderForPayment` nor
// `TenantProviderConfig` carries, and which this task's file list does not
// authorize sourcing correctly (that requires widening `OrderForPayment` and
// touching `checkout.controller.ts`/`checkout.service.ts`, explicitly out of
// scope for this task). Rather than silently hardcode any single tenant's
// real domain (which would produce a WRONG, broken redirect for every other
// tenant, in production, with no signal that anything's wrong) or throw
// unconditionally (which would make this adapter unusable end-to-end even
// for local, single-tenant-dev testing), this reads ONE new, explicitly
// provisional env var, defaulting to `http://localhost:3000` for a
// single-tenant dev loop (mirroring `revalidate.ts`'s identical
// `STOREFRONT_INTERNAL_URL` dev default) — **this default, and indeed this
// whole mechanism, is WRONG for any real multi-tenant deployment where more
// than one tenant uses ePayco**: every tenant's shopper would be redirected
// to the SAME single storefront base regardless of which tenant they
// actually checked out on. This is a real, load-bearing gap, not a
// convenience shortcut — flagged loudly here, in the commit body, and in
// this task's own report: **whoever wires `EpaycoProvider` into
// `checkout.service.ts` (Task 4/6) MUST replace this with the real
// per-request tenant domain** (resolved the same way
// `services/api/src/tenants/domain-resolver.ts`'s `DomainResolver` already
// resolves an inbound request's host to a tenant, threaded down through
// `OrderForPayment` or an equivalent widened input), NOT simply leave this
// env var in place for production.
const STOREFRONT_BASE_ENV_VAR = 'EPAYCO_STOREFRONT_BASE_URL';

function resolveStorefrontBase(): string {
  return process.env[STOREFRONT_BASE_ENV_VAR] ?? 'http://localhost:3000';
}

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
   * storefront's own `/pago/epayco` bridge page (step (c), the client-side
   * widget `.open()` call, is Task 6's job) — see `resolveStorefrontBase`'s
   * doc comment for the honest, load-bearing gap in how that base URL is
   * resolved today. */
  async createCheckoutSession(
    order: OrderForPayment,
    cfg: TenantProviderConfig,
    fetchImpl: typeof fetch = fetch,
  ): Promise<{ redirectUrl: string }> {
    const basicAuth = Buffer.from(`${cfg.publicKey}:${cfg.privateKey}`, 'utf8').toString('base64');
    const loginRes = await fetchImpl(`${APIFY_BASE}/login`, {
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

    const sessionRes = await fetchImpl(`${APIFY_BASE}/payment/session/create`, {
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
        // Same slot `verifyAndParseWebhook` reads back as `x_extra1` — see
        // module doc comment's dedicated section on this naming asymmetry.
        extras: { extra1: order.orderNumber },
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

    const params = new URLSearchParams({ session: sessionId, sandbox: String(cfg.sandbox) });
    return { redirectUrl: `${resolveStorefrontBase()}/pago/epayco?${params.toString()}` };
  }

  /** Verifies and parses an ePayco confirmation ("URL de confirmación")
   * webhook. No network call is made here (unlike Mercado Pago's mandatory
   * follow-up payment lookup) — ePayco's real confirmation POST carries
   * every field this adapter needs directly, confirmed against
   * url-de-confirmacion (see module doc comment). Throws on any
   * verification failure, same contract as the other two adapters. */
  async verifyAndParseWebhook(req: RawRequest, cfg: TenantProviderConfig): Promise<NormalizedPaymentEvent> {
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

    return {
      provider: 'epayco',
      // Genuinely unresolved which of x_ref_payco/x_transaction_id alone is
      // guaranteed unique across a confirmation retry — composed for safety,
      // see module doc comment.
      eventId: `${xRefPayco}:${xTransactionId}`,
      // The exact path segment ePayco's own status-lookup endpoint takes
      // (see getTransactionStatus below) — kept as a single plain value.
      providerRef: xRefPayco,
      reference: xExtra1,
      status: mapStatus(xResponse),
      amountCents: Math.round(Number(xAmount) * 100),
    };
  }

  /** Calls ePayco's transaction-reference lookup endpoint. **Lowest-confidence
   * method in this adapter** — see the module doc comment's dedicated
   * section: the endpoint URL itself is corroborated by an official
   * docs.epayco.com page, but the exact response schema below is sourced
   * from a THIRD-PARTY community SDK, not an ePayco-authored one, and is
   * NOT verified against a real sandbox response. Flagged prominently for
   * reviewer double-check before this is trusted in production. */
  async getTransactionStatus(
    providerRef: string,
    _cfg: TenantProviderConfig,
    fetchImpl: typeof fetch = fetch,
  ): Promise<NormalizedStatus> {
    const res = await fetchImpl(`${VALIDATION_BASE}/validation/v1/reference/${encodeURIComponent(providerRef)}`, {
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
      };
    };
    const data = body.data;
    if (!data) {
      throw new Error('epayco getTransactionStatus: malformed response (missing data)');
    }
    // Preferred, highest-confidence path: a string x_response field, using
    // the same officially-verified vocabulary as the webhook.
    if (typeof data.x_response === 'string') {
      return mapStatus(data.x_response);
    }
    // Lower-confidence fallback: a numeric code, under either spelling seen
    // across sources (see module doc comment).
    const numericCode = data.x_cod_respuesta ?? data.x_cod_response;
    if (numericCode !== undefined && numericCode !== null) {
      const mapped = NUMERIC_RESPONSE_CODE_MAP[String(numericCode)];
      if (mapped) return mapped;
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
