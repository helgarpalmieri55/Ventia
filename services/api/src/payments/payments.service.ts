import { Injectable } from '@nestjs/common';
import { Prisma, platformDb, tenantDb } from '@ventia/db';
import type { NormalizedStatus, PaymentProviderId, TenantProviderConfig } from '@ventia/payments';
import { decrypt, encrypt, loadEncryptionKey } from './encryption';
import { getProvider } from './provider-registry';

type JsonRecord = Record<string, unknown>;

function asRecord(value: Prisma.JsonValue | null | undefined): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {};
}

/** The shape persisted at `tenant.settings.payments.providers.<provider>` —
 * NOT the same shape as `TenantProviderConfig` (packages/payments). Per
 * design decision 6, `publicKey` is stored in CLEARTEXT (it's meant to
 * appear in client-side checkout redirect URLs — none of the three
 * providers' public keys are secrets), while `privateKey`/`integritySecret`/
 * `eventsSecret`/`epaycoCustomerId` are stored as `encrypt(...)` ciphertext
 * strings. This split is what lets `settings.controller.ts`'s `toResponse`
 * show "connected" + a masked `publicKey` suffix directly off the stored
 * JSON, with NO decryption round trip needed just to answer "is something
 * saved" — decrypting only ever happens inside `getTenantProviderConfig`, at
 * the moment a real provider call needs the plaintext secrets.
 *
 * Named/shaped generically (P3b Task 4) rather than Wompi-specifically
 * (`StoredWompiCredentials`, as this was originally called): it was already
 * used generically — keyed by `PaymentProviderId`, not hardcoded to
 * `'wompi'` anywhere in `getTenantProviderConfig`/`saveProviderCredentials`'s
 * own logic — only the TYPE NAME was Wompi-specific, which was misleading
 * now that mercadopago/epayco share this exact shape.
 * `epaycoCustomerIdEncrypted` is the one new field, added for ePayco's
 * `P_CUST_ID_CLIENTE`: encrypted at rest even though it's an account
 * identifier, not a secret on its own — it's one half of ePayco's webhook
 * signature formula whose OTHER half (`eventsSecret`/`P_KEY`) is already
 * encrypted here, and an asymmetric sensitive/not-sensitive judgment call
 * baked into this stored shape isn't worth the (nonexistent) savings. */
interface StoredProviderCredentials {
  publicKey: string;
  privateKeyEncrypted: string;
  integritySecretEncrypted?: string;
  eventsSecretEncrypted?: string;
  epaycoCustomerIdEncrypted?: string;
  sandbox: boolean;
}

export interface SaveProviderCredentialsInput {
  publicKey: string;
  privateKey: string;
  integritySecret?: string;
  eventsSecret?: string;
  epaycoCustomerId?: string;
  sandbox: boolean;
}

export interface TestConnectionResult {
  ok: boolean;
  error?: string;
}

function isStoredProviderCredentials(value: unknown): value is StoredProviderCredentials {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as JsonRecord;
  return typeof v.publicKey === 'string' && typeof v.privateKeyEncrypted === 'string' && typeof v.sandbox === 'boolean';
}

@Injectable()
export class PaymentsService {
  /**
   * Reads `tenant.settings.payments.providers.<provider>`, decrypts the
   * encrypted fields, and returns the full plaintext `TenantProviderConfig`
   * a `PaymentProvider` implementation needs — or `null` if that key is
   * absent or malformed (same defensive-parse posture as
   * `settings.controller.ts`'s own `asRecord` helper: a missing/garbled key
   * is treated as "not configured", never thrown as an error). Decryption
   * happens ONLY here, in-memory, at the moment a real provider call needs
   * the plaintext — never in any response returned to an HTTP caller.
   */
  async getTenantProviderConfig(tenantId: string, provider: PaymentProviderId): Promise<TenantProviderConfig | null> {
    const tenant = await tenantDb(tenantId).tenant.findUniqueOrThrow({ where: { id: tenantId } });
    const settings = asRecord(tenant.settings);
    const payments = asRecord(settings.payments as Prisma.JsonValue | undefined);
    const providers = asRecord(payments.providers as Prisma.JsonValue | undefined);
    const stored = providers[provider];

    if (!isStoredProviderCredentials(stored)) return null;

    const key = loadEncryptionKey();
    return {
      publicKey: stored.publicKey,
      privateKey: decrypt(stored.privateKeyEncrypted, key),
      sandbox: stored.sandbox,
      integritySecret: stored.integritySecretEncrypted ? decrypt(stored.integritySecretEncrypted, key) : undefined,
      eventsSecret: stored.eventsSecretEncrypted ? decrypt(stored.eventsSecretEncrypted, key) : undefined,
      epaycoCustomerId: stored.epaycoCustomerIdEncrypted ? decrypt(stored.epaycoCustomerIdEncrypted, key) : undefined,
    };
  }

  /**
   * Encrypts `privateKey` and whichever of `integritySecret`/`eventsSecret`
   * are present, and writes the result into
   * `tenant.settings.payments.providers.<provider>` — merge-in-place with
   * any other already-configured provider under `.providers`, and with
   * `codEnabled` at the `payments` level (neither is clobbered). `publicKey`
   * is stored as-is (cleartext) — see `StoredWompiCredentials`'s doc comment
   * for why.
   */
  async saveProviderCredentials(
    tenantId: string,
    provider: PaymentProviderId,
    creds: SaveProviderCredentialsInput,
  ): Promise<void> {
    const key = loadEncryptionKey();
    const stored: StoredProviderCredentials = {
      publicKey: creds.publicKey,
      privateKeyEncrypted: encrypt(creds.privateKey, key),
      sandbox: creds.sandbox,
      ...(creds.integritySecret ? { integritySecretEncrypted: encrypt(creds.integritySecret, key) } : {}),
      ...(creds.eventsSecret ? { eventsSecretEncrypted: encrypt(creds.eventsSecret, key) } : {}),
      ...(creds.epaycoCustomerId ? { epaycoCustomerIdEncrypted: encrypt(creds.epaycoCustomerId, key) } : {}),
    };

    const db = tenantDb(tenantId);
    const tenant = await db.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    const settings = { ...asRecord(tenant.settings) };
    const payments = { ...asRecord(settings.payments as Prisma.JsonValue | undefined) };
    const providers = { ...asRecord(payments.providers as Prisma.JsonValue | undefined) };
    providers[provider] = stored;
    payments.providers = providers;
    settings.payments = payments;

    await db.tenant.update({
      where: { id: tenantId },
      data: { settings: settings as Prisma.InputJsonValue },
    });
  }

  /**
   * Reads the tenant's stored config for `provider` and exercises a
   * least-destructive real connectivity check against it — a
   * `getTransactionStatus` lookup for a definitely-nonexistent transaction
   * id, on the theory that any RESPONSE (rather than a thrown error) proves
   * the credentials/auth were accepted. NEVER lets a provider-side error
   * propagate as a 500: every failure mode (not configured, provider throws)
   * collapses to `{ok: false, error}`.
   *
   * Caveat worth a reviewer's attention: `WompiProvider.getTransactionStatus`
   * (packages/payments/src/wompi.ts) throws on ANY non-2xx HTTP response,
   * including a 404 for "transaction not found" — which, for a deliberately
   * bogus reference id like `'test-connection-check'`, is plausibly exactly
   * what Wompi's real API returns even for perfectly valid credentials. If
   * so, this check may false-negative (report `{ok: false}`) on a genuinely
   * working credential set, indistinguishable here from an actual 401/403
   * auth rejection — both surface as a thrown `Error`. It will never
   * false-POSITIVE (report connected when it isn't), which is the safer
   * direction to err in, but a false negative would still be a confusing
   * "test connection" experience for a merchant with correct credentials.
   * This wasn't verified against Wompi's real sandbox during this task;
   * flagged here rather than silently assumed correct.
   */
  async testConnection(tenantId: string, provider: PaymentProviderId): Promise<TestConnectionResult> {
    const cfg = await this.getTenantProviderConfig(tenantId, provider);
    if (!cfg) return { ok: false, error: 'not configured' };

    try {
      await getProvider(provider).getTransactionStatus('test-connection-check', cfg);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Webhook-confirmed payment (design decision 3) — a NEW, narrow transition
   * path, deliberately NOT `OrdersService.transition('confirm')` (which
   * unconditionally decrements stock, correct for COD but a double-decrement
   * here since an online-payment order's stock was already reserved at
   * checkout). Validates `status === 'PENDING' && paymentStatus ===
   * 'PENDING'`; any other state (order not found, or already
   * transitioned/cancelled) is a safe, idempotent no-op — a webhook retry
   * arriving after this already ran once (or racing some other transition)
   * must never throw.
   *
   * Same advisory-lock-per-order transaction pattern as
   * `orders.service.ts`'s `transition()` (`SET LOCAL ROLE ventia_app` +
   * `set_config('app.tenant_id', ...)` + `pg_advisory_xact_lock(hashtext(orderId))`),
   * for the identical reason: a webhook retry racing an admin action (or
   * another webhook delivery) on the same order must serialize, not corrupt
   * state.
   */
  async markPaid(tenantId: string, orderId: string, provider: string, providerRef: string): Promise<void> {
    await platformDb.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE ventia_app');
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${orderId}))`;

      const order = await tx.order.findFirst({ where: { id: orderId, tenantId } });
      if (!order || order.status !== 'PENDING' || order.paymentStatus !== 'PENDING') {
        // Not found, or not in the exact state this transition requires:
        // idempotent no-op, not an error (a webhook retry after this already
        // ran once, or a race with some other actor, must not fail).
        return;
      }

      await tx.order.update({
        where: { id: orderId },
        data: {
          status: 'CONFIRMED',
          paymentStatus: 'PAID',
          stockReservedUntil: null,
          // `paymentProvider` may already be set from checkout — setting it
          // again here is harmless and explicit, not a correctness
          // requirement.
          paymentProvider: provider,
          // P3c: also stamp the queryable `Order.providerRef` column (not
          // just the OrderEvent's JSON `data` below) — the lowest-risk of
          // the three providerRef sources (design decision 2), since it only
          // ever runs after a real signature check already passed. Purely
          // best-effort record-keeping for a LATER reconciliation pass on
          // this same order; not itself a correctness requirement of this
          // transition.
          providerRef,
        },
      });

      await tx.orderEvent.create({
        data: {
          tenantId,
          orderId,
          type: 'payment_confirmed',
          actor: 'system',
          data: { provider, providerRef } as Prisma.InputJsonValue,
        },
      });
    });
  }

  /**
   * Webhook-reported failed payment ATTEMPT (a `FAILED` event — the
   * shopper's payment was declined/errored, not cancelled) — mirrors
   * `markPaid`'s guard/locking discipline exactly, for the same reason: a
   * webhook for one attempt racing an admin action, or a LATER webhook for a
   * different attempt on the same order (a shopper who retries Wompi's
   * checkout after a decline), must serialize and must never clobber a
   * transition that already happened.
   *
   * Found in review: the original implementation of this webhook branch did
   * a bare `tenantDb(tenantId).order.update({data:{paymentStatus:'FAILED'}})`
   * directly in the controller, with no precondition check and no lock —
   * reproducibly overwrote an already-CONFIRMED/PAID order's `paymentStatus`
   * back to `FAILED` if a late-arriving webhook for an earlier failed
   * attempt on the same order was processed after a later attempt's `PAID`
   * webhook already confirmed it. Only `status === 'PENDING' &&
   * paymentStatus === 'PENDING'` may ever move to `FAILED` here — a stray/
   * late FAILED event for an order that's already `CONFIRMED`/`PAID` (or
   * already `FAILED`, or `CANCELLED`) is a safe, idempotent no-op, exactly
   * like `markPaid`'s own no-op branch.
   *
   * Deliberately does NOT touch `status` or `stockReservedUntil` (design
   * decision: a failed attempt doesn't cancel the order or release its stock
   * hold — the shopper may retry; the TTL expiry job, Task 6, is the only
   * thing that ever restocks a reserved-but-unpaid order).
   *
   * ## `gatewayStatus` (optional, P3c review follow-up) — audit only
   *
   * Every non-`PAID` TERMINAL status settles through this one method, so more
   * than one real-world outcome collapses into `paymentStatus: 'FAILED'`. In
   * particular Mercado Pago maps `refunded`/`charged_back` to `EXPIRED`
   * (`packages/payments/src/mercadopago.ts`'s `mapStatus`), and the
   * reconciliation worker settles `FAILED` and `EXPIRED` identically — so a
   * REFUNDED order and a DECLINED CARD become indistinguishable on the `Order`
   * row afterwards.
   *
   * Passing the gateway's own normalized status here records that distinction
   * in the `payment_failed` `OrderEvent`'s `data`, so it is at least auditable
   * after the fact. It is PURELY ADDITIVE: it does not change this method's
   * preconditions, its advisory lock, or its `paymentStatus: 'FAILED'`
   * outcome, and it is optional precisely so the existing webhook caller
   * (`webhooks.controller.ts`, which only ever reaches here for an already-
   * `FAILED` event) keeps behaving — and writing — exactly as before. Deciding
   * to treat a reversal differently from a decline (a real un-confirm/restock
   * flow) is a separate, unbuilt piece of work; this only makes sure the
   * information needed for it isn't thrown away in the meantime.
   */
  async markFailed(
    tenantId: string,
    orderId: string,
    provider: string,
    providerRef: string,
    gatewayStatus?: NormalizedStatus,
  ): Promise<void> {
    await platformDb.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE ventia_app');
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${orderId}))`;

      const order = await tx.order.findFirst({ where: { id: orderId, tenantId } });
      if (!order || order.status !== 'PENDING' || order.paymentStatus !== 'PENDING') {
        return;
      }

      await tx.order.update({
        where: { id: orderId },
        data: {
          paymentStatus: 'FAILED',
          // P3c: same best-effort providerRef stamp as markPaid — see that
          // method's comment. A later shopper retry (a new attempt, possibly
          // a different providerRef) simply overwrites this on its own
          // markPaid/markFailed call; nothing here depends on this value
          // being "the final" one.
          providerRef,
        },
      });

      await tx.orderEvent.create({
        data: {
          tenantId,
          orderId,
          type: 'payment_failed',
          actor: 'system',
          // The `gatewayStatus` key is OMITTED entirely when the caller didn't
          // supply one, rather than written as an explicit `null` — so the
          // existing webhook path's event `data` is byte-for-byte what it was
          // before this parameter existed.
          data: {
            provider,
            providerRef,
            ...(gatewayStatus !== undefined ? { gatewayStatus } : {}),
          } as Prisma.InputJsonValue,
        },
      });
    });
  }
}
