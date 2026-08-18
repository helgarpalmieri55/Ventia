/**
 * Thrown when a webhook could NOT BE VERIFIED — as distinct from a webhook
 * that was verified and found invalid.
 *
 * ## Why the distinction is load-bearing
 *
 * `verifyAndParseWebhook` has two very different ways to fail, and the
 * controller previously answered both with `401 WEBHOOK_INVALID_SIGNATURE`:
 *
 *  1. **The signature is wrong.** A permanent, self-contained verdict about
 *     the bytes the gateway sent. Retrying cannot change it. 401 is right.
 *  2. **We could not reach the gateway to complete the check.** ePayco's
 *     confirmation signature covers neither the payment status nor the order
 *     reference (see epayco.ts), so the adapter re-reads both from ePayco's
 *     own record via an authenticated lookup — mid-verification. A timeout,
 *     a 5xx, or a DNS failure on that lookup says nothing whatsoever about
 *     the signature.
 *
 * Answering (2) with 401 tells the gateway "your signature was wrong" about a
 * delivery whose signature may be perfectly good. Gateways retry either way,
 * so a single occurrence is survivable — but a payment provider that sees an
 * endpoint returning 401 repeatedly may disable the webhook, which converts a
 * transient network blip into silently unsettled payments. It also sends
 * whoever reads the logs looking for a credential or key-rotation problem that
 * does not exist.
 *
 * So: adapters throw THIS for "I could not complete the check", and a plain
 * `Error` for "the check failed". The controller maps this one to 503 —
 * explicitly retryable, no `WebhookEvent` row written (the throw happens
 * before the insert), so the gateway's own retry reprocesses the delivery from
 * scratch.
 *
 * Deliberately NOT used for a malformed body or a missing field: those are
 * verdicts about the delivery itself, and retrying an unparseable payload
 * produces the same unparseable payload.
 */
export class WebhookVerificationUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'WebhookVerificationUnavailableError';
  }
}
