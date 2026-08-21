import type { Prisma } from '@ventia/db';

/**
 * How both document generators read a tenant's `settings` JSON column.
 *
 * `Tenant.settings` is loosely typed and written by several endpoints, so
 * every read of it in this codebase narrows defensively (the same `asRecord`
 * posture as settings.controller.ts, checkout.service.ts and
 * shipping.service.ts). What is shared HERE rather than copied is the pair of
 * rules the two generators must agree on:
 *
 *  - the ORDER the three gateways are enumerated in, so a regenerated
 *    document lists them the same way twice running rather than following
 *    JSON key order;
 *  - what "this store accepts payments through X" MEANS — the presence of an
 *    encrypted private key, exactly the signal `maskedProviderView` in
 *    settings.controller.ts calls `connected`, never a decrypted secret.
 *
 * A privacy policy that names Wompi and a terms page that does not would be
 * two documents disagreeing about the same store, published by the same
 * merchant, on the same site.
 */

type JsonRecord = Record<string, unknown>;

/** An object-shaped JSON value, or `{}` for anything else — absent, null, a
 * scalar or an array all mean "nothing configured" rather than an error. */
export function asRecord(value: Prisma.JsonValue | null | undefined): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {};
}

/** A non-empty trimmed string, or `null` — so a whitespace-only setting is
 * treated as unset and reaches the `[COMPLETAR: ...]` path instead of
 * rendering as a blank in a legal document. */
export function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/** Same ordering everywhere the three gateways are enumerated (see
 * `ALL_PROVIDER_IDS` in settings.controller.ts). */
const PROVIDER_ORDER = ['wompi', 'mercadopago', 'epayco'] as const;

/**
 * The `PaymentProviderId`s this store can actually charge through, in
 * {@link PROVIDER_ORDER}.
 *
 * @param payments `settings.payments`, already narrowed with {@link asRecord}.
 */
export function connectedPaymentProviders(payments: JsonRecord): string[] {
  const providersJson = asRecord(payments.providers as Prisma.JsonValue | undefined);
  return PROVIDER_ORDER.filter(
    (id) => typeof asRecord(providersJson[id] as Prisma.JsonValue | undefined).privateKeyEncrypted === 'string',
  );
}
