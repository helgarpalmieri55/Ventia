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

export interface PaymentProvider {
  readonly id: PaymentProviderId;
  createCheckoutSession(order: OrderForPayment, cfg: TenantProviderConfig): Promise<{ redirectUrl: string }>;
  verifyAndParseWebhook(req: RawRequest, cfg: TenantProviderConfig): Promise<NormalizedPaymentEvent>;
  getTransactionStatus(providerRef: string, cfg: TenantProviderConfig): Promise<NormalizedStatus>;
  refund?(providerRef: string, amountCents: number, cfg: TenantProviderConfig): Promise<void>;
}

export { WompiProvider } from './wompi.js';
