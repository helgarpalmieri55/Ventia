import { createHmac, timingSafeEqual } from 'node:crypto';
import { InstagramError } from './errors.js';
import type { InboundInstagramMessage, InstagramConfig, InstagramProvider } from './index.js';
import { normalizeTimestampMs } from './window.js';

/**
 * Instagram API con Facebook Login, sobre la Graph API de Meta.
 *
 * Escrito contra la documentación oficial leída en el momento de
 * implementarlo:
 *  - webhook de mensajería de Instagram:
 *    https://developers.facebook.com/docs/messenger-platform/instagram/features/webhook
 *  - firma y saludo GET:
 *    https://developers.facebook.com/docs/graph-api/webhooks/getting-started
 *  - envío:
 *    https://developers.facebook.com/docs/messenger-platform/instagram/features/send-message
 *
 * No está verificado contra una app de Meta viva — aquí no había ninguna. Las
 * fixtures de `test/` son los payloads de ejemplo de esa documentación.
 */

/** Fijada a propósito, no flotante. Meta versiona la Graph API y deprecia
 * versiones con calendario; un `/latest` cambiaría el comportamiento de este
 * adaptador sin desplegar nada, que es justo lo que no se quiere en el camino
 * por el que viaja el mensaje de un cliente. Se sube a mano. */
const GRAPH_VERSION = 'v21.0';

/**
 * El máximo de caracteres de un mensaje de texto de Instagram.
 *
 * Es 1000, no los 4096 de WhatsApp, y esa diferencia es de las que rompen un
 * canal en producción: el mismo turno del agente que cabe en un mensaje de
 * WhatsApp se parte en cuatro aquí, y si no se parte, Meta lo rechaza entero
 * — el comprador no recibe nada, no recibe la mitad.
 */
export const INSTAGRAM_MAX_CHARS = 1000;

export class GraphProvider implements InstagramProvider {
  readonly id = 'graph' as const;

  verifyAndParseWebhook(
    rawBody: string,
    headers: Record<string, string | undefined>,
    config: InstagramConfig,
  ): InboundInstagramMessage[] | null {
    if (!this.verifySignature(rawBody, headers, config)) return null;

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return null;
    }

    const root = asRecord(payload);
    // Meta marca así toda entrega de Instagram. Un payload sin esto es el
    // webhook de otro producto apuntando a la URL equivocada — y en concreto
    // un `whatsapp_business_account` parseado aquí sería un mensaje de
    // WhatsApp contestado por el canal de Instagram.
    if (root.object !== 'instagram') return null;

    const messages: InboundInstagramMessage[] = [];
    for (const rawEntry of asArray(root.entry)) {
      const entry = asRecord(rawEntry);

      // La clave de enrutamiento, comprobada AQUÍ y no dada por buena porque
      // quien llama buscó la fila con ella. Una sola app de Meta entrega por
      // todas las cuentas conectadas a ella, así que esta URL recibe el
      // tráfico de otros inquilinos; contestar un mensaje cuyo `entry.id` no
      // es el de esta cuenta sería una tienda respondiéndole al cliente de
      // otra.
      if (entry.id !== config.igAccountId) continue;

      // `standby` en vez de `messaging` significa que otra app tiene el
      // control de esa conversación (protocolo de traspaso de Meta). Son
      // eventos informativos: contestarlos es hablar por encima de quien está
      // atendiendo, y además el envío fallaría.
      for (const rawEvent of asArray(entry.messaging)) {
        const message = this.parseEvent(asRecord(rawEvent), config);
        if (message) messages.push(message);
      }
    }
    return messages;
  }

  /**
   * El saludo GET de Meta: devolver `hub.challenge` tal cual, en texto plano,
   * pero solo si `hub.verify_token` coincide. Devuelve `null` si no, y quien
   * llama responde 403.
   *
   * Estático y no parte de la interfaz, igual que en `@ventia/whatsapp`: es
   * una operación de la suscripción, no de una conversación, y no necesita
   * instancia.
   */
  static verifyHandshake(
    query: Record<string, string | undefined>,
    config: InstagramConfig,
  ): string | null {
    if (query['hub.mode'] !== 'subscribe') return null;
    const supplied = query['hub.verify_token'];
    const expected = config.verifyToken;
    if (!expected || typeof supplied !== 'string') return null;
    if (!constantTimeEquals(supplied, expected)) return null;
    return typeof query['hub.challenge'] === 'string' ? query['hub.challenge'] : null;
  }

  /**
   * Manda un mensaje de texto.
   *
   * La ruta lleva el id de la CUENTA DE INSTAGRAM, no el de la página: la
   * página es de dónde sale el token, pero quien habla es la cuenta.
   *
   * El token va en la cabecera `Authorization` y no como parámetro
   * `access_token` en la URL, aunque la Graph API acepte las dos formas: una
   * URL termina en los logs de acceso, en las trazas y en los mensajes de
   * error, y ahí no puede haber un token de página.
   *
   * Sin `messaging_type` ni etiquetas: eso es de Messenger sobre páginas. La
   * mensajería de Instagram solo admite la respuesta dentro de la ventana de
   * 24 horas, y esa ventana la comprueba quien llama ANTES de gastarse un
   * turno de modelo (ver `window.ts`).
   */
  async sendText(
    to: string,
    body: string,
    config: InstagramConfig,
    fetchImpl: typeof fetch = fetch,
  ): Promise<void> {
    const res = await fetchImpl(
      `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(config.igAccountId)}/messages`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          recipient: { id: to },
          message: { text: body },
        }),
      },
    );

    if (!res.ok) {
      throw new InstagramError('graph', res.status, await res.text().catch(() => ''));
    }
  }

  /**
   * Un evento de `entry[].messaging[]`, o `null` si no es un mensaje de texto
   * de un comprador.
   *
   * Todo lo que se descarta aquí se descarta por un motivo concreto, y ninguno
   * es "por si acaso":
   */
  private parseEvent(event: Record<string, unknown>, config: InstagramConfig): InboundInstagramMessage | null {
    const message = asRecord(event.message);
    // `read`, `reaction`, `postback` y demás llegan por el mismo array.
    if (Object.keys(message).length === 0) return null;

    // Nuestras propias respuestas vuelven por aquí. Contestarlas sería el
    // agente hablando solo, para siempre, con el presupuesto del comerciante.
    // Se comprueban las dos señales porque son independientes: `is_echo` es lo
    // que documenta Meta, y el remitente igual a la cuenta lo pilla igual si
    // ese campo faltara.
    if (message.is_echo === true) return null;

    const from = asRecord(event.sender).id;
    if (typeof from !== 'string' || from.length === 0) return null;
    if (from === config.igAccountId) return null;

    // Un mensaje borrado por quien lo escribió, o de un tipo que la API no
    // sabe representar. En los dos casos no hay texto que contestar.
    if (message.is_deleted === true || message.is_unsupported === true) return null;

    const externalId = message.mid;
    if (typeof externalId !== 'string' || externalId.length === 0) return null;

    // Solo texto. Una foto o un audio son mensajes de verdad que mandó un
    // comprador, pero este agente no tiene ninguna herramienta que sepa
    // actuar sobre ellos y contestarlos como si fueran texto produce
    // disparates. Un comentario sobre una foto de la tienda (`reply_to`) sí
    // trae texto y sí se contesta: es una pregunta escrita.
    const text = message.text;
    if (typeof text !== 'string' || text.trim().length === 0) return null;

    // Sin marca de tiempo usable no se puede decidir la ventana de 24 horas, y
    // decidirla a ojo es exactamente lo que hace que Meta rechace el envío
    // después de haber pagado el turno. Se descarta, con la misma lógica que
    // el resto: un mensaje que no podemos contestar bien es mejor no
    // contestarlo.
    const sentAtMs = normalizeTimestampMs(event.timestamp);
    if (Number.isNaN(sentAtMs)) return null;

    return { from, text, externalId, sentAtMs };
  }

  /**
   * `X-Hub-Signature-256: sha256=<hmac hex del cuerpo CRUDO con el app
   * secret>`.
   *
   * El cuerpo crudo importa: volver a serializar el JSON parseado da otros
   * bytes (orden de claves, espacios, formato de números) y una firma que no
   * cuadra nunca. Por eso `main.ts` monta `express.raw` en `/webhooks`.
   *
   * Una configuración sin `appSecret` falla CERRADO. Meta documenta la
   * verificación de firma como opcional, lo cual es cierto del protocolo y
   * falso de este sistema: sin ella, cualquiera que descubra un id de cuenta
   * de Instagram — un dato que va en cada entrega y que no es secreto — puede
   * mandar mensajes que el agente de un comerciante va a contestar y pagar.
   */
  private verifySignature(
    rawBody: string,
    headers: Record<string, string | undefined>,
    config: InstagramConfig,
  ): boolean {
    if (!config.appSecret) return false;
    const header = headers['x-hub-signature-256'];
    if (typeof header !== 'string' || !header.startsWith('sha256=')) return false;

    const expected = createHmac('sha256', config.appSecret).update(rawBody, 'utf8').digest('hex');
    return constantTimeEquals(header.slice('sha256='.length), expected);
  }
}

/** Comparación independiente de la longitud. `timingSafeEqual` lanza si las
 * longitudes no coinciden, y eso ya filtraría la longitud, así que se comparan
 * los dos lados pasados por un hash de ancho fijo. */
function constantTimeEquals(a: string, b: string): boolean {
  const ha = createHmac('sha256', 'cmp').update(a).digest();
  const hb = createHmac('sha256', 'cmp').update(b).digest();
  return timingSafeEqual(ha, hb);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
