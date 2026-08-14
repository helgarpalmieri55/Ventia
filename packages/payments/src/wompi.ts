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
import { resolveStorefrontBase } from './storefront-base.js';

// --- Facts below are cited in the Task 2 report as verified-against-real-docs
// vs. inferred. Summary (see full citations in the commit body / task
// report): checkout redirect base URL, integrity-signature formula,
// transaction API base URLs + key prefixes, transaction status vocabulary,
// and the webhook checksum formula were all fetched from docs.wompi.co pages
// (or Wompi-docs mirrors returned by web search) during this task, not
// recalled from training data alone.

/** Wompi's hosted "Web Checkout" redirect target. Same URL for both sandbox
 * and production — the environment is signaled entirely by which key prefix
 * (`pub_test_...` vs. `pub_prod_...`) is passed in `public-key`, not by a
 * different checkout host. Source: docs.wompi.co "Widget & Checkout Web". */
const CHECKOUT_URL = 'https://checkout.wompi.co/p/';

/** Wompi's main payments API base URLs (distinct from the unrelated
 * Payouts/third-party-payments product, which lives under
 * api(.sandbox).payouts.wompi.co and is NOT what this adapter talks to).
 * Source: docs.wompi.co "Environments and Keys". */
const PRODUCTION_API_BASE = 'https://production.wompi.co/v1';
const SANDBOX_API_BASE = 'https://sandbox.wompi.co/v1';

/** `OrderForPayment` (packages/payments/src/index.ts) carries no currency
 * field — this adapter is Colombia-only Wompi, whose checkout only supports
 * COP, so it's hardcoded rather than threaded through as a parameter nobody
 * populates yet. Flagged for a reviewer: if a future non-COP Wompi market is
 * ever wired through this same adapter, this constant needs to become a real
 * parameter. */
const CHECKOUT_CURRENCY = 'COP';

/** Builds the `redirect-url` Wompi sends the shopper's browser back to after
 * checkout (P3c Task 2, design decision 2's second bullet).
 *
 * ## Why the order number is in the PATH and NOT a query param
 *
 * Wompi appends `?id={transactionId}` to whatever `redirect-url` it is given
 * (verified on docs.wompi.co "Widget & Checkout Web", Step 4: given
 * `https://mystore.com.co/payments/result`, the shopper returns to
 * `https://mystore.com.co/payments/result?id=01-1531231271-19365`). Every
 * example Wompi documents appends onto a URL with NO existing query string,
 * and nothing in the docs says whether it checks for an existing `?` and
 * switches to `&`. So a `redirect-url` of `.../wompi-retorno?orderNumber=123`
 * could plausibly come back as `.../wompi-retorno?orderNumber=123?id=abc` —
 * which parses as ONE param whose value is the string `"123?id=abc"`,
 * silently breaking BOTH values at once and taking the whole return-capture
 * mechanism with it.
 *
 * Putting the order number in a path SEGMENT removes the ambiguity entirely
 * instead of betting on undocumented behavior: whatever Wompi appends, the
 * path is already terminated, so `id` is the only query param that can ever
 * exist here and both values stay independently extractable. The storefront
 * route that receives this is
 * `apps/storefront/app/pago/wompi-retorno/[orderNumber]/page.tsx`; the
 * `test/wompi.test.ts` block that simulates Wompi's own append is the
 * regression test for exactly this reasoning.
 *
 * Per Wompi's own explicit warning on that same docs page ("Do not use the
 * redirection as a validation method of your transactions, only for
 * informative purposes for your users"), the transaction id that comes back
 * this way is NEVER proof of payment. It is only a HINT telling reconciliation
 * WHICH transaction to look up through Wompi's own authenticated API — whose
 * response's `reference`/`amount_in_cents` must then be matched against the
 * order (see `getTransactionStatus` below and `TransactionStatusResult`). */
function buildRedirectUrl(orderNumber: string): string {
  return `${resolveStorefrontBase()}/pago/wompi-retorno/${encodeURIComponent(orderNumber)}`;
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Constant-time comparison of two hex digests — byte-for-byte identical to
 * `mercadopago.ts`'s and `epayco.ts`'s own helpers of the same name, and
 * adopted here (P3 wave-1 fix 7) purely for consistency across the three
 * adapters: the previous `computed !== checksum` was not practically
 * exploitable over a network against a SHA-256 hex digest, but there is no
 * reason for one of three webhook verifiers to be the odd one out.
 *
 * `timingSafeEqual` THROWS on mismatched lengths rather than returning false,
 * so an attacker-controlled (or simply truncated) checksum of a different
 * length must be length-guarded here — it has to fail verification like any
 * other mismatch, never crash the caller. */
function timingSafeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Resolves a dot-separated path (e.g. "transaction.status") against a
 * nested object — mirrors how each entry in a Wompi webhook's
 * `signature.properties` array names a field inside the event's `data`
 * object. Returns `undefined` for any missing segment instead of throwing,
 * so a malformed/unexpected payload fails signature verification (wrong
 * checksum) rather than crashing with a TypeError. */
function readPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc == null || typeof acc !== 'object') return undefined;
    return (acc as Record<string, unknown>)[key];
  }, obj);
}

/** Maps Wompi's own transaction status vocabulary onto this codebase's
 * `NormalizedStatus` union (`'PENDING' | 'PAID' | 'FAILED' | 'EXPIRED'`).
 *
 * Wompi's real status vocabulary (confirmed against docs.wompi.co /
 * "Transaction Handling"): a transaction is always created `PENDING`, and
 * reaches exactly one final state: `APPROVED`, `DECLINED`, `VOIDED`, or
 * `ERROR`. There is no Wompi status equivalent to `EXPIRED` — an unpaid
 * checkout *link* can itself expire (via the optional `expiration-time`
 * checkout param, unused by this adapter since `OrderForPayment` doesn't
 * carry a deadline), but that's enforced before a transaction record exists
 * at all, not a status Wompi ever reports back for a transaction id. So
 * `EXPIRED` is simply unreachable from this mapping — a deliberate choice,
 * not an oversight.
 *
 * Mapping decisions for the three non-`APPROVED` final states, all of which
 * collapse to `FAILED`:
 * - `DECLINED`: the payment attempt was rejected — unambiguously `FAILED`.
 * - `ERROR`: an internal/processor error on that specific attempt —
 *   unambiguously `FAILED`.
 * - `VOIDED`: an already-`APPROVED` transaction that was later annulled
 *   (Wompi docs: applies to card transactions). This is the one genuine
 *   judgment call: `VOIDED` isn't quite the same as "declined at checkout",
 *   but P3a has no refund/void-handling flow (the design doc explicitly
 *   scopes `refund` out — see `WompiProvider.refund` below), so from this
 *   storefront's point of view a voided transaction is, right now, simply an
 *   order that did not end up paid. Mapping it to `FAILED` is the safe
 *   choice: it will never cause stock to be released as "paid" for an order
 *   Wompi has annulled. If refund/void handling is added later, this is the
 *   line to revisit first. */
function mapStatus(wompiStatus: string): NormalizedStatus {
  switch (wompiStatus) {
    case 'APPROVED':
      return 'PAID';
    case 'PENDING':
      return 'PENDING';
    case 'DECLINED':
    case 'VOIDED':
    case 'ERROR':
      return 'FAILED';
    default:
      // Unrecognized/future Wompi status string: fail closed (treat as
      // FAILED, never silently as PAID) rather than assume forward
      // compatibility with a vocabulary we haven't verified.
      return 'FAILED';
  }
}

function requireSecret(cfg: TenantProviderConfig, field: 'integritySecret' | 'eventsSecret'): string {
  const value = cfg[field];
  if (!value) {
    throw new Error(`wompi: TenantProviderConfig.${field} is required for this operation`);
  }
  return value;
}

/** Wompi payment provider adapter (Colombia hosted "Web Checkout").
 *
 * Real-API facts this class relies on, and how confident this task is in
 * each (full detail in the Task 2 report / commit body):
 *  - Checkout is a signed *redirect URL*, not a server-created session —
 *    verified.
 *  - Integrity signature = `SHA256(reference + amountInCents + currency +
 *    integritySecret)` hex — verified.
 *  - Webhook checksum lives in the JSON body at `signature.checksum` (also
 *    mirrored onto an `X-Event-Checksum` HTTP header, per docs, but this
 *    adapter verifies the body copy since that's self-contained and doesn't
 *    depend on header propagation through any proxy in front of the webhook
 *    receiver) — verified.
 *  - Webhook checksum formula = `SHA256(concat(values of signature.properties
 *    paths, in the order given) + timestamp + eventsSecret)` — verified, and
 *    deliberately NOT hardcoding a fixed property list, since Wompi's docs
 *    say the properties array can vary per event/over time.
 *  - `GET /transactions/:id` needs `Authorization: Bearer <publicKey>` (the
 *    *public* key, not the private key) and returns `{ data: { status, ... } }`
 *    — verified for the auth scheme; the exact response envelope shape
 *    originally came from a search-engine-summarized doc excerpt rather than
 *    a directly-read page, so it was flagged lower-confidence here.
 *    **RESOLVED in P3c Task 2**: the raw
 *    `docs.wompi.co/en/docs/colombia/transacciones/` page was fetched and
 *    read directly this task, and its verbatim "Check transaction status"
 *    response example confirms the `{ data: { id, reference, status,
 *    amount_in_cents, currency, payment_method_type, status_message } }`
 *    envelope — see `getTransactionStatus`'s own doc comment for the quoted
 *    example and what it means for the order-binding fields.
 *  - `redirect-url` is a real, OPTIONAL Web Checkout param and Wompi appends
 *    `?id={transactionId}` to it on return — verified this task by reading
 *    `docs.wompi.co/en/docs/colombia/widget-checkout-web/` Step 4 + its
 *    optional-parameters list directly. See `buildRedirectUrl` below.
 */
export class WompiProvider implements PaymentProvider {
  readonly id = 'wompi' as const;

  private apiBase(cfg: TenantProviderConfig): string {
    return cfg.sandbox ? SANDBOX_API_BASE : PRODUCTION_API_BASE;
  }

  /** Builds Wompi's signed checkout redirect URL. No HTTP call is made here —
   * confirmed against Wompi's real Web Checkout docs, there is no
   * server-side "create session" endpoint; the checkout URL's query string
   * (including the integrity signature) is computed entirely locally. */
  async createCheckoutSession(
    order: OrderForPayment,
    cfg: TenantProviderConfig,
  ): Promise<{ redirectUrl: string }> {
    const integritySecret = requireSecret(cfg, 'integritySecret');
    const reference = order.orderNumber;
    const amountInCents = order.totalCents;
    const signature = sha256Hex(`${reference}${amountInCents}${CHECKOUT_CURRENCY}${integritySecret}`);

    const params = new URLSearchParams({
      'public-key': cfg.publicKey,
      currency: CHECKOUT_CURRENCY,
      'amount-in-cents': String(amountInCents),
      reference,
      'signature:integrity': signature,
      // P3c Task 2: optional per Wompi's docs, and deliberately added AFTER
      // the signature is computed above — Wompi's real integrity formula is
      // SHA256(reference + amountInCents + currency + integritySecret) and
      // has no redirect-url term, so this addition cannot and does not
      // change any previously-produced signature. See buildRedirectUrl's doc
      // comment for why the order number rides in the path, not a query param.
      'redirect-url': buildRedirectUrl(reference),
    });

    return { redirectUrl: `${CHECKOUT_URL}?${params.toString()}` };
  }

  /** Verifies and parses a Wompi webhook ("event") payload. Reads the
   * checksum out of the JSON body (`signature.checksum`), not
   * `req.headers` — Wompi's real events scheme places the checksum inside
   * the payload itself (mirrored onto an `X-Event-Checksum` header too, but
   * the body copy is what's verified here; see class doc comment). This is
   * a deliberate departure from `RawRequest`'s header-centric framing implied
   * by its shape (`headers` + `rawBody`) — `rawBody` is used, `headers` is
   * not, because Wompi's real scheme doesn't require the header at all.
   *
   * Throws on any verification failure (malformed JSON, missing signature
   * fields, or a checksum mismatch) rather than returning a sentinel —
   * `PaymentProvider`'s own doc-free signature just declares a resolved
   * `NormalizedPaymentEvent`, so "reject" has to be a rejected promise; the
   * caller (a webhook controller, per the design doc) is expected to catch
   * this and respond 401. */
  async verifyAndParseWebhook(req: RawRequest, cfg: TenantProviderConfig): Promise<NormalizedPaymentEvent> {
    const eventsSecret = requireSecret(cfg, 'eventsSecret');

    let event: unknown;
    try {
      event = JSON.parse(req.rawBody.toString('utf8'));
    } catch {
      throw new Error('wompi webhook: request body is not valid JSON');
    }

    if (typeof event !== 'object' || event === null) {
      throw new Error('wompi webhook: malformed payload');
    }
    const body = event as Record<string, unknown>;
    const signature = body.signature as Record<string, unknown> | undefined;
    const properties = signature?.properties;
    const checksum = signature?.checksum;
    const timestamp = body.timestamp;

    if (
      !Array.isArray(properties) ||
      typeof checksum !== 'string' ||
      (typeof timestamp !== 'number' && typeof timestamp !== 'string')
    ) {
      throw new Error('wompi webhook: missing signature.properties, signature.checksum, or timestamp');
    }

    // KNOWN, DELIBERATE WEAKNESS OF WOMPI'S OWN FORMULA (P3 wave-1 fix 2).
    // The values are concatenated with NO delimiter — that is Wompi's
    // documented formula, so this implementation follows it — which means
    // adjacent numeric fields ALIAS: `(id, status, 50000000, 1042)` and
    // `(id, status, 5000000010, 42)` concatenate to the same bytes and
    // therefore share one valid checksum. An attacker holding one genuine
    // 500,000-COP event's checksum can re-split it into a different
    // (amount, reference) pair that a signature check alone cannot tell apart.
    // Changing the hash is not an option (it must match what Wompi computes),
    // so the defense lives one layer up: `webhooks.controller.ts` refuses to
    // settle unless `event.amountCents` equals the resolved order's
    // `totalCents`, which makes every re-split point at an order whose total
    // doesn't match. See that controller's amount check and the
    // `(50000000, 1042)` / `(5000000010, 42)` regression test in
    // services/api/test/webhooks.test.ts.
    const data = body.data;
    const concatenatedValues = properties.map((path) => {
      const value = readPath(data, String(path));
      return value === undefined || value === null ? '' : String(value);
    });
    const computed = sha256Hex(`${concatenatedValues.join('')}${timestamp}${eventsSecret}`);

    if (!timingSafeEqualHex(computed, checksum)) {
      throw new Error('wompi webhook: signature mismatch');
    }

    // Defense-in-depth: `properties` naming a field is what actually binds
    // its value into `checksum` above — a valid checksum only proves the
    // FIELDS LISTED IN `properties` weren't tampered with, not any other
    // field in the payload. Wompi's docs say the properties list "can vary
    // per event," so without this check, an event whose `properties` array
    // happened to omit one of the fields this method reads below (e.g. a
    // future/unexpected event type that signs only `transaction.id`) would
    // let `transaction.status`/`amount_in_cents` be read and trusted even
    // though nothing cryptographically verified them. Every field this
    // method relies on below must be explicitly present in the SIGNED list.
    const requiredSignedPaths = [
      'transaction.id',
      'transaction.status',
      'transaction.amount_in_cents',
      // Added alongside the `reference` field on `NormalizedPaymentEvent`
      // (Task 4 fix to Task 2's shipped interface): `reference` is now a
      // field this method relies on to route the event to the correct
      // order, so — for the identical defense-in-depth reason as the other
      // three entries above — it must be cryptographically bound by the
      // checksum too, not just conveniently present in the payload.
      'transaction.reference',
    ];
    const stringProperties = properties.map((path) => String(path));
    const missingFromSignature = requiredSignedPaths.filter((path) => !stringProperties.includes(path));
    if (missingFromSignature.length > 0) {
      throw new Error(
        `wompi webhook: signature.properties doesn't cover required field(s): ${missingFromSignature.join(', ')}`,
      );
    }

    const transaction = (data as Record<string, unknown> | undefined)?.transaction as
      | Record<string, unknown>
      | undefined;
    if (!transaction || typeof transaction.id !== 'string' || typeof transaction.status !== 'string') {
      throw new Error('wompi webhook: missing data.transaction.id/status');
    }
    const amountInCents = transaction.amount_in_cents;
    if (typeof amountInCents !== 'number') {
      throw new Error('wompi webhook: missing data.transaction.amount_in_cents');
    }
    // `reference` is Wompi's real transaction `reference` field — the exact
    // same string `createCheckoutSession` sent as `reference: order.orderNumber`
    // when it built the checkout redirect. Same rigor as the other required
    // fields above: reject rather than silently substitute/omit if it's
    // missing or not a string, since this is now the field a webhook
    // controller relies on to resolve which Order this event is about.
    const reference = transaction.reference;
    if (typeof reference !== 'string') {
      throw new Error('wompi webhook: missing data.transaction.reference');
    }
    // `data.transaction.currency` — the currency `amount_in_cents` above is
    // denominated in, sitting right beside it in Wompi's real payload (the
    // documented `transaction.updated` example carries `"currency": "COP"`),
    // and the same field this adapter's own by-id lookup already reads.
    //
    // NOT added to `requiredSignedPaths` above, deliberately: Wompi decides
    // what `signature.properties` contains and its documented list does not
    // include `transaction.currency`, so requiring it would reject every
    // genuine event. The consequence is stated plainly on
    // `NormalizedPaymentEvent.currency`: for Wompi this value is UNSIGNED and
    // therefore forgeable, so the controller's currency check is a
    // consistency check on honest traffic here rather than a forgery barrier
    // — the amount check is what actually stops a re-split/re-pointed event.
    // It is still worth reading: an honest USD transaction (which this
    // Colombia-only integration should never produce, but nothing in the
    // protocol prevents) is caught, and the check costs nothing.
    //
    // Not a string / absent -> `undefined`, never a fabricated `'COP'`: a
    // default would be indistinguishable from a verified value at the caller,
    // which is the one thing the whole currency term exists to prevent.
    const rawCurrency = transaction.currency;
    const currency = typeof rawCurrency === 'string' && rawCurrency.length > 0 ? rawCurrency : undefined;

    return {
      provider: 'wompi',
      // Wompi's real event payload has no dedicated unique event id field
      // (verified: not present in the documented `transaction.updated`
      // example) — `transaction.id` alone isn't sufficient on its own since
      // the same transaction fires multiple events as its status changes
      // (e.g. PENDING then APPROVED), so this composes `transaction.id` with
      // `timestamp` to get an id that's stable for true redelivery replays
      // (same transaction, same timestamp) but distinct across genuinely
      // different status-change events for the same transaction. This
      // composition is inferred, not something Wompi's docs prescribe.
      eventId: `${transaction.id}:${timestamp}`,
      providerRef: transaction.id,
      reference,
      status: mapStatus(transaction.status),
      amountCents: amountInCents,
      currency,
    };
  }

  /** Calls Wompi's real transaction-status endpoint, `GET
   * /transactions/:id`, authenticated with the tenant's *public* key as a
   * Bearer token (verified: this lookup is intentionally public-readable by
   * design in Wompi's API, it does not need the private key).
   *
   * ## Order-binding fields (`reference`/`amountCents`), P3c Task 2
   *
   * **HIGH confidence, verified this task by fetching the raw
   * docs.wompi.co page rather than a search-engine summary** — which also
   * settles the class doc comment's own long-standing caveat that this
   * endpoint's response envelope had only ever been read second-hand.
   * `docs.wompi.co/en/docs/colombia/transacciones/` ("Check transaction
   * status") documents this exact call and shows its verbatim response
   * example:
   *
   * ```json
   * { "data": { "id": "1292-1602113476-10985", "reference": "ORDER-2024-001",
   *   "status": "APPROVED", "amount_in_cents": 50000, "currency": "COP",
   *   "payment_method_type": "CARD", "status_message": "Transaction approved" } }
   * ```
   *
   * So `data.reference` and `data.amount_in_cents` sit on the SAME object as
   * `data.status` — corroborated independently by this adapter's own
   * `verifyAndParseWebhook`, which already reads `transaction.reference` and
   * `transaction.amount_in_cents` off Wompi's transaction object on the
   * webhook side. `reference` is the exact string `createCheckoutSession`
   * sent as `reference: order.orderNumber`, and `amount_in_cents` is already
   * in CENTS (Wompi's native unit — no conversion, unlike Mercado Pago's and
   * ePayco's peso-denominated amounts).
   *
   * Both are read defensively and left `undefined` if absent or wrong-typed,
   * never coerced: `status` is the only field this method requires. That
   * matters for `PaymentsService.testConnection`, whose whole job is to make
   * a deliberately-bogus lookup and report only whether the call itself
   * worked. */
  async getTransactionStatus(
    providerRef: string,
    cfg: TenantProviderConfig,
    fetchImpl: typeof fetch = fetch,
  ): Promise<TransactionStatusResult> {
    const res = await fetchImpl(`${this.apiBase(cfg)}/transactions/${encodeURIComponent(providerRef)}`, {
      headers: { Authorization: `Bearer ${cfg.publicKey}` },
    });
    if (!res.ok) {
      throw new Error(`wompi getTransactionStatus: HTTP ${res.status}`);
    }
    const body = (await res.json()) as {
      data?: { status?: unknown; reference?: unknown; amount_in_cents?: unknown; currency?: unknown };
    };
    const status = body.data?.status;
    if (typeof status !== 'string') {
      throw new Error('wompi getTransactionStatus: malformed response (missing data.status)');
    }
    const rawReference = body.data?.reference;
    const rawAmount = body.data?.amount_in_cents;
    const rawCurrency = body.data?.currency;
    return {
      status: mapStatus(status),
      reference: typeof rawReference === 'string' && rawReference.length > 0 ? rawReference : undefined,
      // Already cents (Wompi's own unit) — passed through, not scaled.
      amountCents: typeof rawAmount === 'number' && Number.isFinite(rawAmount) ? rawAmount : undefined,
      // `data.currency` sits alongside `data.amount_in_cents` on Wompi's
      // transaction resource and is the same ISO-4217 code
      // `createCheckoutSession` sends outbound as `CHECKOUT_CURRENCY`. Read
      // defensively and left `undefined` rather than defaulted to `'COP'` —
      // a fabricated currency would defeat the caller's check silently.
      currency: typeof rawCurrency === 'string' && rawCurrency.length > 0 ? rawCurrency : undefined,
    };
  }

  // `refund` deliberately left unimplemented: P3a's design doc explicitly
  // scopes refunds out (no refund/void UI or flow exists yet), and
  // `PaymentProvider.refund` is optional (`refund?`) for exactly this reason
  // — omitting it entirely is a valid implementation of the interface.
}
