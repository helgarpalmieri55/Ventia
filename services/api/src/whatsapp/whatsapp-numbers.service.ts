import { Injectable } from '@nestjs/common';
import { platformDb } from '@ventia/db';
import type { WhatsAppConfig, WhatsAppProviderId } from '@ventia/whatsapp';
import { decrypt, encrypt, loadEncryptionKey } from '../payments/encryption';

/**
 * Reads and writes the `WhatsAppNumber` rows that connect a tenant to a
 * WhatsApp number, and assembles the per-number `WhatsAppConfig` an adapter
 * needs.
 *
 * ## Why `platformDb` and not `tenantDb`
 *
 * The inbound path has no tenant yet — resolving one is the whole job, and the
 * only thing to resolve it FROM is a `phone_number_id` (or an Evolution
 * instance name) that arrived inside an unauthenticated payload. A
 * tenant-scoped client cannot perform a lookup whose purpose is to discover
 * the tenant.
 *
 * That makes the `@unique` on `externalId` load-bearing rather than tidy: it
 * is what guarantees this lookup has exactly one answer. Two tenants claiming
 * one id would mean a shopper's message reaching whichever row Postgres
 * happened to return.
 *
 * ## Why credentials are encrypted with the payments key
 *
 * `PAYMENTS_ENCRYPTION_KEY` is already the process's one AES-256-GCM secret,
 * already validated at 32 bytes, already the thing a deployment rotates. A
 * second key for the same job would double the operational surface and halve
 * the chance either is rotated correctly. The name is now narrower than its
 * use, which is a fair trade and worth noting here rather than renaming an env
 * var every existing deployment already sets.
 */

/** The row as anything outside this service should see it: no token, no app
 * secret, no verify token. The admin UI needs to show a merchant WHICH number
 * is connected and whether it works — never the credentials that make it
 * work. */
export interface WhatsAppNumberView {
  id: string;
  provider: WhatsAppProviderId;
  externalId: string;
  displayPhone: string;
  status: string;
  createdAt: Date;
}

/** What a connect/update call supplies. Secrets arrive in plaintext here and
 * leave encrypted; nothing else in the app sees them in between. */
export interface WhatsAppCredentials {
  token: string;
  appSecret?: string;
  verifyToken?: string;
  baseUrl?: string;
}

@Injectable()
export class WhatsAppNumbersService {
  /**
   * The inbound routing lookup: `externalId` → the tenant and the config to
   * answer with.
   *
   * Returns `null` for an unknown id AND for a disabled number. A disabled
   * number that still answered would be a store the merchant believes they
   * turned off, quietly spending their AI budget.
   */
  async resolveInbound(
    provider: string,
    externalId: string,
  ): Promise<{ tenantId: string; numberId: string; config: WhatsAppConfig } | null> {
    const row = await platformDb.whatsAppNumber.findUnique({ where: { externalId } });
    if (!row) return null;
    // The provider is in the URL and the id is in the payload; a mismatch
    // means someone is posting an Evolution payload at the Cloud endpoint (or
    // has mis-registered a number). Either way this is not a delivery we can
    // interpret, and guessing would mean verifying it with the wrong scheme.
    if (row.provider !== provider) return null;
    if (row.status === 'disabled') return null;

    return {
      tenantId: row.tenantId,
      numberId: row.id,
      config: this.toConfig(row.externalId, row.credentialsEnc, row.verifyToken),
    };
  }

  /**
   * El número con el que ESTE inquilino puede contestar por WhatsApp, y su
   * configuración lista para enviar.
   *
   * Gemelo de salida de {@link resolveInbound}. Existe por lo mismo que el de
   * Instagram: una respuesta escrita por una persona desde el panel no llega
   * con ningún payload del que sacar el número. Acotado por `tenantId` en todos
   * los caminos, para que un id traído de una conversación ajena no envíe con
   * las credenciales de otro.
   *
   * Con `numberId` ausente (conversaciones anteriores a
   * `Conversation.channelAccountId`) cae a «el único número conectado» y
   * devuelve `null` si hay varios: enviar desde el número equivocado le cambia
   * el remitente al comprador, y eso no se adivina.
   */
  async resolveOutbound(
    tenantId: string,
    numberId?: string | null,
  ): Promise<{ provider: WhatsAppProviderId; config: WhatsAppConfig } | null> {
    if (numberId) {
      const row = await platformDb.whatsAppNumber.findFirst({ where: { id: numberId, tenantId } });
      if (!row || row.status === 'disabled') return null;
      return { provider: row.provider, config: this.toConfig(row.externalId, row.credentialsEnc, row.verifyToken) };
    }

    const rows = await platformDb.whatsAppNumber.findMany({
      where: { tenantId, status: { not: 'disabled' } },
      orderBy: { createdAt: 'asc' },
      take: 2,
    });
    if (rows.length !== 1) return null;
    const row = rows[0];
    return { provider: row.provider, config: this.toConfig(row.externalId, row.credentialsEnc, row.verifyToken) };
  }

  /** Every number a tenant has connected, credential-free. */
  async listForTenant(tenantId: string): Promise<WhatsAppNumberView[]> {
    const rows = await platformDb.whatsAppNumber.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => ({
      id: row.id,
      provider: row.provider,
      externalId: row.externalId,
      displayPhone: row.displayPhone,
      status: row.status,
      createdAt: row.createdAt,
    }));
  }

  /**
   * Connects a number, or re-connects one this tenant already owns.
   *
   * The `externalId` uniqueness conflict is deliberately NOT caught and
   * turned into an upsert: if another tenant already holds this id, the right
   * answer is a refusal a human reads, not a silent takeover of their
   * routing. The caller maps the constraint violation to a 409.
   */
  async connect(input: {
    tenantId: string;
    provider: WhatsAppProviderId;
    externalId: string;
    displayPhone: string;
    credentials: WhatsAppCredentials;
  }): Promise<WhatsAppNumberView> {
    const key = loadEncryptionKey();
    const credentialsEnc = encrypt(
      JSON.stringify({
        token: input.credentials.token,
        appSecret: input.credentials.appSecret,
        baseUrl: input.credentials.baseUrl,
      }),
      key,
    );

    const existing = await platformDb.whatsAppNumber.findUnique({
      where: { externalId: input.externalId },
    });
    // Re-connecting your OWN number (rotating a token, fixing a typo in the
    // display phone) is ordinary. Reaching for someone else's is not, and the
    // unique constraint below is what stops it — this check only decides
    // whether we are updating or inserting.
    if (existing && existing.tenantId === input.tenantId) {
      const row = await platformDb.whatsAppNumber.update({
        where: { id: existing.id },
        data: {
          provider: input.provider,
          displayPhone: input.displayPhone,
          credentialsEnc,
          verifyToken: input.credentials.verifyToken ?? null,
          // Re-connecting revives a disabled number: the merchant just
          // supplied working credentials for it, which is the same gesture as
          // turning it back on.
          status: 'connected',
        },
      });
      return this.toView(row);
    }

    const row = await platformDb.whatsAppNumber.create({
      data: {
        tenantId: input.tenantId,
        provider: input.provider,
        externalId: input.externalId,
        displayPhone: input.displayPhone,
        credentialsEnc,
        verifyToken: input.credentials.verifyToken ?? null,
        status: 'connected',
      },
    });
    return this.toView(row);
  }

  /** Enables or disables a number. Scoped by `tenantId` in the WHERE clause,
   * not just by id — an id alone would let one tenant disable another's
   * number, which is a denial of service against their whole channel. */
  async setStatus(tenantId: string, id: string, status: 'connected' | 'disabled'): Promise<WhatsAppNumberView | null> {
    const result = await platformDb.whatsAppNumber.updateMany({
      where: { id, tenantId },
      data: { status },
    });
    if (result.count === 0) return null;
    const row = await platformDb.whatsAppNumber.findUniqueOrThrow({ where: { id } });
    return this.toView(row);
  }

  async deleteForTenant(tenantId: string, id: string): Promise<boolean> {
    const result = await platformDb.whatsAppNumber.deleteMany({ where: { id, tenantId } });
    return result.count > 0;
  }

  /** Decrypts a row's credentials into the shape an adapter takes. Kept
   * private-ish: the plaintext exists only inside a single call, and no
   * caller is handed a config it did not ask to send with. */
  private toConfig(externalId: string, credentialsEnc: string | null, verifyToken: string | null): WhatsAppConfig {
    if (!credentialsEnc) return { externalId, token: '', verifyToken: verifyToken ?? undefined };
    const key = loadEncryptionKey();
    const parsed = JSON.parse(decrypt(credentialsEnc, key)) as {
      token?: string;
      appSecret?: string;
      baseUrl?: string;
    };
    return {
      externalId,
      token: parsed.token ?? '',
      appSecret: parsed.appSecret,
      baseUrl: parsed.baseUrl,
      verifyToken: verifyToken ?? undefined,
    };
  }

  private toView(row: {
    id: string;
    provider: WhatsAppProviderId;
    externalId: string;
    displayPhone: string;
    status: string;
    createdAt: Date;
  }): WhatsAppNumberView {
    return {
      id: row.id,
      provider: row.provider,
      externalId: row.externalId,
      displayPhone: row.displayPhone,
      status: row.status,
      createdAt: row.createdAt,
    };
  }
}
