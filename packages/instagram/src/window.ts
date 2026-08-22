/**
 * La ventana de 24 horas de la mensajería de Instagram.
 *
 * ## Qué es
 *
 * Meta solo permite responderle libremente a una persona dentro de las 24
 * horas siguientes a SU último mensaje ("standard messaging"). Pasado ese
 * plazo, un envío de texto normal lo rechaza la Graph API, y las únicas
 * salidas son etiquetas de mensaje (`HUMAN_AGENT`, 7 días) que requieren un
 * permiso aprobado por Meta y que están pensadas para que conteste una
 * persona, no un bot.
 *
 * ## Qué decidimos hacer con ella
 *
 * **No intentamos esquivarla.** Ni etiqueta `HUMAN_AGENT` ni nada parecido:
 * esta plataforma no tiene ese permiso, y usar la etiqueta para que responda
 * un agente automático es exactamente el uso que Meta castiga quitándole a la
 * app el permiso de mensajería — es decir, dejando sin canal a TODAS las
 * tiendas, no solo a la que se pasó de lista.
 *
 * Así que el canal comprueba la ventana y, si está cerrada, no responde.
 *
 * ## Por qué no hace falta guardar ningún estado nuevo para esto
 *
 * Parece que hiciera falta un `lastInboundAt` por conversación, y no: el
 * agente de Instagram SOLO habla contestando a un mensaje entrante, y ese
 * mensaje trae su propia marca de tiempo. La ventana se mide siempre contra
 * el mensaje que disparó el turno. Una columna aparte sería un segundo sitio
 * donde tener la misma verdad, con la posibilidad de que se desincronicen.
 *
 * ## Entonces, ¿cuándo se cierra de verdad?
 *
 * Si el comprador escribe y contestamos dos segundos después, la ventana está
 * abierta siempre. Se cierra cuando la entrega llega tarde: Meta reintenta un
 * webhook durante horas, una caída nuestra deja mensajes represados, un turno
 * del modelo se atasca, o el reloj de la máquina va corrido. Son casos raros
 * y son justo los que hay que atajar, porque el envío fallaría igual — pero
 * después de haberle cobrado al comerciante un turno de modelo que nadie va a
 * leer.
 */

/** 24 horas exactas, que es lo que dice la documentación de Meta. */
export const MESSAGING_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Si todavía se le puede contestar libremente a quien mandó un mensaje en
 * `sentAtMs`.
 *
 * Un mensaje con marca de tiempo en el FUTURO cuenta como dentro de la
 * ventana: el desfase de reloj entre Meta y nosotros es de segundos, y
 * tratarlo como "fuera" haría que un reloj adelantado dejara la tienda muda
 * sin ningún motivo. Un mensaje sin marca de tiempo usable (`NaN`, `0`) no lo
 * decide esta función — lo descarta el parseo, que es donde se sabe que el
 * payload venía mal.
 */
export function isWithinMessagingWindow(sentAtMs: number, nowMs: number = Date.now()): boolean {
  if (!Number.isFinite(sentAtMs)) return false;
  return nowMs - sentAtMs < MESSAGING_WINDOW_MS;
}

/**
 * La marca de tiempo de Meta, en milisegundos.
 *
 * La Messenger Platform manda `timestamp` en MILISEGUNDOS (a diferencia de
 * WhatsApp Cloud, que lo manda en segundos), y este es el tipo de detalle en
 * el que un canal se rompe de la peor manera: interpretar milisegundos como
 * segundos pone cada mensaje en el año 57000 y deja la ventana abierta para
 * siempre; al revés, la deja cerrada para siempre y la tienda no contesta
 * nunca.
 *
 * Por eso no se confía en la unidad y se deduce del orden de magnitud: por
 * debajo de 1e12 (que en milisegundos es 2001) el valor solo puede ser
 * segundos. Devuelve `NaN` para cualquier cosa que no sea un número usable, y
 * quien llama descarta el mensaje.
 */
export function normalizeTimestampMs(raw: unknown): number {
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  if (!Number.isFinite(value) || value <= 0) return NaN;
  return value < 1e12 ? value * 1000 : value;
}
