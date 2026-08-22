import { Inject, Injectable } from '@nestjs/common';
import { platformDb, tenantDb } from '@ventia/db';
import {
  getInstagramProvider,
  isWithinMessagingWindow,
  MESSAGING_WINDOW_MS,
  type InboundInstagramMessage,
  type InstagramConfig,
} from '@ventia/instagram';
import { AgentService } from '../agent/agent.service';
import { isPlanFeatureEnabled } from '../common/plan-limits';
import { renderForInstagram } from './instagram-render';
import { tenantStorefrontBaseUrl } from '../tenants/tenant-public-url';

/**
 * Convierte un mensaje directo de Instagram ya verificado en un turno del
 * agente y manda la respuesta de vuelta.
 *
 * Es un tercer transporte hacia `AgentService.respond`, que ya es agnóstico
 * del canal. Aquí no se decide nada de lo que se dice: las herramientas, el
 * tope de presupuesto y el freno por conversación se comportan igual que en el
 * chat de la tienda y en WhatsApp, que es justo el sentido de haber construido
 * el bucle así.
 *
 * ## Entrega, no petición/respuesta
 *
 * Un webhook de pago puede contestarle a la pasarela con el resultado. Este
 * no: la respuesta al comprador sale por una llamada SEPARADA a la Graph API, y
 * el POST de Meta solo necesita un 200 rápido o reintenta. Así que el
 * controlador confirma de inmediato y esto corre después — lo que significa que
 * cada fallo de aquí se gestiona aquí. No hay a quién devolverle un error.
 */

@Injectable()
export class InstagramInboundService {
  constructor(@Inject(AgentService) private readonly agent: AgentService) {}

  /**
   * Gestiona un mensaje de principio a fin: duplicados, ventana de 24 horas,
   * puerta de plan, turno del agente, envío.
   *
   * No lanza nunca. Un mensaje que no se puede contestar se registra y se tira,
   * porque la alternativa —un rechazo sin capturar en una llamada
   * dispara-y-olvida— tumba el proceso por la mala suerte de un comprador.
   */
  async handle(input: {
    tenantId: string;
    accountId: string;
    provider: string;
    config: InstagramConfig;
    message: InboundInstagramMessage;
  }): Promise<void> {
    const { tenantId, message } = input;
    try {
      if (await this.isDuplicate(tenantId, message.externalId)) return;

      // ## La ventana de 24 horas, comprobada ANTES de gastar un turno
      //
      // Instagram solo deja responder libremente dentro de las 24 horas
      // siguientes al último mensaje de la persona (ver `window.ts` en
      // packages/instagram para por qué no la esquivamos con etiquetas).
      // Fuera de ella la Graph API rechaza el envío.
      //
      // Se comprueba aquí, antes de llamar al modelo, y no solo al enviar:
      // generar una respuesta que sabemos que no se puede entregar es
      // cobrarle al comerciante créditos por un texto que nadie va a leer.
      //
      // Que esto salte quiere decir que la entrega llegó tarde: un reintento
      // de Meta después de horas, mensajes represados por una caída nuestra, o
      // un reloj corrido. Por eso se registra en vez de descartarse en
      // silencio — es un síntoma, no ruido.
      if (!isWithinMessagingWindow(message.sentAtMs)) {
        console.warn('[instagram] mensaje fuera de la ventana de 24 horas, no se responde', {
          tenantId,
          externalId: message.externalId,
          edadMs: Date.now() - message.sentAtMs,
          ventanaMs: MESSAGING_WINDOW_MS,
        });
        return;
      }

      // La puerta de plan, comprobada en CADA mensaje entrante y no solo al
      // conectar. Una tienda que baje de plan conserva su cuenta registrada y
      // Meta sigue entregando; sin esto seguiría contestando —y gastando
      // presupuesto de IA— por un canal que ya no paga. Emprende no lo
      // incluye.
      if (!(await isPlanFeatureEnabled(tenantId, 'instagramChannel'))) return;

      const conversationId = await this.resolveConversation(tenantId, message.from);
      const reply = await this.agent.respond({
        tenantId,
        conversationId,
        // El IGSID de quien escribe ES la identidad del comprador aquí, al
        // contrario que en el chat de la tienda, donde es null. Es lo que hace
        // que una conversación de Instagram se pueda retomar días después y lo
        // que le da a `escalate_to_human` un contacto de verdad que pasarle al
        // comerciante.
        shopperRef: message.from,
        message: message.text,
        // Se arrastra para que la fila del usuario lo guarde y
        // `@@unique([tenantId, externalId])` se convierta en la garantía de
        // verdad. La comprobación de duplicado de arriba es el camino barato
        // que evita una llamada al modelo; esta es la que no se puede correr.
        externalId: message.externalId,
      });

      const baseUrl = await this.storefrontBaseUrl(tenantId);
      const bodies = renderForInstagram(reply, baseUrl);

      const provider = getInstagramProvider(input.provider);
      if (!provider) return;
      for (const body of bodies) {
        // Segunda comprobación de la ventana, dentro del bucle: el turno del
        // modelo puede haber tardado, y con varios mensajes seguidos el último
        // sale más tarde que el primero. Cuesta una resta y evita el caso
        // exacto en que la mitad de una respuesta llega y la otra mitad la
        // rechaza Meta.
        if (!isWithinMessagingWindow(message.sentAtMs)) {
          console.warn('[instagram] la ventana se cerró durante el turno, respuesta incompleta', {
            tenantId,
            externalId: message.externalId,
          });
          return;
        }
        // Secuencial y no en paralelo: Instagram no garantiza el orden entre
        // envíos concurrentes, y una lista de productos que llega antes de la
        // frase que la presenta se lee como algo roto.
        await provider.sendText(message.from, body, input.config);
      }
    } catch (err) {
      console.error('[instagram] no se pudo atender el mensaje entrante', {
        tenantId,
        externalId: message.externalId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Comprobación barata de una entrega que ya contestamos.
   *
   * NO es la garantía: la garantía es `@@unique([tenantId, externalId])` sobre
   * `Message`, que `AgentService.respond` hace saltar al insertar la fila del
   * usuario — y la inserta ANTES de llamar al modelo, así que un reintento que
   * se cuele por aquí tampoco le cuesta nada al comerciante.
   *
   * Se queda porque es gratis y el índice no: sin ella, cada reintento cuesta
   * una búsqueda de conversación, una inserción fallida y una excepción, y
   * Meta reintenta con ganas.
   *
   * Las pruebas por mutación lo confirman en este canal, no solo en el de
   * WhatsApp: borrar esta línea deja verde toda la suite (el índice absorbe el
   * reintento igual), mientras que dejar de registrar `externalId` en la
   * llamada al agente la pone roja. La garantía está donde dice este
   * comentario, y hay una prueba que lo sostiene.
   */
  private async isDuplicate(tenantId: string, externalId: string): Promise<boolean> {
    const existing = await tenantDb(tenantId).message.findFirst({
      where: { tenantId, externalId },
      select: { id: true },
    });
    return existing !== null;
  }

  /**
   * La conversación en curso del comprador, o una nueva.
   *
   * Buscada por `(tenantId, channel, shopperRef)` y no por una cookie: en
   * Instagram el hilo ES el histórico, y quien escribió la semana pasada
   * espera que la tienda se acuerde. Reutiliza la conversación más reciente que
   * no esté resuelta, para que marcar una como atendida haga que el siguiente
   * mensaje empiece limpio en vez de reabrir un caso cerrado.
   *
   * El canal es `instagram` y no `whatsapp`: son la misma persona con dos
   * identificadores incomparables (un IGSID no es un teléfono), y mezclarlos
   * en un canal cualquiera haría que el panel de conversaciones y el desglose
   * por canal del tablero mintieran.
   */
  private async resolveConversation(tenantId: string, shopperRef: string): Promise<string> {
    const db = tenantDb(tenantId);
    const existing = await db.conversation.findFirst({
      where: { tenantId, channel: 'instagram', shopperRef, status: { not: 'resolved' } },
      orderBy: { startedAt: 'desc' },
    });
    if (existing) return existing.id;

    const created = await db.conversation.create({
      data: { tenantId, channel: 'instagram', shopperRef, status: 'open' },
    });
    return created.id;
  }

  /**
   * El origen público de la tienda de ESTE inquilino, para volver absolutas
   * las URLs relativas que devuelven las herramientas.
   *
   * Un `/producto/camisa` relativo no significa nada dentro de un mensaje
   * directo: no hay página respecto a la cual sea relativo. Y tiene que ser el
   * dominio de este inquilino: es la misma trampa de multi-inquilino que
   * pisaron los adaptadores de pago, donde una URL base global mandaba a los
   * compradores de todas las tiendas a la que nombrara esa variable.
   */
  private async storefrontBaseUrl(tenantId: string): Promise<string> {
    const domain = await platformDb.tenantDomain.findFirst({
      where: { tenantId },
      // Primero el primario y luego por `domain`, para desempatar de forma
      // estable. `TenantDomain` no tiene `createdAt`, así que "el más antiguo"
      // no existe — y un findFirst sin orden elegiría un dominio distinto en
      // cada ejecución, que para un inquilino con varios significa el mismo
      // comprador recibiendo enlaces en hosts diferentes.
      orderBy: [{ isPrimary: 'desc' }, { domain: 'asc' }],
    });
    return tenantStorefrontBaseUrl(domain?.domain ?? '');
  }
}
