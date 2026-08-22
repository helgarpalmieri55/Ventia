import { Controller, Get, HttpCode, HttpException, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { getInstagramProvider, GraphProvider } from '@ventia/instagram';
import { InstagramInboundService } from './instagram-inbound.service';
import { InstagramAccountsService } from './instagram-accounts.service';

/**
 * El endpoint público de entrada del canal de Instagram.
 * `GET|POST /webhooks/instagram/:provider`.
 *
 * ## Por qué no hay `:tenantId` en la ruta
 *
 * Todos los webhooks de pago de aquí son
 * `/webhooks/payments/:provider/:tenantId`, porque una pasarela se configura
 * por inquilino al guardar sus credenciales. Meta no: entrega **un webhook por
 * app**, cubriendo todas las cuentas de Instagram conectadas a ella. Una sola
 * URL recibe entonces el tráfico de todos los inquilinos, y el único
 * discriminante está dentro del payload — `entry[].id`, el id de la cuenta
 * profesional. Es exactamente el mismo problema que en WhatsApp, y por eso
 * `InstagramAccount.igAccountId` es único global: esta búsqueda tiene que
 * tener una sola respuesta.
 *
 * ## Por qué contesta antes de trabajar
 *
 * Meta reintenta ante cualquier cosa que no sea 2xx y agota su paciencia
 * pronto. Responder 200 en cuanto el payload verifica, y atender el mensaje
 * después, es lo que evita que una llamada lenta al modelo se convierta en una
 * reentrega — y una reentrega, sin deduplicación, es un segundo turno
 * facturado. La deduplicación existe igualmente (`Message.externalId`), porque
 * "contestamos rápido" es una mitigación y un índice único es una garantía.
 *
 * La consecuencia es que nada de lo que pasa después de la confirmación puede
 * avisar a nadie. Por eso `InstagramInboundService.handle` no lanza nunca.
 *
 * Depende del `express.raw()` que `main.ts` monta para `/webhooks`: la firma
 * `X-Hub-Signature-256` cubre los bytes exactos que mandó Meta, y un cuerpo
 * parseado y vuelto a serializar produce otra cadena y una firma que no cuadra
 * jamás.
 */
@Controller('webhooks/instagram')
export class InstagramWebhooksController {
  constructor(
    @Inject(InstagramAccountsService) private readonly accounts: InstagramAccountsService,
    @Inject(InstagramInboundService) private readonly inbound: InstagramInboundService,
  ) {}

  /**
   * El saludo de suscripción de Meta. Devuelve `hub.challenge` como TEXTO
   * PLANO —ni JSON, ni entrecomillado— cuando `hub.verify_token` coincide con
   * el guardado para esa cuenta. Cualquier otra cosa es un 403.
   *
   * Meta no dice QUÉ cuenta está verificando, así que igual que en WhatsApp
   * hace falta un `?account=` en la URL de callback que el admin le indica al
   * comerciante pegar en el panel de Meta. Sin él, un saludo no se puede
   * atribuir a ningún inquilino.
   */
  @Get(':provider')
  async verify(
    @Param('provider') provider: string,
    @Query() query: Record<string, string | undefined>,
  ): Promise<string> {
    if (!getInstagramProvider(provider)) throw new HttpException({ error: 'NOT_FOUND' }, 404);

    const igAccountId = query.account;
    if (!igAccountId) throw new HttpException({ error: 'FORBIDDEN' }, 403);

    const resolved = await this.accounts.resolveInbound(provider, igAccountId);
    if (!resolved) throw new HttpException({ error: 'FORBIDDEN' }, 403);

    const challenge = GraphProvider.verifyHandshake(query, resolved.config);
    if (challenge === null) throw new HttpException({ error: 'FORBIDDEN' }, 403);
    return challenge;
  }

  @Post(':provider')
  @HttpCode(200)
  async receive(@Param('provider') providerId: string, @Req() req: Request): Promise<{ ok: true }> {
    const provider = getInstagramProvider(providerId);
    if (!provider) throw new HttpException({ error: 'NOT_FOUND' }, 404);

    const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    const headers = req.headers as Record<string, string | undefined>;

    // La clave de enrutamiento hay que sacarla del payload ANTES de verificar,
    // porque verificar necesita las credenciales que solo tiene la fila a la
    // que se enruta. Ese orden es seguro: leer un campo no es fiarse de él, y
    // el adaptador vuelve a comprobar ese mismo valor contra la configuración
    // que se le entrega — así que un payload que nombre la cuenta de otro se
    // verifica contra SU secreto y falla.
    const igAccountId = extractRoutingKey(raw);
    if (!igAccountId) return { ok: true };

    const resolved = await this.accounts.resolveInbound(providerId, igAccountId);
    // Una cuenta desconocida o desactivada recibe un 200 y nada más. Un 404 le
    // diría a quien llama sin autenticarse qué cuentas atiende esta
    // plataforma, y haría que Meta reintentara una entrega que nunca va a ser
    // válida.
    if (!resolved) return { ok: true };

    const messages = provider.verifyAndParseWebhook(raw, headers, resolved.config);
    if (messages === null) return { ok: true };

    // Dispara y olvida, a propósito: ver el comentario de la clase. `handle` se
    // traga sus propios fallos, así que no hay nada que esperar por corrección
    // y esperarlo solo retrasaría la confirmación que este endpoint existe
    // para mandar rápido.
    for (const message of messages) {
      void this.inbound.handle({
        tenantId: resolved.tenantId,
        accountId: resolved.accountId,
        provider: providerId,
        config: resolved.config,
        message,
      });
    }

    return { ok: true };
  }
}

/**
 * Saca la clave de enrutamiento de un payload SIN VERIFICAR.
 *
 * Deliberadamente mínima y total: corre en un endpoint público antes de
 * cualquier autenticación, así que no puede lanzar ante nada y no puede hacer
 * nada con el valor salvo buscar una fila.
 *
 * Se lee de `entry[].id`, que es donde Meta pone el id de la cuenta de
 * Instagram, y NO de `messaging[].recipient.id`: para un eco de nuestra propia
 * respuesta el destinatario es el comprador, así que enrutar por ahí buscaría
 * una fila con el id de una persona — no encontraría nada y tiraría entregas
 * legítimas del mismo lote.
 */
function extractRoutingKey(raw: string): string | null {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return null;
  }

  for (const entry of asArray(asRecord(payload).entry)) {
    const id = asRecord(entry).id;
    if (typeof id === 'string' && id.length > 0) return id;
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
