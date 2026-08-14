export type PaymentProviderId = 'wompi' | 'mercadopago' | 'epayco';

export interface OrderForPayment {
  orderId: string;
  orderNumber: string;
  totalCents: number;
  customerEmail: string;
}

export interface TenantProviderConfig {
  publicKey: string;
  privateKey: string;
  sandbox: boolean;
  // Wompi-specific, added for Task 2 (`wompi.ts`). Verified against Wompi's
  // real docs (docs.wompi.co "Environments and Keys"): `integritySecret` and
  // `eventsSecret` are two DISTINCT dashboard secrets, each with its own
  // sandbox/production key prefix (`test_integrity_`/`prod_integrity_` vs.
  // `test_events_`/`prod_events_`) — neither is derivable from `publicKey` or
  // `privateKey`, and they are not the same secret wearing two names. Both
  // are optional here (not every `PaymentProviderId` needs them — only
  // Wompi's checkout-signing and webhook-checksum schemes do), so a future
  // provider (mercadopago/epayco, P3b) that doesn't use this exact scheme
  // isn't forced to populate fields that mean nothing to it.
  integritySecret?: string;
  eventsSecret?: string;
  // ePayco-specific, added in Task 2 (`mercadopago.ts`) even though ePayco's
  // own adapter doesn't exist until Task 3 — `TenantProviderConfig` is one
  // shared interface file, so widening it happens wherever the next field is
  // discovered to be needed, not gated on the provider that needs it being
  // implemented yet. This is ePayco's merchant-account identifier
  // (`P_CUST_ID_CLIENTE`), the second value ePayco's confirmation-hash
  // formula needs alongside `P_KEY` (which reuses `eventsSecret` — see that
  // field's doc comment above). Deliberately named `epaycoCustomerId`, not a
  // generic `customerId`: this has nothing to do with this codebase's own
  // `Customer` model (a shopper) — it identifies ePayco's *merchant account*,
  // the same conceptual role `publicKey`/`privateKey` play for the other two
  // providers. Optional because only ePayco needs it.
  epaycoCustomerId?: string;
}

export interface RawRequest {
  headers: Record<string, string | string[] | undefined>;
  rawBody: Buffer;
}

export type NormalizedStatus = 'PENDING' | 'PAID' | 'FAILED' | 'EXPIRED';

export interface NormalizedPaymentEvent {
  provider: PaymentProviderId;
  eventId: string;
  providerRef: string;
  // The merchant-side order identifier this event is ABOUT — Wompi's real
  // `transaction.reference` field, which is exactly the same string
  // `WompiProvider.createCheckoutSession` sends as `reference` when it built
  // the checkout redirect (see `createCheckoutSession`: `reference =
  // order.orderNumber`). `providerRef` (above) is Wompi's OWN transaction id,
  // which our side never stores anywhere at checkout time — `reference` is
  // the only field a webhook handler can use to resolve this event back to
  // one of our `Order` rows.
  //
  // Contract for callers (services/api's webhook controller, Task 4/5): this
  // is the PLAIN STRING form of `Order.number` (the Prisma `Int` column),
  // e.g. `String(order.number)` — e.g. `"42"`, NOT the `VNT-`-prefixed
  // display string (`"VNT-000042"`) used in emails/UI. That prefix is purely
  // a display-layer convention from earlier tasks and is never used as a
  // lookup/storage key. A webhook controller resolving this back to an order
  // must do `Number(event.reference)` and look up by `Order.number`, not by
  // any prefixed/formatted string.
  reference: string;
  status: NormalizedStatus;
  amountCents: number;
}

/** The result of a BY-ID transaction-status lookup (`getTransactionStatus`).
 *
 * ## Why this is not just a bare `NormalizedStatus` (P3c Task 2)
 *
 * The webhook path (`verifyAndParseWebhook` -> `NormalizedPaymentEvent`) is
 * safe by construction: the gateway's signature cryptographically binds
 * reference + amount + status together in ONE verified payload, and
 * `services/api/src/payments/webhooks.controller.ts` looks the order up BY
 * that verified `reference`. There is no way to point a verified webhook at
 * an order it isn't about.
 *
 * The by-id path has no such binding on its own. P3c's reconciliation worker
 * calls `getTransactionStatus(order.providerRef, cfg)`, and `providerRef` can
 * arrive from the deliberately-UNAUTHENTICATED provider-ref-hint endpoint
 * (`PATCH v1/storefront/checkout/:orderNumber/provider-ref-hint`). So a
 * shopper holding ONE real, genuinely-PAID transaction id — their own past
 * purchase — could PATCH it onto a DIFFERENT, still-`PENDING` order. Asking
 * the gateway "is transaction X paid?" would then get a perfectly truthful
 * "yes" about a payment that has nothing to do with that order: free-order
 * fraud, no guessing required.
 *
 * `reference` and `amountCents` close that hole. They are the GATEWAY's own
 * record of which merchant reference the transaction is for and how much it
 * was — read out of the gateway's own authenticated response, never supplied
 * by the caller — so a caller can verify the transaction actually belongs to
 * the order (`result.reference === String(order.number)`, and where the
 * amount is available, `result.amountCents === order.totalCents`) BEFORE
 * acting on `status`.
 *
 * Both are OPTIONAL because availability genuinely differs per provider and
 * per response (see each adapter's own doc comment for exactly which fields
 * it populates and at what confidence). An adapter must leave them
 * `undefined` rather than fabricate, coerce, or guess a value — and callers
 * must treat a missing/unverifiable `reference` as "cannot reconcile this
 * order automatically" (log it, leave the order alone), never as "binding
 * check passed".
 */
export interface TransactionStatusResult {
  status: NormalizedStatus;
  /** The gateway's OWN record of the merchant reference this transaction is
   * for — the same value `NormalizedPaymentEvent.reference` carries on the
   * webhook path, i.e. the PLAIN STRING form of `Order.number`
   * (`String(order.number)`, e.g. `"42"`), never the `VNT-`-prefixed display
   * string. `undefined` when this provider's status-lookup response doesn't
   * carry it (or doesn't carry it in the expected type). */
  reference?: string;
  /** The gateway's OWN record of the transaction amount, in CENTS —
   * normalized here even for providers whose APIs speak major units (pesos),
   * matching this codebase's cents-as-source-of-truth convention.
   * `undefined` when unavailable or non-numeric. */
  amountCents?: number;
}

/** The result of a lookup BY OUR OWN merchant reference (`searchByReference`).
 *
 * ## Why this carries `reference`/`amountCents` too (P3c review follow-up)
 *
 * It would be tempting to argue this path needs no binding fields at all: the
 * gateway was asked for payments whose own `external_reference` equals our
 * order number, so whatever comes back is bound "by construction". The
 * reconciliation worker originally relied on exactly that, restating its own
 * query key as the result's `reference` — which made the worker's binding
 * comparison a TAUTOLOGY on this path (it compared a value to itself), left
 * the amount entirely unchecked, and rested the whole guarantee on a
 * server-side filter we document but never verify at runtime. A
 * query-construction bug, or a gateway that ever moves to prefix/fuzzy
 * matching (a search for order `14` returning a payment for `142`), would
 * silently defeat it, and no test could catch the regression.
 *
 * So this shape carries the GATEWAY's own assertions about the chosen
 * transaction, exactly like `TransactionStatusResult` does for the by-id
 * path, and every caller runs the SAME binding check over both. Adapters
 * additionally SHOULD drop non-matching results before choosing among them
 * (see `MercadoPagoProvider.searchByReference`) — belt and braces, not a
 * replacement for the caller's check.
 *
 * Both binding fields are OPTIONAL, matching `TransactionStatusResult`'s
 * existing convention: an adapter that genuinely cannot read one emits
 * `undefined` rather than fabricating a value — and `undefined` must remain a
 * REJECTION at the caller's binding check, never a pass. */
export interface ReferenceSearchResult {
  /** The gateway's OWN transaction id for the chosen attempt — what a later
   * `getTransactionStatus` call, and `Order.providerRef`, would use. */
  providerRef: string;
  status: NormalizedStatus;
  /** The gateway's OWN record of the merchant reference the CHOSEN result is
   * for — same contract as `TransactionStatusResult.reference` (the plain
   * `String(order.number)` form). `undefined` when the response doesn't carry
   * it in the expected type; never the caller's own query key echoed back. */
  reference?: string;
  /** The gateway's OWN record of the chosen result's amount, in CENTS
   * (normalized here even for gateways whose APIs speak major units).
   * `undefined` when unavailable or non-numeric. */
  amountCents?: number;
}

export interface PaymentProvider {
  readonly id: PaymentProviderId;
  createCheckoutSession(order: OrderForPayment, cfg: TenantProviderConfig): Promise<{ redirectUrl: string }>;
  verifyAndParseWebhook(req: RawRequest, cfg: TenantProviderConfig): Promise<NormalizedPaymentEvent>;
  getTransactionStatus(providerRef: string, cfg: TenantProviderConfig): Promise<TransactionStatusResult>;
  refund?(providerRef: string, amountCents: number, cfg: TenantProviderConfig): Promise<void>;
  // P3c, optional (like `refund?` above) — only `MercadoPagoProvider`
  // implements this (its real `/v1/payments/search?external_reference=`
  // endpoint, see mercadopago.ts). Wompi/ePayco have no documented
  // lookup-by-OUR-reference endpoint (design doc's research section), so
  // this stays undefined for both, exactly like `refund?` is undefined for
  // all three today. Used ONLY as a fallback when an order has no
  // `providerRef` at all yet (reconciliation job, P3c Task 4) — resolves to
  // the most relevant of possibly several payment attempts sharing one
  // `reference`, or `null` if none exist.
  searchByReference?(
    reference: string,
    cfg: TenantProviderConfig,
  ): Promise<ReferenceSearchResult | null>;
}

export { WompiProvider } from './wompi.js';
export { MercadoPagoProvider } from './mercadopago.js';
export { EpaycoProvider } from './epayco.js';
