/** Thrown by an adapter's `sendText` when the provider rejects the send.
 *
 * Carries the provider and the HTTP status because the two failures an
 * operator actually has to tell apart — "the token expired" (401) and "the
 * shopper's number is not on WhatsApp" (400-with-a-body) — are otherwise
 * indistinguishable in a log line. */
export class WhatsAppError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`${provider} sendText failed: HTTP ${status} ${body.slice(0, 200)}`);
    this.name = 'WhatsAppError';
  }
}
