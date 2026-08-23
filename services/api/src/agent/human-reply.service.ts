import { HttpException, Inject, Injectable } from '@nestjs/common';
import { tenantDb, type ConversationChannel } from '@ventia/db';
import { getInstagramProvider, INSTAGRAM_MAX_CHARS } from '@ventia/instagram';
import { getWhatsAppProvider } from '@ventia/whatsapp';
import { WHATSAPP_MAX_CHARS } from './whatsapp-render';
import { InstagramAccountsService } from '../instagram/instagram-accounts.service';
import { WhatsAppNumbersService } from '../whatsapp/whatsapp-numbers.service';
import { isPlanFeatureEnabled, type PlanBooleanFeature } from '../common/plan-limits';
import {
  HUMAN_ATTENDED_STATUS,
  HUMAN_MESSAGE_ROLE,
  instagramReplyWindow,
  type ReplyWindow,
} from './human-takeover';

/**
 * Que una persona del equipo pueda CONTESTAR desde el panel.
 *
 * Es la mitad que le faltaba a `escalate_to_human`: hasta ahora el producto
 * sabía decir «esta conversación necesita a alguien» y no sabía dejar que ese
 * alguien dijera nada. El comerciante leía el transcripto y tenía que salir a
 * abrir Instagram en otra pestaña.
 *
 * ## Lo único que este servicio NO hace, y es lo importante
 *
 * **No antepone la revelación de experiencia automatizada.** `agent.service.ts`
 * se la pone a todo lo que sale del modelo, incluidos sus caminos fijos, y con
 * razón: la política de Meta la exige porque quien escribe es una máquina.
 * Aquí quien escribe es una persona, y decirle a un comprador «te respondo de
 * forma automática» cuando al otro lado hay un ser humano no es cumplir la
 * política: es una afirmación falsa sobre quién está hablando. Por eso el
 * cuerpo que sale por el canal es EXACTAMENTE lo que el comerciante escribió,
 * carácter por carácter, y hay una prueba que lo fija.
 *
 * ## Enviar primero, guardar después
 *
 * El orden importa y no es el habitual. Si se guardara primero y el envío
 * fallara, el transcripto diría que el cliente fue atendido cuando no lo fue —
 * y este panel existe precisamente para que el comerciante sepa a quién le
 * falta contestar. Un transcripto que miente sobre eso es peor que no tenerlo.
 * Al revés (envío hecho, guardado fallido) el comerciante ve el error, reenvía
 * y el comprador recibe algo dos veces: molesto, visible y recuperable.
 */

/** Lo que un canal necesita para poder contestarle a alguien. */
interface ChannelOutbound {
  /** Manda un cuerpo ya troceado. Lanza si el proveedor no acepta. */
  send: (body: string) => Promise<void>;
  /** El tope de caracteres por mensaje de este canal. */
  maxChars: number;
}

/** La entitlement de plan que habilita cada canal. `web` no tiene ninguna: el
 * chat de la tienda viene con todos los planes. */
const PLAN_FEATURE_FOR: Record<ConversationChannel, PlanBooleanFeature | null> = {
  web: null,
  whatsapp: 'whatsappChannel',
  instagram: 'instagramChannel',
};

/**
 * Por qué una conversación no admite una respuesta humana ahora mismo.
 *
 * Son códigos que el panel traduce a español y muestra ANTES de que el
 * comerciante escriba (apps/admin/lib/errors.ts), no excusas que aparecen al
 * pulsar «Enviar». Esa es la diferencia entre una interfaz que se explica y una
 * que se rompe.
 */
export type ReplyBlockedReason =
  /** Instagram: pasaron 24 horas desde el último mensaje del comprador. */
  | 'MESSAGING_WINDOW_CLOSED'
  /** El canal ya no está conectado, está desactivado, o el inquilino tiene
   * varias cuentas y esta conversación es anterior a que se anotara cuál. */
  | 'CHANNEL_NOT_CONNECTED'
  /** El plan de la tienda ya no incluye este canal. */
  | 'CHANNEL_NOT_IN_PLAN'
  /** No hay a quién escribirle: una conversación del widget web de alguien que
   * nunca dejó un contacto. */
  | 'SHOPPER_UNREACHABLE';

export interface ReplyState {
  /** Si el panel debe dejar escribir. */
  canReply: boolean;
  /** Por qué no, cuando no. */
  blockedReason: ReplyBlockedReason | null;
  /** Cuándo se cierra la ventana de 24 horas, para poder avisar antes de que
   * se cierre. `null` en los canales sin ventana y cuando no se sabe. */
  windowClosesAt: Date | null;
  /** El tope de caracteres del canal, para que el cuadro de texto lo enseñe. */
  maxChars: number;
}

/** La fila de conversación que este servicio necesita ver. Un `Pick` y no la
 * fila entera, para que la firma diga exactamente de qué depende. */
export interface ReplyableConversation {
  id: string;
  channel: ConversationChannel;
  status: string;
  shopperRef: string | null;
  lastInboundAt: Date | null;
  channelAccountId: string | null;
}

@Injectable()
export class HumanReplyService {
  constructor(
    @Inject(InstagramAccountsService) private readonly instagram: InstagramAccountsService,
    @Inject(WhatsAppNumbersService) private readonly whatsapp: WhatsAppNumbersService,
  ) {}

  /**
   * Si esta conversación admite una respuesta humana, y si no, por qué.
   *
   * Se calcula al ABRIR el transcripto, no al enviar. Un comerciante que
   * escribe tres párrafos para que un botón le conteste «no se pudo» ha perdido
   * el tiempo por un dato que ya teníamos antes de que empezara a escribir.
   */
  async replyState(tenantId: string, conversation: ReplyableConversation): Promise<ReplyState> {
    const maxChars = MAX_CHARS_FOR[conversation.channel];
    const blocked = (blockedReason: ReplyBlockedReason, windowClosesAt: Date | null = null): ReplyState => ({
      canReply: false,
      blockedReason,
      windowClosesAt,
      maxChars,
    });

    const feature = PLAN_FEATURE_FOR[conversation.channel];
    if (feature && !(await isPlanFeatureEnabled(tenantId, feature))) return blocked('CHANNEL_NOT_IN_PLAN');

    if (conversation.channel === 'web') {
      // El widget no tiene ventana ni credenciales: el comprador lo lee
      // mientras la pestaña siga abierta. Que la haya cerrado no lo sabemos, y
      // fingir que sí lo sabemos deshabilitando el cuadro sería inventarnos un
      // estado.
      return { canReply: true, blockedReason: null, windowClosesAt: null, maxChars };
    }

    if (!conversation.shopperRef) return blocked('SHOPPER_UNREACHABLE');
    if (!(await this.hasOutboundRoute(tenantId, conversation))) return blocked('CHANNEL_NOT_CONNECTED');

    const window = await this.messagingWindow(tenantId, conversation);
    if (!window.open) return blocked('MESSAGING_WINDOW_CLOSED', window.closesAt);

    return { canReply: true, blockedReason: null, windowClosesAt: window.closesAt, maxChars };
  }

  /**
   * Manda lo que escribió el comerciante por el canal de la conversación y lo
   * deja en el transcripto con rol `human`.
   *
   * Además pone la conversación en `human`, que es lo que calla al agente: a
   * partir de aquí el comprador le escribe a una persona, y el bot contestando
   * por encima sería el peor momento posible para que lo hiciera. Se devuelve
   * al asistente desde el panel.
   */
  async send(
    tenantId: string,
    conversation: ReplyableConversation,
    text: string,
  ): Promise<{ id: string; role: string; content: string; createdAt: Date }> {
    const state = await this.replyState(tenantId, conversation);
    if (!state.canReply) {
      // 409 y no 400: no hay nada malo en lo que mandó el panel — es el estado
      // del mundo el que cambió desde que se pintó la pantalla (se cerró la
      // ventana, el comerciante desconectó la cuenta en otra pestaña). El
      // código va en `error` para que el panel muestre el mismo texto que ya
      // sabe mostrar cuando lo detecta antes.
      throw new HttpException({ error: state.blockedReason }, 409);
    }

    const outbound = await this.outboundFor(tenantId, conversation);
    if (outbound) {
      const bodies = splitForChannel(text, outbound.maxChars);
      for (const body of bodies) {
        // Secuencial y no en paralelo, igual que en los caminos de entrada: ni
        // Instagram ni WhatsApp garantizan el orden entre envíos concurrentes,
        // y media respuesta que llega antes que su principio se lee como algo
        // roto.
        try {
          await outbound.send(body);
        } catch (err) {
          console.error('[atencion-humana] el canal rechazó la respuesta del comerciante', {
            tenantId,
            conversationId: conversation.id,
            channel: conversation.channel,
            error: err instanceof Error ? err.message : String(err),
          });
          // 502 y nada guardado: el comerciante tiene que poder ver que su
          // respuesta NO salió. Ver la nota de cabecera sobre el orden.
          throw new HttpException({ error: 'REPLY_NOT_DELIVERED' }, 502);
        }
      }
    }

    const db = tenantDb(tenantId);
    const message = await db.message.create({
      data: {
        tenantId,
        conversationId: conversation.id,
        // `human`, nunca `assistant`. Es lo que hace que el transcripto diga
        // quién dijo qué, y es lo que le dice al agente —si le devuelven la
        // conversación— que quien habló antes no fue él y que le toca volver a
        // revelarse.
        role: HUMAN_MESSAGE_ROLE,
        // Tal cual, sin revelación y sin prefijo ninguno. Ver la cabecera.
        content: text,
      },
      select: { id: true, role: true, content: true, createdAt: true },
    });

    await db.conversation.update({
      where: { id: conversation.id },
      data: { status: HUMAN_ATTENDED_STATUS },
    });

    return message;
  }

  /** Si el canal tiene por dónde salir: cuenta conectada y proveedor conocido. */
  private async hasOutboundRoute(tenantId: string, conversation: ReplyableConversation): Promise<boolean> {
    return (await this.outboundFor(tenantId, conversation)) !== null;
  }

  /**
   * El envío concreto de este canal, ya con credenciales, o `null`.
   *
   * `null` para `web` sin que eso sea un fallo: ahí no hay nada que enviar
   * porque el widget lee el transcripto, así que la respuesta humana se
   * "entrega" guardándola. Los dos canales de Meta devuelven `null` solo cuando
   * de verdad no hay ruta, y quien llama lo convierte en
   * `CHANNEL_NOT_CONNECTED`.
   */
  private async outboundFor(
    tenantId: string,
    conversation: ReplyableConversation,
  ): Promise<ChannelOutbound | null> {
    const to = conversation.shopperRef;
    if (!to) return null;

    if (conversation.channel === 'instagram') {
      const resolved = await this.instagram.resolveOutbound(tenantId, conversation.channelAccountId);
      if (!resolved) return null;
      const provider = getInstagramProvider(resolved.provider);
      if (!provider) return null;
      return {
        send: (body) => provider.sendText(to, body, resolved.config),
        maxChars: INSTAGRAM_MAX_CHARS,
      };
    }

    if (conversation.channel === 'whatsapp') {
      const resolved = await this.whatsapp.resolveOutbound(tenantId, conversation.channelAccountId);
      if (!resolved) return null;
      const provider = getWhatsAppProvider(resolved.provider);
      if (!provider) return null;
      return {
        send: (body) => provider.sendText(to, body, resolved.config),
        maxChars: WHATSAPP_MAX_CHARS,
      };
    }

    return null;
  }

  /**
   * La ventana de mensajería que aplica a esta conversación.
   *
   * Solo Instagram por ahora, y conviene decir por qué no WhatsApp aunque la
   * Cloud API tenga una ventana de 24 horas idéntica: `@ventia/whatsapp` no
   * expone ni la marca de tiempo del mensaje entrante (`InboundMessage` no
   * lleva `timestamp`) ni un equivalente de `isWithinMessagingWindow`, y el
   * otro proveedor de ese paquete —Evolution, un teléfono real emparejado por
   * QR— no tiene ventana ninguna. Inventarse aquí la regla de WhatsApp a partir
   * de la constante de Instagram sería adivinar en el sitio equivocado. Queda
   * reportado como cambio pendiente en `packages/whatsapp`.
   */
  private async messagingWindow(
    tenantId: string,
    conversation: ReplyableConversation,
  ): Promise<ReplyWindow> {
    if (conversation.channel !== 'instagram') return { open: true, closesAt: null };

    let lastInboundAt = conversation.lastInboundAt;
    if (!lastInboundAt) {
      // Conversación anterior a `Conversation.lastInboundAt`. Se cae al último
      // mensaje del comprador que haya en el transcripto: es nuestra hora de
      // recepción y no la de envío, así que puede sobrestimar el plazo en lo
      // que tardara la entrega. Ver `instagramReplyWindow` para por qué eso se
      // prefiere a negarse.
      const lastUser = await tenantDb(tenantId).message.findFirst({
        where: { tenantId, conversationId: conversation.id, role: 'user' },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      });
      lastInboundAt = lastUser?.createdAt ?? null;
    }
    return instagramReplyWindow(lastInboundAt);
  }
}

/** El tope por canal, para que el panel pinte un contador con el número de
 * verdad en vez de uno inventado. */
const MAX_CHARS_FOR: Record<ConversationChannel, number> = {
  // El widget lo renderiza esta misma plataforma, así que el único tope que
  // tiene sentido es el mismo del cuadro de texto del comprador.
  web: 2000,
  whatsapp: WHATSAPP_MAX_CHARS,
  instagram: INSTAGRAM_MAX_CHARS,
};

/** Los mismos separadores, y en el mismo orden, que usan `whatsapp-render.ts` e
 * `instagram-render.ts`. */
const SEPARATORS = ['\n\n', '\n', ' '] as const;

/**
 * Parte lo que escribió el comerciante en cuerpos que el canal acepte.
 *
 * Partir, nunca truncar: Meta rechaza el mensaje ENTERO por pasarse de largo,
 * así que un texto de 1200 caracteres en Instagram sin esto no llega a medias,
 * no llega. El comerciante que pegó una política de devoluciones no debería
 * tener que enterarse de que existe un tope.
 *
 * Tercera copia del ayudante de `whatsapp-render.ts` (la segunda es
 * `instagram-render.ts`), y por lo que ese archivo ya dejó escrito: es la
 * convención de este repositorio para ayudantes de este tamaño, y exportar el
 * de allí volvería API pública un detalle interno de aquel módulo. Este además
 * no es igual: no hay resultados de herramienta que renderizar, solo texto.
 */
export function splitForChannel(text: string, limit: number): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  if (trimmed.length <= limit) return [trimmed];

  const chunks: string[] = [];
  let rest = trimmed;
  while (rest.length > limit) {
    const head = rest.slice(0, limit);
    let cut = -1;
    for (const separator of SEPARATORS) {
      cut = head.lastIndexOf(separator);
      if (cut > 0) {
        cut += separator.length;
        break;
      }
    }
    // Ni un separador dentro del tope: una sola palabra más larga que un
    // mensaje entero. Se corta en seco antes que perder caracteres.
    if (cut <= 0) cut = limit;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut);
  }
  const tail = rest.trim();
  if (tail.length > 0) chunks.push(tail);
  return chunks.filter((chunk) => chunk.length > 0);
}
