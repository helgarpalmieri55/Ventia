import { Injectable } from '@nestjs/common';
import { platformDb } from '@ventia/db';
import type { InstagramConfig, InstagramProviderId } from '@ventia/instagram';
import { decrypt, encrypt, loadEncryptionKey } from '../payments/encryption';

/**
 * Lee y escribe las filas `InstagramAccount` que conectan a un inquilino con
 * su cuenta de Instagram, y arma el `InstagramConfig` que necesita el
 * adaptador.
 *
 * ## Por qué `platformDb` y no `tenantDb`
 *
 * El camino de entrada todavía no tiene inquilino — resolverlo es justo el
 * trabajo —, y lo único con lo que resolverlo es un id de cuenta de Instagram
 * que llegó dentro de un payload sin autenticar. Un cliente con ámbito de
 * inquilino no puede hacer una búsqueda cuyo propósito es descubrir el
 * inquilino.
 *
 * Eso hace que el `@unique` de `igAccountId` sea estructural y no cosmético:
 * es lo que garantiza que esta búsqueda tenga exactamente una respuesta. Dos
 * inquilinos reclamando el mismo id serían el mensaje de un comprador llegando
 * a la fila que Postgres devolviera primero.
 *
 * ## Por qué las credenciales se cifran con la llave de pagos
 *
 * `PAYMENTS_ENCRYPTION_KEY` ya es el único secreto AES-256-GCM del proceso, ya
 * se valida a 32 bytes y ya es lo que un despliegue rota. Una segunda llave
 * para el mismo trabajo duplicaría la superficie operativa y dividiría por dos
 * la probabilidad de que alguna se rote bien. Mismo razonamiento, y misma
 * llave, que en `whatsapp-numbers.service.ts`.
 */

/** La fila tal y como puede verla cualquiera fuera de este servicio: sin
 * token, sin app secret y sin token de verificación. El admin necesita saber
 * QUÉ cuenta está conectada y si funciona, nunca las credenciales que la hacen
 * funcionar. */
export interface InstagramAccountView {
  id: string;
  provider: InstagramProviderId;
  igAccountId: string;
  pageId: string | null;
  username: string;
  status: string;
  createdAt: Date;
}

/** Lo que aporta una llamada de conexión. Los secretos llegan aquí en claro y
 * salen cifrados; nada más de la aplicación los ve por el camino. */
export interface InstagramCredentials {
  token: string;
  appSecret?: string;
  verifyToken?: string;
}

@Injectable()
export class InstagramAccountsService {
  /**
   * La búsqueda de enrutamiento de entrada: `igAccountId` → el inquilino y la
   * configuración con la que contestarle.
   *
   * Devuelve `null` para un id desconocido Y para una cuenta desactivada. Una
   * cuenta desactivada que siguiera contestando sería una tienda que el
   * comerciante cree apagada gastándole el presupuesto de IA en silencio.
   */
  async resolveInbound(
    provider: string,
    igAccountId: string,
  ): Promise<{ tenantId: string; accountId: string; config: InstagramConfig } | null> {
    const row = await platformDb.instagramAccount.findUnique({ where: { igAccountId } });
    if (!row) return null;
    // El proveedor va en la URL y el id en el payload; que no cuadren significa
    // que alguien está publicando el payload de una integración en el endpoint
    // de la otra. En cualquier caso no es una entrega que sepamos interpretar,
    // y adivinar significaría verificarla con el esquema equivocado.
    if (row.provider !== provider) return null;
    if (row.status === 'disabled') return null;

    return {
      tenantId: row.tenantId,
      accountId: row.id,
      config: this.toConfig(row.igAccountId, row.credentialsEnc, row.verifyToken),
    };
  }

  /**
   * La cuenta con la que ESTE inquilino puede contestar por Instagram, y su
   * configuración lista para enviar.
   *
   * Es el gemelo de salida de {@link resolveInbound}, y existe porque una
   * respuesta escrita por una persona desde el panel no llega con ningún
   * payload del que sacar la cuenta. Acotado por `tenantId` en TODOS los
   * caminos: sin eso, un id de cuenta traído de una conversación ajena sería un
   * inquilino enviando con las credenciales de otro.
   *
   * `accountId` es el `Conversation.channelAccountId` que anotó el camino de
   * entrada. Cuando falta —conversaciones anteriores a esa columna— se cae a
   * «la única cuenta conectada de este inquilino»: con una sola cuenta no hay
   * ambigüedad ninguna, y con varias devuelve `null` en vez de sortear, porque
   * un IGSID solo identifica a una persona FRENTE A LA CUENTA que lo emitió y
   * enviar por la equivocada es, en el mejor caso, un rechazo de Meta.
   *
   * `null` también para una cuenta desactivada, por lo mismo que en la entrada:
   * un canal que el comerciante cree apagado no puede seguir hablando.
   */
  async resolveOutbound(
    tenantId: string,
    accountId?: string | null,
  ): Promise<{ provider: InstagramProviderId; config: InstagramConfig } | null> {
    if (accountId) {
      const row = await platformDb.instagramAccount.findFirst({ where: { id: accountId, tenantId } });
      if (!row || row.status === 'disabled') return null;
      return { provider: row.provider, config: this.toConfig(row.igAccountId, row.credentialsEnc, row.verifyToken) };
    }

    // `take: 2` y no `findFirst`: hacen falta DOS filas para distinguir «una
    // sola, sin ambigüedad» de «varias, no se puede adivinar», y no hace falta
    // ninguna más.
    const rows = await platformDb.instagramAccount.findMany({
      where: { tenantId, status: { not: 'disabled' } },
      orderBy: { createdAt: 'asc' },
      take: 2,
    });
    if (rows.length !== 1) return null;
    const row = rows[0];
    return { provider: row.provider, config: this.toConfig(row.igAccountId, row.credentialsEnc, row.verifyToken) };
  }

  /** Todas las cuentas que ha conectado un inquilino, sin credenciales. */
  async listForTenant(tenantId: string): Promise<InstagramAccountView[]> {
    const rows = await platformDb.instagramAccount.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => this.toView(row));
  }

  /**
   * Conecta una cuenta, o vuelve a conectar una que este inquilino ya tiene.
   *
   * El conflicto de unicidad de `igAccountId` NO se captura para convertirlo en
   * un upsert a propósito: si otro inquilino ya tiene ese id, la respuesta
   * correcta es una negativa que lea una persona, no quedarse con su
   * enrutamiento en silencio. Quien llama traduce la violación de la
   * restricción a un 409.
   */
  async connect(input: {
    tenantId: string;
    provider: InstagramProviderId;
    igAccountId: string;
    pageId?: string | null;
    username: string;
    credentials: InstagramCredentials;
  }): Promise<InstagramAccountView> {
    const key = loadEncryptionKey();
    const credentialsEnc = encrypt(
      JSON.stringify({ token: input.credentials.token, appSecret: input.credentials.appSecret }),
      key,
    );

    const existing = await platformDb.instagramAccount.findUnique({
      where: { igAccountId: input.igAccountId },
    });
    // Volver a conectar tu PROPIA cuenta (rotar el token, arreglar un @usuario
    // mal escrito) es lo normal. Ir a por la de otro no lo es, y lo que lo
    // impide es la restricción UNIQUE; esta comprobación solo decide si
    // actualizamos o insertamos.
    if (existing && existing.tenantId === input.tenantId) {
      const row = await platformDb.instagramAccount.update({
        where: { id: existing.id },
        data: {
          provider: input.provider,
          pageId: input.pageId ?? null,
          username: input.username,
          credentialsEnc,
          verifyToken: input.credentials.verifyToken ?? null,
          // Volver a conectar revive una cuenta desactivada: el comerciante
          // acaba de dar credenciales que funcionan, que es el mismo gesto que
          // volver a encenderla.
          status: 'connected',
        },
      });
      return this.toView(row);
    }

    const row = await platformDb.instagramAccount.create({
      data: {
        tenantId: input.tenantId,
        provider: input.provider,
        igAccountId: input.igAccountId,
        pageId: input.pageId ?? null,
        username: input.username,
        credentialsEnc,
        verifyToken: input.credentials.verifyToken ?? null,
        status: 'connected',
      },
    });
    return this.toView(row);
  }

  /** Activa o desactiva una cuenta. Acotado por `tenantId` en el WHERE y no
   * solo por id: con el id a secas, un inquilino podría desactivar la cuenta de
   * otro, que es una denegación de servicio contra todo su canal. */
  async setStatus(
    tenantId: string,
    id: string,
    status: 'connected' | 'disabled',
  ): Promise<InstagramAccountView | null> {
    const result = await platformDb.instagramAccount.updateMany({ where: { id, tenantId }, data: { status } });
    if (result.count === 0) return null;
    const row = await platformDb.instagramAccount.findUniqueOrThrow({ where: { id } });
    return this.toView(row);
  }

  async deleteForTenant(tenantId: string, id: string): Promise<boolean> {
    const result = await platformDb.instagramAccount.deleteMany({ where: { id, tenantId } });
    return result.count > 0;
  }

  /** Descifra las credenciales de una fila y les da la forma que toma el
   * adaptador. El texto en claro existe solo dentro de una llamada, y a nadie
   * se le entrega una configuración que no haya pedido para enviar. */
  private toConfig(
    igAccountId: string,
    credentialsEnc: string | null,
    verifyToken: string | null,
  ): InstagramConfig {
    if (!credentialsEnc) return { igAccountId, token: '', verifyToken: verifyToken ?? undefined };
    const key = loadEncryptionKey();
    const parsed = JSON.parse(decrypt(credentialsEnc, key)) as { token?: string; appSecret?: string };
    return {
      igAccountId,
      token: parsed.token ?? '',
      appSecret: parsed.appSecret,
      verifyToken: verifyToken ?? undefined,
    };
  }

  private toView(row: {
    id: string;
    provider: InstagramProviderId;
    igAccountId: string;
    pageId: string | null;
    username: string;
    status: string;
    createdAt: Date;
  }): InstagramAccountView {
    return {
      id: row.id,
      provider: row.provider,
      igAccountId: row.igAccountId,
      pageId: row.pageId,
      username: row.username,
      status: row.status,
      createdAt: row.createdAt,
    };
  }
}
