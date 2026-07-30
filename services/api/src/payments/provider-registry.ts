import { HttpException } from '@nestjs/common';
import {
  EpaycoProvider,
  MercadoPagoProvider,
  WompiProvider,
  type PaymentProvider,
  type PaymentProviderId,
} from '@ventia/payments';

/**
 * The concrete provider registry. `PaymentProviderId` (packages/payments/src/
 * index.ts) is a 3-member union (`'wompi' | 'mercadopago' | 'epayco'`) — as of
 * P3b (this task) all three have real `PaymentProvider` implementations.
 *
 * Deliberately typed `Partial<Record<PaymentProviderId, PaymentProvider>>`,
 * NOT the design doc's literal `Record<PaymentProviderId, PaymentProvider>`
 * snippet: a full `Record` would force this file to either fabricate fake
 * entries for any provider id lacking an implementation (worse than useless —
 * a caller could accidentally exercise them) or fight the type checker with
 * an `as` cast that defeats the whole point of the exhaustiveness check.
 * `Partial` is honest about "not every provider id is guaranteed to have an
 * implementation" (still true in principle even though all three are filled
 * in today — a future 4th `PaymentProviderId` would land here unimplemented
 * first) and pushes the "is this one actually configured" question to
 * `getProvider` below, which is exactly where callers (`PaymentsService`, the
 * webhook controller, checkout's provider branches) need to handle it anyway.
 * This is a deliberate, documented deviation from the brief — not an
 * oversight.
 */
export const PROVIDERS: Partial<Record<PaymentProviderId, PaymentProvider>> = {
  wompi: new WompiProvider(),
  mercadopago: new MercadoPagoProvider(),
  epayco: new EpaycoProvider(),
};

/**
 * Shared across two independent call sites — `getProvider` below (id not in
 * `PROVIDERS` at all) and `checkout.service.ts`'s wompi branch (id is valid
 * and implemented, but THIS tenant never saved credentials for it) — two
 * different underlying causes that both collapse to the same client-facing
 * meaning ("can't check out with this provider right now"). Exported as one
 * constant rather than left as a duplicated string literal so the two sites
 * can't drift apart.
 */
export const PAYMENT_PROVIDER_NOT_CONFIGURED = 'PAYMENT_PROVIDER_NOT_CONFIGURED';

/**
 * Looks up a configured provider implementation, throwing a 400
 * `PAYMENT_PROVIDER_NOT_CONFIGURED` HttpException for any `PaymentProviderId`
 * that doesn't have one — a 400, not a 404/500, because the *id* itself is
 * valid per the type union, it's just not wired up on this deployment yet;
 * that's a client-correctable-by-choosing-another-provider condition, not
 * "resource doesn't exist" or "server broke". All 3 current members of
 * `PaymentProviderId` (`wompi`/`mercadopago`/`epayco`, as of P3b Task 4) have
 * real entries in `PROVIDERS` below, so this branch is unreachable for any
 * value that type-checks today — it remains as the defensive fallback for
 * whenever a future provider id is added to the union before its adapter
 * lands in this registry (the exact sequencing P3b's own Task 1 deliberately
 * exercised for mercadopago/epayco).
 */
export function getProvider(id: PaymentProviderId): PaymentProvider {
  const provider = PROVIDERS[id];
  if (!provider) {
    throw new HttpException({ error: PAYMENT_PROVIDER_NOT_CONFIGURED }, 400);
  }
  return provider;
}
