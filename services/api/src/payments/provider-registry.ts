import { HttpException } from '@nestjs/common';
import { WompiProvider, type PaymentProvider, type PaymentProviderId } from '@ventia/payments';

/**
 * The concrete provider registry. `PaymentProviderId` (packages/payments/src/
 * index.ts) is a 3-member union (`'wompi' | 'mercadopago' | 'epayco'`), but
 * only `wompi` has a real `PaymentProvider` implementation as of P3a — P3b's
 * job is to add `mercadopago`/`epayco` entries.
 *
 * Deliberately typed `Partial<Record<PaymentProviderId, PaymentProvider>>`,
 * NOT the design doc's literal `Record<PaymentProviderId, PaymentProvider>`
 * snippet: a full `Record` would force this file to either fabricate fake
 * `mercadopago`/`epayco` entries (worse than useless — a caller could
 * accidentally exercise them) or fight the type checker with an `as` cast
 * that defeats the whole point of the exhaustiveness check. `Partial` is
 * honest about "not every provider id has an implementation yet" and pushes
 * the "is this one actually configured" question to `getProvider` below,
 * which is exactly where callers (this task's `PaymentsService`, and later
 * the webhook controller / checkout's wompi branch) need to handle it
 * anyway. This is a deliberate, documented deviation from the brief — not an
 * oversight.
 */
export const PROVIDERS: Partial<Record<PaymentProviderId, PaymentProvider>> = {
  wompi: new WompiProvider(),
};

/**
 * Looks up a configured provider implementation, throwing a 400
 * `PAYMENT_PROVIDER_NOT_CONFIGURED` HttpException for any `PaymentProviderId`
 * that doesn't have one yet (`mercadopago`/`epayco` today) — a 400, not a
 * 404/500, because the *id* itself is valid per the type union, it's just not
 * wired up on this deployment yet; that's a client-correctable-by-choosing-
 * another-provider condition, not "resource doesn't exist" or "server broke".
 */
export function getProvider(id: PaymentProviderId): PaymentProvider {
  const provider = PROVIDERS[id];
  if (!provider) {
    throw new HttpException({ error: 'PAYMENT_PROVIDER_NOT_CONFIGURED' }, 400);
  }
  return provider;
}
