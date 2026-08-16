import { createHmac, timingSafeEqual } from 'node:crypto';
import type {
  NormalizedPaymentEvent,
  NormalizedStatus,
  OrderForPayment,
  PaymentProvider,
  RawRequest,
  ReferenceSearchResult,
  TenantProviderConfig,
  TransactionStatusResult,
} from './index.js';
import { fetchGateway } from './http.js';

// --- Facts below are cited in the Task 2 report as verified-against-real-docs
// vs. inferred vs. genuinely unresolved. Full detail (including the specific
// URLs fetched and what each one did/didn't confirm) is in the Task 2 report
// and this commit's body — summary here:
//  - Checkout Pro is a real server-side "create preference" HTTP call (not a
//    locally-signed redirect URL like Wompi) — verified against
//    docs.mercadopago.com.co/ar "Checkout Pro" overview + "configure-back-urls".
//  - `privateKey` holds MP's real "Access Token" (server-side secret),
//    `publicKey` holds MP's real "Public Key" (frontend-only, card-tokenization
//    credential this redirect-only adapter never calls) — verified against the
//    Credentials page. `publicKey` is collected on `TenantProviderConfig` for
//    symmetry with the two-key admin-UI pattern shared by every provider, and
//    in case a future non-redirect MP integration (Bricks/Checkout API) needs
//    it, but THIS adapter's `createCheckoutSession` never reads it — that is
//    deliberate, not an oversight.
//  - `unit_price` on a preference `items[]` entry is a decimal MAJOR-unit
//    number (pesos), not cents — verified directly: multiple official MP
//    preference examples show fractional peso values like `75.56`/`11.96` as
//    `unit_price`, which would be nonsensical as a cents value. This is the
//    opposite convention from Wompi's `amount-in-cents`, hence the explicit
//    `/ 100` conversion below — get this backwards and every MP charge is
//    100x too small or too large.
//  - The single API host `api.mercadopago.com` serves BOTH sandbox and
//    production — verified (configure-development-environment page).
//    `cfg.sandbox` only ever selects which field of the SAME preference
//    response to read (`sandbox_init_point` vs `init_point`), never a
//    different host, unlike Wompi's differing sandbox/production hosts.
//  - Webhook manifest template — `id:{data.id};request-id:{x-request-id};ts:{ts};`
//    — verified directly against a live fetch of
//    mercadopago.com.br/developers/en/docs/checkout-pro/payment-notifications
//    (a page that 404'd/JS-rendered during this phase's design step) and
//    cross-referenced against an independent deep-dive write-up of the same
//    SDK behavior.
//  - **Corrected from the design doc**: `ts`'s units. The design doc assumed
//    "unix-seconds". The payment-notifications page fetched above states
//    outright: "This header format includes a timestamp (`ts`) in
//    milliseconds", with a 13-digit example value
//    (`ts=1742505638683`). However, a DIFFERENT official MP docs page (a
//    legacy "mp-point" product's webhooks doc, also on mercadopago.com.br)
//    shows a 10-digit, seconds-scale example (`ts=1704908010`) with no unit
//    stated at all — MP's own documentation is internally inconsistent about
//    this across product lines. This adapter treats `ts` as an OPAQUE STRING
//    lifted verbatim out of the `x-signature` header and never parsed/compared
//    numerically, so the seconds-vs-milliseconds question does not actually
//    affect correctness here — but it's flagged in case a future feature
//    (e.g. rejecting stale/replayed webhooks by age) is ever added on top of
//    this, since that WOULD need the real unit resolved first.
//  - **Genuinely unresolved, flag for reviewer**: whether a MISSING
//    `x-request-id` header should omit the `request-id:...;` segment from the
//    manifest entirely (this adapter's choice, matching the design doc's
//    original assumption) or substitute an empty string
//    (`request-id:;`). No official MP docs page fetched during this task
//    states this rule either way; the one independent implementation write-up
//    found uses an empty-string fallback, contradicting the design doc's
//    assumption. In practice `x-request-id` is documented as one of the two
//    required signature-verification headers, so this path is only reachable
//    for a malformed/non-standard delivery — but if this ever matters in
//    production, verify against a real MP sandbox delivery with the header
//    deliberately stripped before trusting either behavior.
//  - **Genuinely unresolved, flag for reviewer**: the exact test-credential
//    prefix format. Re-checked directly against MP's own Credentials page
//    during this task: it states the test Access Token's prefix "may vary
//    depending on the solution you are integrating" and gives no canonical
//    example. No prefix format is hardcoded or validated anywhere below for
//    exactly this reason.
//  - `GET /v1/payments/:id`'s response schema — the interactive API-reference
//    page (`.../reference/payments/_payments_id/get`) 404'd on every locale
//    variant tried directly during this task (.ar/.co/.mx/bare), same as
//    during design. Instead of falling back to the design doc's
//    search-summarized field list, this task found and read the official
//    Node.js SDK's own compiled type declarations
//    (`unpkg.com/mercadopago/dist/clients/payment/commonTypes.d.ts`) — the
//    literal response type the official SDK itself uses for this exact
//    resource. It confirms `id`, `status`, `status_detail`, `transaction_amount`,
//    `external_reference`, `currency_id`, `date_approved` (and many more
//    fields this adapter doesn't need) are all real fields on the payment
//    resource, at higher confidence than a search-summarized excerpt.
//  - Status vocabulary + the exact `mapStatus` table below (`approved`,
//    `pending`/`in_process`/`authorized`/`in_mediation`, `rejected`,
//    `cancelled`, `refunded`/`charged_back`) is per the design doc's decision
//    5, unchanged by this task's re-verification (not re-litigated here; see
//    the design doc for the full reasoning on `cancelled`→`FAILED` vs.
//    `refunded`/`charged_back`→`EXPIRED`).
//
// --- P3c Task 1 additions (`searchByReference`) — re-verified independently
// of the design doc's own citation, per that phase's own instruction that
// docs sites restructure and an earlier URL had already gone stale once:
//  - `GET https://api.mercadopago.com/v1/payments/search` (query param
//    `external_reference={reference}`) is real and confirmed — but NOT at
//    the URL shape the design doc expected. Both `mercadopago.com.co` and
//    `mercadopago.com.ar`'s `/developers/en/reference/payments/_payments_search/get`
//    404'd directly during THIS task (the design doc's own `.co` citation is
//    now stale — a live instance of exactly the "docs sites restructure"
//    risk it already flagged). The content was still found live, verbatim,
//    at `https://www.mercadopago.com.br/developers/en/reference/online-payments/subscriptions/search-payments/get`
//    — confirmed via that page's own breadcrumb, fetched directly: "API
//    Reference - Mercado Pago Developers > Search payments - Payments -
//    Mercado Pago Developers" (i.e. genuinely the general Payments Search
//    page, despite the URL's own path segment now filing it under
//    "subscriptions" — a docs-site categorization artifact, not a different,
//    subscription-specific endpoint).
//  - Response shape, confirmed from that same fetch: top-level
//    `{paging: {total, limit, offset}, results: [...]}`; each `results[]`
//    entry carries (among many other fields this adapter doesn't need) `id`,
//    `status`, `status_detail`, `external_reference`, `date_created`,
//    `date_approved`, `date_last_updated`.
//  - Ordering: the same page documents `sort`/`criteria` params (sort by
//    `date_approved`/`date_created`/`date_last_updated`/`id`/
//    `money_release_date`, direction `asc`/`desc`) as "REQUIRED", but
//    (quoting the fetch verbatim) "does not explicitly state a default sort
//    order or indicate what happens if sort and criteria parameters are not
//    provided." Since this adapter's call omits both (only
//    `external_reference` is sent — no documented need to force a
//    sort/criteria pair just to pick one result), no ordering is assumed
//    from the API's own response order; `searchByReference` below sorts
//    `results` client-side by `date_approved` (falling back to
//    `date_created`) before picking, per design doc decision 5.
//
//  - **Deliberate scope decision, not in the design doc's original request**:
//    `back_urls`, `auto_return`, and `notification_url` are ALL omitted from
//    the `checkout/preferences` request body built below. Reasoning: all
//    three need a real, tenant-specific PUBLIC URL (the storefront's own
//    domain for `back_urls`, and this API's public webhook base for
//    `notification_url`).
//
//    **UPDATED (multi-tenancy fix): the "no tenant domain reaches this
//    adapter" half of that reasoning is no longer true.** `OrderForPayment`
//    now carries `storefrontBaseUrl` — the per-tenant public storefront base,
//    resolved per HTTP request in `checkout.service.ts` from the same
//    `TenantDomain` row `services/api/src/tenants/domain-resolver.ts` matched
//    — so `back_urls` COULD now be built here. They are still omitted, but for
//    a different and narrower reason: nothing needs them. Mercado Pago is the
//    one provider whose orders reconcile without any browser return at all
//    (its `searchByReference` runs off our own order number against MP's
//    private-token-authenticated API, and it is the only member of
//    `reconciliation.worker.ts`'s `ACCOUNT_SCOPED_LOOKUP_PROVIDERS`), and no
//    MP return route exists on the storefront. Adding `back_urls` is a
//    self-contained UX improvement for a later change, no longer blocked on
//    anything structural.
//
//    `notification_url` stays omitted on its own merits, unchanged and
//    deliberately: it is the URL MP POSTs the settle notification to, i.e. the
//    verified path that can actually move an order to PAID. It is configured
//    once per application in MP's Integrations Panel today, and moving that
//    live path onto a per-preference value with no sandbox account to verify
//    against risks silently killing webhook delivery — the same call
//    `epayco.ts` makes about its own `confirmation` field.
//
//    Verified this is safe to omit for now, not just convenient: MP's own
//    "configure-back-urls" docs page, fetched directly during this task,
//    never states `back_urls`/`auto_return` are mandatory to create a
//    preference — a preference without them still lets a shopper pay, they
//    just land on Mercado Pago's own generic post-payment page instead of
//    being auto-redirected back to the storefront. And MP's own
//    payment-notifications docs page confirms `notification_url` can
//    instead be configured ONCE, per application, in the Integrations
//    Panel — the exact mechanism this adapter relies on for now, mirroring
//    how Wompi's webhook URL is likewise configured out-of-band in Wompi's
//    own dashboard rather than passed into `createCheckoutSession`. If
//    per-tenant, per-request `notification_url` is ever required (e.g. because
//    panel-level config can't vary per tenant on a shared MP application), the
//    tenant base URL it would be built from is already available on
//    `OrderForPayment.storefrontBaseUrl`; what is missing is a verified
//    public API webhook base and a sandbox account to prove the switch-over
//    doesn't drop deliveries.
const API_BASE = 'https://api.mercadopago.com';

/** `OrderForPayment` carries no currency field — this adapter targets
 * Colombia (COP), matching `wompi.ts`'s identical `CHECKOUT_CURRENCY`
 * rationale. Flagged for the same future reviewer: a non-COP MP market
 * wired through this adapter needs this to become a real parameter. */
const CHECKOUT_CURRENCY = 'COP';

/** Maps Mercado Pago's real payment-status vocabulary onto this codebase's
 * `NormalizedStatus` union. Exact table per design doc decision 5 (see that
 * doc for the full reasoning on the two judgment calls below) — re-verified,
 * not re-derived, during this task:
 *  - `approved` → `PAID`: unambiguous.
 *  - `pending` / `in_process` / `authorized` / `in_mediation` → `PENDING`:
 *    all four are non-final states where nothing has definitively happened
 *    yet.
 *  - `rejected` → `FAILED`: unambiguous.
 *  - `cancelled` → `FAILED` (not `EXPIRED`): a cancelled payment attempt is a
 *    preference that will never be paid — the same real-world category as
 *    Wompi's `DECLINED`/`VOIDED` (already `FAILED`). Mapping it to the
 *    actionable `FAILED` state (webhooks.controller.ts calls `markFailed`)
 *    rather than the silent `PENDING`/`EXPIRED` no-op bucket lets the
 *    merchant/shopper see an accurate status and retry.
 *  - `refunded` / `charged_back` → `EXPIRED`: these represent a PREVIOUSLY
 *    `approved` payment being reversed after the fact — the order may
 *    already be confirmed, decremented, or shipped. Neither `FAILED` (would
 *    misleadingly imply the payment never succeeded) nor any automatic
 *    un-confirm/restock action (no such flow exists yet) is safe, so both
 *    collapse into the same no-op-logged bucket `EXPIRED` already occupies —
 *    durably recorded (a `WebhookEvent` row), never silently auto-mutating a
 *    real order.
 * Any other/future MP status string falls closed to `FAILED`, mirroring
 * `wompi.ts`'s identical "never silently assume PAID" default. */
function mapStatus(mpStatus: string): NormalizedStatus {
  switch (mpStatus) {
    case 'approved':
      return 'PAID';
    case 'pending':
    case 'in_process':
    case 'authorized':
    case 'in_mediation':
      return 'PENDING';
    case 'rejected':
    case 'cancelled':
      return 'FAILED';
    case 'refunded':
    case 'charged_back':
      return 'EXPIRED';
    default:
      return 'FAILED';
  }
}

function requireEventsSecret(cfg: TenantProviderConfig): string {
  if (!cfg.eventsSecret) {
    throw new Error('mercadopago: TenantProviderConfig.eventsSecret is required for this operation');
  }
  return cfg.eventsSecret;
}

/** Parses `x-signature`'s real format, `ts=<value>,v1=<hex-hmac>` (verified
 * directly against a live fetch of the payment-notifications docs page — see
 * the class doc comment for the exact URL and what it did/didn't confirm).
 * Order of the two comma-separated parts is not assumed to be fixed (both
 * observed real examples happened to be `ts` first, but nothing in the docs
 * promises that), so this parses by key, not position. */
function parseXSignature(header: string): { ts: string; v1: string } {
  const parts = header.split(',');
  let ts: string | undefined;
  let v1: string | undefined;
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 'ts') ts = value;
    else if (key === 'v1') v1 = value;
  }
  if (!ts || !v1) {
    throw new Error('mercadopago webhook: x-signature header missing ts or v1');
  }
  return { ts, v1 };
}

/** Case-insensitive header lookup — `RawRequest.headers` is typed as
 * `Record<string, string | string[] | undefined>` without promising a
 * casing convention. Express (this adapter's only real caller today, per
 * `webhooks.controller.ts`) always lowercases incoming header names, but
 * this helper doesn't assume that so it isn't quietly wrong for some future
 * non-Express caller. Returns the first value when a header repeats (as
 * `x-signature`/`x-request-id` never legitimately would). */
function getHeader(headers: RawRequest['headers'], name: string): string | undefined {
  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== lowerName) continue;
    if (Array.isArray(value)) return value[0];
    return value;
  }
  return undefined;
}

/** Builds Mercado Pago's real webhook-signature manifest string:
 * `id:{data.id};request-id:{x-request-id};ts:{ts};` (verified directly, see
 * class doc comment). `requestId` is genuinely optional here: per the design
 * doc's original assumption (re-verification found no official confirmation
 * either way — see class doc comment's "genuinely unresolved" note), a
 * missing `x-request-id` drops the whole `request-id:...;` segment rather
 * than substituting an empty value. */
function buildManifest(dataId: string, requestId: string | undefined, ts: string): string {
  let manifest = `id:${dataId};`;
  if (requestId !== undefined) {
    manifest += `request-id:${requestId};`;
  }
  manifest += `ts:${ts};`;
  return manifest;
}

function timingSafeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  // timingSafeEqual throws on mismatched lengths rather than returning
  // false — an attacker-controlled (or simply wrong) signature of a
  // different length must not crash this method, it must just fail
  // verification like any other mismatch.
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Shape this adapter relies on from `GET /v1/payments/:id`'s real response
 * (verified against the official Node SDK's own compiled response type — see
 * class doc comment). Only the fields this adapter actually reads are
 * declared; the real payload has dozens more. */
interface MercadoPagoPaymentResponse {
  id: number | string;
  status: string;
  transaction_amount: number;
  external_reference: string;
  /** ISO-4217 code (`"COP"`) for `transaction_amount`, on the same payment
   * resource. Declared optional and read defensively (like every other field
   * this adapter takes off a live response) even though a real payment always
   * carries it — `verifyAndParseWebhook` reports it as
   * `NormalizedPaymentEvent.currency` rather than requiring it, so a response
   * shape that ever drops it degrades to "unverifiable" at the controller
   * instead of throwing here. */
  currency_id?: string;
}

/** Shape this adapter relies on from `GET /v1/payments/search`'s real
 * response (verified independently this task — see the class doc comment's
 * "P3c Task 1" section for the exact URL fetched). Only the fields this
 * adapter actually reads from each `results[]` entry are declared; the real
 * payload has dozens more per item (payer, card, transaction_details, ...). */
interface MercadoPagoSearchResult {
  id: number | string;
  status: string;
  date_created?: string;
  date_approved?: string | null;
  /** The SAME two fields `GET /v1/payments/:id` returns (see
   * `MercadoPagoPaymentResponse` above) — both are documented on each
   * `results[]` entry of the search response, and both are optional on MP's
   * own payment type, hence read defensively below. `transaction_amount` is a
   * MAJOR-unit (pesos) decimal, NOT cents. */
  external_reference?: string;
  transaction_amount?: number;
  /** ISO-4217 code (`"COP"`), same field name and vocabulary as on the by-id
   * payment resource — carried here so the search path can report the same
   * currency binding the by-id path does. */
  currency_id?: string;
}

interface MercadoPagoSearchResponse {
  paging?: { total?: number; limit?: number; offset?: number };
  results: MercadoPagoSearchResult[];
}

/** Mercado Pago Checkout Pro payment provider adapter. See the block comment
 * above `API_BASE` for the full list of real-API facts this class relies on
 * and this task's confidence in each (verified / corrected-from-design-doc /
 * genuinely unresolved). */
export class MercadoPagoProvider implements PaymentProvider {
  readonly id = 'mercadopago' as const;

  /** Creates a real Checkout Pro preference via a server-side HTTP call
   * (unlike Wompi's pure-local signed-URL construction — Mercado Pago has no
   * equivalent client-computable redirect scheme). `unit_price` is pesos,
   * not cents (see class doc comment) — this is a single generic line item
   * covering the whole order total, since `OrderForPayment` carries no
   * per-item breakdown for this adapter to build real line items from.
   * `back_urls`/`auto_return`/`notification_url` are deliberately omitted —
   * see the class doc comment's dedicated section on why. */
  async createCheckoutSession(
    order: OrderForPayment,
    cfg: TenantProviderConfig,
    fetchImpl: typeof fetch = fetch,
  ): Promise<{ redirectUrl: string }> {
    const body = {
      items: [
        {
          title: `Order ${order.orderNumber}`,
          unit_price: order.totalCents / 100,
          quantity: 1,
          currency_id: CHECKOUT_CURRENCY,
        },
      ],
      external_reference: order.orderNumber,
    };

    const res = await fetchGateway(
      fetchImpl,
      'mercadopago createCheckoutSession',
      `${API_BASE}/checkout/preferences`,
      {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.privateKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`mercadopago createCheckoutSession: HTTP ${res.status}`);
    }
    const parsed = (await res.json()) as { init_point?: unknown; sandbox_init_point?: unknown };
    const redirectUrl = cfg.sandbox ? parsed.sandbox_init_point : parsed.init_point;
    if (typeof redirectUrl !== 'string') {
      throw new Error(
        'mercadopago createCheckoutSession: malformed response (missing init_point/sandbox_init_point)',
      );
    }
    return { redirectUrl };
  }

  /** Verifies a Mercado Pago webhook's `x-signature` HMAC, then makes the
   * mandatory follow-up `GET /v1/payments/{data.id}` call (the delivered
   * webhook payload itself carries no `status`/`transaction_amount`/
   * `external_reference` — see class doc comment) to build a
   * `NormalizedPaymentEvent`. Throws on any verification failure, same
   * contract as `WompiProvider.verifyAndParseWebhook` (the caller — a
   * webhook controller — is expected to catch and respond 401). */
  async verifyAndParseWebhook(
    req: RawRequest,
    cfg: TenantProviderConfig,
    fetchImpl: typeof fetch = fetch,
  ): Promise<NormalizedPaymentEvent> {
    const eventsSecret = requireEventsSecret(cfg);

    let payload: unknown;
    try {
      payload = JSON.parse(req.rawBody.toString('utf8'));
    } catch {
      throw new Error('mercadopago webhook: request body is not valid JSON');
    }
    if (typeof payload !== 'object' || payload === null) {
      throw new Error('mercadopago webhook: malformed payload');
    }
    const body = payload as Record<string, unknown>;
    const data = body.data as Record<string, unknown> | undefined;
    const dataId = data?.id;
    if (dataId === undefined || dataId === null || (typeof dataId !== 'string' && typeof dataId !== 'number')) {
      throw new Error('mercadopago webhook: missing data.id');
    }
    const dataIdStr = String(dataId);

    const signatureHeader = getHeader(req.headers, 'x-signature');
    if (!signatureHeader) {
      throw new Error('mercadopago webhook: missing x-signature header');
    }
    const { ts, v1 } = parseXSignature(signatureHeader);
    const requestId = getHeader(req.headers, 'x-request-id');

    const manifest = buildManifest(dataIdStr, requestId, ts);
    const computed = createHmac('sha256', eventsSecret).update(manifest, 'utf8').digest('hex');

    if (!timingSafeEqualHex(computed, v1)) {
      throw new Error('mercadopago webhook: signature mismatch');
    }

    // Signature verified — now fetch the actual payment record. The
    // webhook payload itself is deliberately lightweight (just `{type,
    // data: {id}}`, per design doc decision 5) and is never trusted for
    // status/amount/reference, only for WHICH payment id to look up next.
    const res = await fetchGateway(
      fetchImpl,
      'mercadopago webhook',
      `${API_BASE}/v1/payments/${encodeURIComponent(dataIdStr)}`,
      { headers: { Authorization: `Bearer ${cfg.privateKey}` } },
    );
    if (!res.ok) {
      throw new Error(`mercadopago webhook: payment lookup HTTP ${res.status}`);
    }
    const payment = (await res.json()) as Partial<MercadoPagoPaymentResponse>;
    if (
      (typeof payment.id !== 'string' && typeof payment.id !== 'number') ||
      typeof payment.status !== 'string' ||
      typeof payment.transaction_amount !== 'number' ||
      typeof payment.external_reference !== 'string'
    ) {
      throw new Error(
        'mercadopago webhook: malformed payment lookup response (missing id/status/transaction_amount/external_reference)',
      );
    }

    return {
      provider: 'mercadopago',
      // P3 wave-1 fix 3 — this used to be a bare `String(payment.id)`, which
      // was WRONG in the same way Wompi's bare `transaction.id` would have
      // been (hence wompi.ts's own `id:timestamp` composition): MP's
      // `data.id` is the PAYMENT id, not an event id, and MP fires ONE
      // notification per status change on the SAME payment. So the first,
      // still-`pending` delivery claimed the `(provider, tenantId, eventId)`
      // idempotency row in `webhooks.controller.ts`, and the later `approved`
      // delivery — the one that actually settles the order — collided with it
      // and was discarded as a replay: 200 OK, order stuck PENDING/PENDING.
      //
      // Composed from the payment id plus the payment's OWN gateway status
      // (read from the authenticated lookup above, never from the request
      // body), which is exactly the thing that distinguishes those
      // deliveries. Deliberately NOT composed with `x-request-id` or the
      // signature's `ts`: those vary per DELIVERY, so including either would
      // make every genuine MP retry look like a brand-new event and settle
      // the order more than once — the opposite failure. Same-notification
      // redeliveries keep producing an identical id and still dedupe.
      eventId: `${String(payment.id)}:${payment.status}`,
      providerRef: String(payment.id),
      reference: payment.external_reference,
      status: mapStatus(payment.status),
      // Pesos in (createCheckoutSession's unit_price), cents out here —
      // consistent with this codebase's cents-as-source-of-truth
      // convention for every other amount field.
      amountCents: Math.round(payment.transaction_amount * 100),
      // The currency that amount is denominated in, off the SAME authenticated
      // payment resource — so it is exactly as trustworthy as the amount, and
      // the strongest of the three adapters' currency values (Wompi's is
      // unsigned; ePayco's is signed but its corroborating lookup is
      // unauthenticated). `undefined` when absent or not a string, never
      // defaulted to `CHECKOUT_CURRENCY` — a fabricated value would be
      // indistinguishable from a verified one at the controller.
      currency:
        typeof payment.currency_id === 'string' && payment.currency_id.length > 0
          ? payment.currency_id
          : undefined,
    };
  }

  /** Calls Mercado Pago's real payment-lookup endpoint, `GET
   * /v1/payments/:id`, authenticated with the tenant's PRIVATE key (Access
   * Token) as a Bearer token — unlike Wompi, where the equivalent lookup
   * intentionally uses the public key. Shares `mapStatus` with
   * `verifyAndParseWebhook` (same shape as `wompi.ts`'s single `mapStatus`,
   * per the plan).
   *
   * ## Order-binding fields (`reference`/`amountCents`), P3c Task 2
   *
   * **HIGH confidence.** Both come off the SAME payment resource this call
   * already reads, and both were re-verified this task by re-fetching the
   * official Mercado Pago Node SDK's own compiled response type,
   * `unpkg.com/mercadopago/dist/clients/payment/commonTypes.d.ts` (the same
   * source the class doc comment above already cites, since MP's interactive
   * API-reference page still 404s on every locale variant). Its
   * `PaymentResponse` declares, verbatim:
   *  - `external_reference?: string` — "Integrator-supplied external
   *    reference for reconciliation", i.e. exactly the value
   *    `createCheckoutSession` sends as `external_reference:
   *    order.orderNumber`, and exactly what `verifyAndParseWebhook` already
   *    reads as this event's `reference`.
   *  - `transaction_amount?: number` — "Gross amount of the transaction in
   *    the specified currency".
   *
   * **UNITS — get this backwards and every amount check is 10,000x off.**
   * `transaction_amount` is a MAJOR-unit (pesos) decimal, the same
   * convention as `unit_price` on a preference (see the class doc comment's
   * verified note: real MP examples show fractional peso values like `75.56`
   * as `unit_price`, nonsensical as cents). This codebase's own unit is
   * CENTS. So the conversion here MULTIPLIES by 100 — the inverse of
   * `createCheckoutSession`'s `unit_price: order.totalCents / 100`, and
   * identical to what `verifyAndParseWebhook` already does with this very
   * field (`Math.round(payment.transaction_amount * 100)`).
   *
   * Both fields are optional on MP's own type, so both are read defensively
   * and left `undefined` when absent or wrong-typed rather than coerced.
   * Only `status` is required — which is also what keeps
   * `PaymentsService.testConnection`'s deliberately-bogus lookup working. */
  async getTransactionStatus(
    providerRef: string,
    cfg: TenantProviderConfig,
    fetchImpl: typeof fetch = fetch,
  ): Promise<TransactionStatusResult> {
    const res = await fetchGateway(
      fetchImpl,
      'mercadopago getTransactionStatus',
      `${API_BASE}/v1/payments/${encodeURIComponent(providerRef)}`,
      { headers: { Authorization: `Bearer ${cfg.privateKey}` } },
    );
    if (!res.ok) {
      throw new Error(`mercadopago getTransactionStatus: HTTP ${res.status}`);
    }
    const body = (await res.json()) as {
      status?: unknown;
      external_reference?: unknown;
      transaction_amount?: unknown;
      currency_id?: unknown;
    };
    if (typeof body.status !== 'string') {
      throw new Error('mercadopago getTransactionStatus: malformed response (missing status)');
    }
    const rawReference = body.external_reference;
    const rawAmount = body.transaction_amount;
    const rawCurrency = body.currency_id;
    return {
      status: mapStatus(body.status),
      reference: typeof rawReference === 'string' && rawReference.length > 0 ? rawReference : undefined,
      // Pesos in, cents out — see this method's doc comment on units.
      amountCents:
        typeof rawAmount === 'number' && Number.isFinite(rawAmount) ? Math.round(rawAmount * 100) : undefined,
      // MP names this field `currency_id` (not `currency`) on the payment
      // resource, and its value is the plain ISO-4217 code (`"COP"`) — the
      // same vocabulary the other two adapters report, so callers compare one
      // string across all three. Never defaulted; `undefined` when absent.
      currency: typeof rawCurrency === 'string' && rawCurrency.length > 0 ? rawCurrency : undefined,
    };
  }

  /** Calls Mercado Pago's real `GET /v1/payments/search?external_reference=`
   * endpoint (verified independently this task — see the class doc comment's
   * "P3c Task 1" section for the exact URL fetched, the response shape, and
   * why no ordering is assumed from the API's own `results` array order).
   * Used ONLY as a fallback by the reconciliation job for an order that has
   * NO `providerRef` at all yet (design doc decision 5) — every other lookup
   * path still goes through `getTransactionStatus` above, unaffected by this
   * method existing.
   *
   * Multiple payment attempts can share one `external_reference` (a shopper
   * who abandons Checkout Pro once and retries). Picks the most recent
   * `approved` attempt if any exists among `results`; else the most recent
   * attempt of any status. "Most recent" is `date_approved` if present, else
   * `date_created` — sorted client-side here, never trusting the array's own
   * order (the docs page fetched states the sort/criteria params as
   * "REQUIRED" but never documents a default when both are omitted, which is
   * exactly what this call does — see class doc comment). Returns `null` for
   * an empty `results` array. Throws on any non-2xx response, same posture
   * as `getTransactionStatus`/`createCheckoutSession` above — never silently
   * treated as "no match found".
   *
   * ## Order-binding fields + the mismatch filter (P3c review follow-up)
   *
   * Two changes, both about NOT relying on MP's server-side filter as an
   * unverified article of faith:
   *
   * 1. The returned `reference`/`amountCents` come off the CHOSEN result's own
   *    `external_reference`/`transaction_amount` — the gateway's own
   *    assertions, the same two fields `getTransactionStatus` already reads
   *    off the by-id payment resource — so the reconciliation worker can run
   *    the SAME real binding check on this path as on the by-id one, instead
   *    of comparing its own query key to itself. Both are read defensively
   *    and left `undefined` when absent or wrong-typed, never coerced.
   *    **UNITS:** `transaction_amount` is MAJOR units (pesos) and this
   *    codebase stores CENTS, so this multiplies by 100 — identical to
   *    `getTransactionStatus`/`verifyAndParseWebhook` above.
   * 2. Belt and braces: any result whose own `external_reference` does not
   *    EXACTLY equal the reference we searched for is DROPPED before choosing
   *    among them. `external_reference={ref}` is documented as an exact-match
   *    server-side filter, but a query-construction bug here, or MP ever
   *    moving to prefix/fuzzy matching (a search for order `14` returning a
   *    payment for `142`), would otherwise hand the caller a truthful answer
   *    about the WRONG order. A result carrying NO `external_reference` at all
   *    is likewise dropped rather than assumed to match: unverifiable is not
   *    the same as verified, and inventing the value from our own query is
   *    exactly the fabrication this design forbids. An all-dropped result set
   *    is indistinguishable, to the caller, from "no payment exists for this
   *    reference" — `null` — which is the correct, safe outcome either way
   *    (the reconciliation worker leaves such an order completely alone). */
  async searchByReference(
    reference: string,
    cfg: TenantProviderConfig,
    fetchImpl: typeof fetch = fetch,
  ): Promise<ReferenceSearchResult | null> {
    const res = await fetchGateway(
      fetchImpl,
      'mercadopago searchByReference',
      `${API_BASE}/v1/payments/search?external_reference=${encodeURIComponent(reference)}`,
      { headers: { Authorization: `Bearer ${cfg.privateKey}` } },
    );
    if (!res.ok) {
      throw new Error(`mercadopago searchByReference: HTTP ${res.status}`);
    }
    const body = (await res.json()) as Partial<MercadoPagoSearchResponse>;
    const rawResults = Array.isArray(body.results) ? body.results : [];
    // Drop everything the gateway did not itself assert is about THIS
    // reference, BEFORE any selection rule runs — see this method's doc
    // comment. Done first so a mismatched entry can never win by being the
    // most recent or the only `approved` one.
    const results = rawResults.filter((r) => r.external_reference === reference);
    if (results.length === 0) return null;

    const timestampOf = (r: MercadoPagoSearchResult): number => {
      const raw = r.date_approved ?? r.date_created;
      const parsed = raw ? Date.parse(raw) : NaN;
      return Number.isNaN(parsed) ? 0 : parsed;
    };
    // Most-recent-first — never assumes the API's own `results` order (see
    // this method's doc comment on why).
    const sorted = [...results].sort((a, b) => timestampOf(b) - timestampOf(a));

    const mostRecentApproved = sorted.find((r) => r.status === 'approved');
    const chosen = mostRecentApproved ?? sorted[0];

    const rawAmount: unknown = chosen.transaction_amount;
    const rawCurrency: unknown = chosen.currency_id;
    return {
      providerRef: String(chosen.id),
      status: mapStatus(chosen.status),
      // Same defensive read (and same "never fabricate 'COP'" rule) as
      // getTransactionStatus above — the caller's currency binding must be
      // able to fail on this path too, not just on the by-id one.
      currency: typeof rawCurrency === 'string' && rawCurrency.length > 0 ? rawCurrency : undefined,
      // The CHOSEN result's own reference — guaranteed non-empty and equal to
      // `reference` by the filter above, but read off the result rather than
      // echoed from the query so the caller is looking at the gateway's data.
      reference: chosen.external_reference,
      // Pesos in, cents out — see this method's doc comment on units.
      amountCents:
        typeof rawAmount === 'number' && Number.isFinite(rawAmount) ? Math.round(rawAmount * 100) : undefined,
    };
  }

  // `refund` deliberately left unimplemented — same rationale as
  // `wompi.ts`: no refund/void UI or flow exists yet in this codebase, and
  // `PaymentProvider.refund` is optional for exactly this reason.
}
