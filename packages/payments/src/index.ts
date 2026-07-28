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
