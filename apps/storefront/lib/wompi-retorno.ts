/** Pure decision logic for the Wompi return-capture page
 * (`app/pago/wompi-retorno/[orderNumber]/page.tsx`, P3c Task 2).
 *
 * Extracted out of the component on purpose: this app has no React Testing
 * Library, and the established convention here (see `checkout-form.ts` and
 * P2b Task 7's precedent) is to put the branchy part in a pure `lib/` helper
 * and unit-test THAT, leaving the component as thin, untested-by-design glue.
 *
 * ## What this page is for
 *
 * `WompiProvider.createCheckoutSession` (packages/payments/src/wompi.ts)
 * registers `redirect-url = {storefrontBase}/pago/wompi-retorno/{orderNumber}`
 * — the order number in a PATH segment, with no query string of its own,
 * because Wompi appends `?id={transactionId}` to whatever URL it was given
 * and its docs never show (or promise) correct behavior when a query string
 * is already present. So this page receives `orderNumber` from the route
 * segment and `id` as the only query param.
 *
 * Per Wompi's own docs ("Do not use the redirection as a validation method
 * of your transactions, only for informative purposes for your users"), that
 * `id` is NEVER proof of payment. It is forwarded to the API purely as a
 * HINT of which transaction the reconciliation job should look up through
 * Wompi's own authenticated API — which then re-verifies that the
 * transaction's own `reference`/amount match the order before settling
 * anything.
 */

export function confirmationPathFor(orderNumber: string): string {
  return `/checkout/confirmacion/${encodeURIComponent(orderNumber)}`;
}

export type WompiRetornoDecision =
  /** Both values present: fire the hint PATCH AND navigate. The caller must
   * NOT await the PATCH — see this type's usage note below. */
  | { kind: 'navigate-with-hint'; orderNumber: string; providerRef: string; confirmationPath: string }
  /** Order number but no usable transaction id (Wompi didn't append one, or
   * the shopper hand-edited the URL): navigate, and skip the PATCH entirely
   * rather than sending an empty `providerRef` the API would just 400. */
  | { kind: 'navigate'; orderNumber: string; confirmationPath: string }
  /** No usable order number at all — a malformed/direct visit. Nothing to
   * navigate to; the page shows a message and a link back to `/carrito`,
   * matching the ePayco bridge page's own missing-param branch. */
  | { kind: 'error' };

/** Decides what the return page should do, given the two raw values it can
 * read (route segment + query param), either of which may be missing.
 *
 * Values are trimmed, and blank-after-trim is treated as absent: a browser
 * round trip can leave stray whitespace, and a whitespace-only `id` would
 * produce a PATCH the API rejects while a whitespace-only `orderNumber`
 * would produce a broken confirmation link.
 *
 * **Timing contract for the caller (this is a requirement, not a
 * preference):** on `navigate-with-hint`, the PATCH must be fired as a
 * TRULY INDEPENDENT side effect with its own `.catch()`, and navigation must
 * happen IMMEDIATELY — not sequenced after the PATCH settles, not even via
 * `.finally()`. A slow or hanging hint endpoint must never delay the
 * shopper's redirect to their confirmation page. The hint is best-effort by
 * design: losing it costs at most one order's automatic reconciliation,
 * whereas stalling here costs every shopper their post-payment experience.
 */
export function decideWompiRetorno(
  rawOrderNumber: string | null | undefined,
  rawId: string | null | undefined,
): WompiRetornoDecision {
  const orderNumber = (rawOrderNumber ?? '').trim();
  if (orderNumber.length === 0) return { kind: 'error' };

  const confirmationPath = confirmationPathFor(orderNumber);

  const providerRef = (rawId ?? '').trim();
  if (providerRef.length === 0) return { kind: 'navigate', orderNumber, confirmationPath };

  return { kind: 'navigate-with-hint', orderNumber, providerRef, confirmationPath };
}
