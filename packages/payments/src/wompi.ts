import { createHash } from 'node:crypto';
import type {
  NormalizedPaymentEvent,
  NormalizedStatus,
  OrderForPayment,
  PaymentProvider,
  RawRequest,
  TenantProviderConfig,
} from './index.js';

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

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
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
 *    — verified for the auth scheme; the exact response envelope shape came
 *    from a search-engine-summarized doc excerpt rather than a page this
 *    task fetched and read directly, so it's lower-confidence — flagged for
 *    reviewer double-check against a real sandbox response before shipping.
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

    const data = body.data;
    const concatenatedValues = properties.map((path) => {
      const value = readPath(data, String(path));
      return value === undefined || value === null ? '' : String(value);
    });
    const computed = sha256Hex(`${concatenatedValues.join('')}${timestamp}${eventsSecret}`);

    if (computed !== checksum) {
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
    };
  }

  /** Calls Wompi's real transaction-status endpoint, `GET
   * /transactions/:id`, authenticated with the tenant's *public* key as a
   * Bearer token (verified: this lookup is intentionally public-readable by
   * design in Wompi's API, it does not need the private key). */
  async getTransactionStatus(
    providerRef: string,
    cfg: TenantProviderConfig,
    fetchImpl: typeof fetch = fetch,
  ): Promise<NormalizedStatus> {
    const res = await fetchImpl(`${this.apiBase(cfg)}/transactions/${encodeURIComponent(providerRef)}`, {
      headers: { Authorization: `Bearer ${cfg.publicKey}` },
    });
    if (!res.ok) {
      throw new Error(`wompi getTransactionStatus: HTTP ${res.status}`);
    }
    const body = (await res.json()) as { data?: { status?: unknown } };
    const status = body.data?.status;
    if (typeof status !== 'string') {
      throw new Error('wompi getTransactionStatus: malformed response (missing data.status)');
    }
    return mapStatus(status);
  }

  // `refund` deliberately left unimplemented: P3a's design doc explicitly
  // scopes refunds out (no refund/void UI or flow exists yet), and
  // `PaymentProvider.refund` is optional (`refund?`) for exactly this reason
  // — omitting it entirely is a valid implementation of the interface.
}
