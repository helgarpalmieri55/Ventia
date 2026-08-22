/**
 * La abstracción de proveedor del canal de Instagram.
 *
 * Tiene deliberadamente la misma forma que `@ventia/whatsapp`: una interfaz,
 * un registro, un `fetch` inyectable para poder probar cada adaptador sin red,
 * y ni NestJS ni Prisma por ningún lado — este paquete sabe de formatos de
 * cable y de nada más.
 *
 * ## Por qué hay UN solo adaptador y aun así hay interfaz y registro
 *
 * WhatsApp tiene dos proveedores porque los entornos son distintos de verdad
 * (Evolution en desarrollo, Cloud API en producción). Instagram no tiene
 * equivalente autoalojado: la mensajería de una cuenta profesional de
 * Instagram pasa por Meta o no pasa. Lo que sí existen son dos integraciones
 * de Meta para lo mismo:
 *
 *   - **Instagram API con Facebook Login** — la cuenta de Instagram está
 *     vinculada a una página de Facebook, el token es un token de página y los
 *     webhooks se suscriben sobre esa página. Es la que implementa
 *     {@link GraphProvider} y la que usa la mayoría de las tiendas.
 *   - **Instagram API con Instagram Login** — sin página de Facebook, token de
 *     la propia cuenta y envío contra `graph.instagram.com`.
 *
 * La segunda cambia el host de envío y el tipo de token, no el formato del
 * webhook. Cuando haga falta, entra como un segundo adaptador detrás de esta
 * interfaz y como un valor más de `InstagramProviderId`; para eso existen la
 * interfaz y el registro con un único miembro hoy.
 *
 * ## Los formatos de cable se leyeron de la documentación, no de memoria
 *
 * Cada adaptador cita contra qué se escribió. Lo que NO se afirma: aquí no
 * hubo ninguna app de Meta real, así que esto está verificado contra los
 * payloads de ejemplo de la documentación, no contra tráfico capturado.
 */

export type InstagramProviderId = 'graph';

/** Un mensaje entrante de Instagram, normalizado. */
export interface InboundInstagramMessage {
  /**
   * El IGSID del comprador: el id con el que Instagram identifica a esa
   * persona FRENTE A ESTA CUENTA, y el único identificador que Meta nos da.
   *
   * No es el @usuario y no sirve para nada más: es opaco, es distinto para la
   * misma persona en otra cuenta de negocio, y es a la vez el
   * `Conversation.shopperRef` y el `recipient.id` de la respuesta.
   */
  from: string;
  /** El texto del mensaje. Lo que no es texto no se devuelve — ver el parseo. */
  text: string;
  /** El `mid` de Meta, para descartar entregas repetidas. Meta reintenta, y
   * reintenta con el mismo `mid`. */
  externalId: string;
  /**
   * Cuándo lo mandó el comprador, en milisegundos epoch.
   *
   * No es decorativo: es el origen de la ventana de 24 horas
   * ({@link isWithinMessagingWindow}). Sin este dato no se puede saber si la
   * respuesta que estamos a punto de generar se puede entregar.
   */
  sentAtMs: number;
}

/**
 * Todo lo que un adaptador necesita para hablar por UNA cuenta de un
 * inquilino.
 *
 * Lo arma la API a partir de la fila `InstagramAccount` (y de sus credenciales
 * descifradas) — este paquete no lee ninguna base de datos.
 */
export interface InstagramConfig {
  /**
   * LA clave de enrutamiento: el id de la cuenta profesional de Instagram, que
   * es lo que Meta pone en `entry[].id` de cada entrega y lo que va en la ruta
   * del envío.
   */
  igAccountId: string;
  /** Token de acceso de la página vinculada, va como `Authorization: Bearer`. */
  token: string;
  /** El app secret de Meta, para `X-Hub-Signature-256`. */
  appSecret?: string;
  /** El token que se devuelve en el saludo GET de Meta. */
  verifyToken?: string;
}

export interface InstagramProvider {
  readonly id: InstagramProviderId;
  /**
   * Verifica una entrega y saca de ella todos los mensajes de texto.
   *
   * Devuelve `null` cuando el payload no es auténtico — firma mala, forma que
   * no es la de este proveedor. Quien llama responde 200 y lo tira: Meta
   * reintenta ante cualquier cosa que no sea 2xx, y reintentar no va a volver
   * válido un payload falsificado o roto.
   *
   * Devuelve un ARRAY porque una sola entrega puede traer varios mensajes.
   * Devolver uno solo se comería en silencio la segunda línea del comprador.
   * Una entrega auténtica sin mensajes de texto (un `read`, un eco, una
   * reacción) da `[]`, que es distinto de `null` y tiene que seguir siéndolo.
   */
  verifyAndParseWebhook(
    rawBody: string,
    headers: Record<string, string | undefined>,
    config: InstagramConfig,
  ): InboundInstagramMessage[] | null;

  /** Manda un mensaje de texto. Lanza si Meta no responde 2xx, para que quien
   * llama lo registre: la respuesta del agente no es algo que se pueda perder
   * en silencio. */
  sendText(to: string, body: string, config: InstagramConfig, fetchImpl?: typeof fetch): Promise<void>;
}

export { GraphProvider, INSTAGRAM_MAX_CHARS } from './graph.js';
export { InstagramError } from './errors.js';
export { getInstagramProvider, INSTAGRAM_PROVIDER_IDS } from './registry.js';
export { MESSAGING_WINDOW_MS, isWithinMessagingWindow, normalizeTimestampMs } from './window.js';
