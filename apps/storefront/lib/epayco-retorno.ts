/** Pure decision logic for the ePayco RESPONSE page
 * (`app/pago/epayco-retorno/[orderNumber]/page.tsx`).
 *
 * Extracted out of the component for the same reason `wompi-retorno.ts` is:
 * this app has no React Testing Library, and the established convention is to
 * put the branchy part in a pure `lib/` helper and unit-test THAT, leaving the
 * component as thin, untested-by-design glue.
 *
 * ## What this page is for — and what it is NOT
 *
 * `EpaycoProvider.createCheckoutSession` (packages/payments/src/epayco.ts) now
 * sets the session-create `response` field to
 * `{storefrontBaseUrl}/pago/epayco-retorno/{orderNumber}`, so after the shopper
 * finishes paying on epayco.co their browser lands HERE.
 *
 * That fixes a real dead end. ePayco's `standard` mode does a full-page
 * navigation away from the `/pago/epayco` bridge page, so the widget's
 * `setHooks` callbacks structurally cannot fire (the page is unloaded and every
 * closure dies) — established by reading ePayco's actual shipped
 * `checkout-v2.js`. Until this route existed, the only way back to the order
 * was the manual "Ya pagué, ver mi pedido" link on a page the shopper had
 * already navigated away from; a shopper who didn't click it beforehand was
 * simply stranded on epayco.co.
 *
 * ## The reference: `ref_payco`, and exactly what it is worth
 *
 * ePayco appends its transaction reference to the response URL's QUERY STRING.
 * Verified against ePayco's own first-party sources, not inferred:
 *  - `docs.epayco.com/docs/paginas-de-respuestas` states the shopper is
 *    redirected with `ref_payco` in the URL parameters.
 *  - ePayco's own sample repo `github.com/epayco/resources`:
 *    `onePage/response/response.html` does `getQueryParam('ref_payco')`, and
 *    `epayco-ng6/.../response/response.component.ts` does
 *    `params['ref_payco'] || params['x_ref_payco']` — hence BOTH spellings are
 *    accepted below, `ref_payco` first, exactly as ePayco's own sample does.
 *
 * The captured value is sent to the API's provider-ref-hint endpoint as a
 * best-effort HINT, exactly like the Wompi return page sends Wompi's `?id=`.
 *
 * **It does NOT restore ePayco reconciliation coverage. Read this before
 * assuming otherwise.** A ref captured here is stored with
 * `providerRefSource: 'hint'`, and `reconciliation.worker.ts`'s provenance gate
 * (`ACCOUNT_SCOPED_LOOKUP_PROVIDERS`) REFUSES hint-sourced refs for ePayco,
 * because ePayco's status-lookup endpoint
 * (`secure.epayco.co/validation/v1/reference/{ref}`) is unauthenticated and
 * ignores the caller's credentials — any reference resolves globally, so a
 * truthful "PAID" from it says nothing about money reaching THIS tenant. That
 * gate is deliberate and must not be weakened. An ePayco order whose
 * confirmation webhook never arrives still cannot be settled and still falls
 * through to the 15-minute stock-reservation expiry worker.
 *
 * What the capture IS worth: the shopper gets back to their order, and the ref
 * lands on the order as a support/audit breadcrumb tying it to a real ePayco
 * transaction — the same thing Wompi's hint is worth today, and the mechanism a
 * future merchant-identifier binding would make settle-capable with no change
 * to this page.
 *
 * ePayco's own docs are explicit that this page is never proof of payment:
 * "NOT reliable to validate the final state of the transaction (the user can
 * close the browser or lose connection)" and "parameters can be manipulated by
 * the user".
 */

export function confirmationPathFor(orderNumber: string): string {
  return `/checkout/confirmacion/${encodeURIComponent(orderNumber)}`;
}

export type EpaycoRetornoDecision =
  /** Order number and a usable `ref_payco`: fire the hint PATCH AND navigate.
   * The caller must NOT await the PATCH — see the timing contract below. */
  | { kind: 'navigate-with-hint'; orderNumber: string; providerRef: string; confirmationPath: string }
  /** Order number but no usable reference (ePayco appended none, or the URL was
   * hand-edited): navigate, and skip the PATCH rather than sending an empty
   * `providerRef` the API would just 400. */
  | { kind: 'navigate'; orderNumber: string; confirmationPath: string }
  /** No usable order number at all — a malformed/direct visit. Nothing to
   * navigate to; the page shows a message and a link back to `/carrito`,
   * matching the Wompi return page and the ePayco bridge page. */
  | { kind: 'error' };

/** Picks the transaction reference out of the response page's query string.
 *
 * Accepts both spellings ePayco's own Angular sample accepts, in its order:
 * `ref_payco` first (what `paginas-de-respuestas` and the `onePage` sample
 * both use), then `x_ref_payco`. Blank-after-trim is treated as absent.
 *
 * Exported separately from `decideEpaycoRetorno` so the two-spelling rule is
 * pinned by its own tests — it is the one detail here taken from a sample repo
 * rather than from prose docs, and therefore the one most worth locking down.
 */
export function pickRefPayco(
  refPayco: string | null | undefined,
  xRefPayco: string | null | undefined,
): string | null {
  const primary = (refPayco ?? '').trim();
  if (primary.length > 0) return primary;
  const fallback = (xRefPayco ?? '').trim();
  return fallback.length > 0 ? fallback : null;
}

/** Decides what the response page should do, given the route segment and the
 * two query-param spellings ePayco may use.
 *
 * Values are trimmed, and blank-after-trim is treated as absent: a browser
 * round trip can leave stray whitespace, a whitespace-only ref would produce a
 * PATCH the API rejects, and a whitespace-only order number would produce a
 * broken confirmation link.
 *
 * **Timing contract for the caller (a requirement, not a preference):** on
 * `navigate-with-hint`, the PATCH must be fired as a TRULY INDEPENDENT side
 * effect with its own `.catch()`, and navigation must happen IMMEDIATELY — not
 * sequenced after the PATCH settles, not even via `.finally()`. A slow or
 * hanging hint endpoint must never delay the shopper's redirect. Losing the
 * hint costs a support breadcrumb (see this module's doc comment: it settles
 * nothing for ePayco either way); stalling here costs every shopper their
 * post-payment experience.
 */
export function decideEpaycoRetorno(
  rawOrderNumber: string | null | undefined,
  rawRefPayco: string | null | undefined,
  rawXRefPayco?: string | null | undefined,
): EpaycoRetornoDecision {
  const orderNumber = (rawOrderNumber ?? '').trim();
  if (orderNumber.length === 0) return { kind: 'error' };

  const confirmationPath = confirmationPathFor(orderNumber);

  const providerRef = pickRefPayco(rawRefPayco, rawXRefPayco);
  if (providerRef === null) return { kind: 'navigate', orderNumber, confirmationPath };

  return { kind: 'navigate-with-hint', orderNumber, providerRef, confirmationPath };
}
