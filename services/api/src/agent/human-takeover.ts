import { isWithinMessagingWindow, MESSAGING_WINDOW_MS } from '@ventia/instagram';
import { needsDisclosure } from './system-prompt';

/**
 * Las reglas de la atención humana, como funciones puras.
 *
 * Aquí no hay Nest, ni Prisma, ni red. Es deliberado y por la misma razón que
 * `system-prompt.ts` es puro: lo que decide si un comprador recibe —o no
 * recibe— la revelación de que le contesta una máquina es una regla que un
 * revisor de Meta va a leer, y una regla así se fija en una prueba sin base de
 * datos o no se fija en ninguna parte.
 *
 * Las tres decisiones que viven aquí:
 *
 *  1. Cuándo calla el agente porque hay una persona atendiendo.
 *  2. Cuándo hay que VOLVER a revelar que el agente es automatizado.
 *  3. Si la ventana de 24 horas de Instagram todavía admite un mensaje.
 */

/** El rol con el que se guarda lo que escribió una persona del equipo.
 *
 * Separado de `assistant` porque son cosas distintas y el transcripto tiene
 * que poder decir cuál fue cuál: `assistant` acarrea la revelación de
 * automatización, y una persona no la lleva. */
export const HUMAN_MESSAGE_ROLE = 'human';

/** El estado de una conversación que atiende una persona. Mientras dure, el
 * agente guarda lo que llega y no contesta. */
export const HUMAN_ATTENDED_STATUS = 'human';

/** Los roles que forman el transcripto que lee el comerciante (y que se le
 * reenvía al modelo). `tool` queda fuera: es un registro de depuración, no algo
 * que nadie dijera. */
export const TRANSCRIPT_ROLES = ['user', 'assistant', 'human'] as const;

/** Los roles que salieron DE LA TIENDA hacia el comprador, sea quien sea quien
 * los escribiera. Es el conjunto con el que se decide si toca revelar. */
export const OUTBOUND_ROLES = ['assistant', HUMAN_MESSAGE_ROLE] as const;

/** Si esta conversación la está atendiendo una persona ahora mismo. */
export function isHumanAttended(status: string | null | undefined): boolean {
  return status === HUMAN_ATTENDED_STATUS;
}

/**
 * Si el próximo mensaje del agente tiene que volver a revelar que es
 * automatizado, mirando lo ÚLTIMO que salió de la tienda.
 *
 * Dos casos, y el segundo es el que añade la atención humana:
 *
 *  - Lo último lo escribió el agente: vale la regla de siempre, la de
 *    `needsDisclosure` — se revela al abrir una sesión nueva, no en cada
 *    mensaje, porque repetirla cada vez es ruido que la gente deja de leer.
 *
 *  - Lo último lo escribió UNA PERSONA: se revela siempre, sin mirar el reloj.
 *    Es el caso que la política de experiencias automatizadas de Meta persigue
 *    de verdad: el comprador acaba de hablar con alguien del equipo y cree que
 *    sigue hablando con esa persona. Que el bot retome el hilo sin decir nada
 *    —dos minutos después, mismo hilo, mismo tono— es exactamente la confusión
 *    que hay que evitar, y ninguna ventana de tiempo la detecta, porque el
 *    problema no es que haya pasado tiempo sino que cambió quién contesta.
 *
 * Sin nada anterior (conversación nueva) se revela, que es el caso base de
 * `needsDisclosure`.
 */
export function needsDisclosureAfter(
  lastOutbound: { role: string; createdAt: Date } | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!lastOutbound) return true;
  if (lastOutbound.role === HUMAN_MESSAGE_ROLE) return true;
  return needsDisclosure(lastOutbound.createdAt, now);
}

/** Lo que el panel necesita saber de la ventana antes de dejar escribir. */
export interface ReplyWindow {
  /** Si Meta todavía admite un mensaje libre hacia esta persona. */
  open: boolean;
  /** Cuándo deja de admitirlo, para poder decir «te quedan 3 horas». `null`
   * cuando no se sabe cuándo escribió el comprador. */
  closesAt: Date | null;
}

/**
 * La ventana de 24 horas de Instagram, aplicada a UNA RESPUESTA HUMANA.
 *
 * Se aplica igual que al agente y por el mismo motivo, que conviene decir en
 * voz alta porque la intuición dice lo contrario: existe una etiqueta
 * `HUMAN_AGENT` que amplía el plazo a 7 días justamente para que conteste una
 * persona, y esta plataforma NO tiene ese permiso aprobado. Usarla sin
 * permiso —o peor, usarla y que Meta encuentre un bot detrás— es lo que se
 * castiga retirándole el permiso de mensajería a la app entera, o sea dejando
 * sin canal a TODAS las tiendas. Ver `packages/instagram/src/window.ts`.
 *
 * Así que fuera de plazo no se envía. Y se comprueba ANTES de que el
 * comerciante escriba, no al enviar: escribir una respuesta de tres párrafos
 * para que un botón conteste «no se pudo» es peor producto que un cuadro de
 * texto que ya venía deshabilitado explicando por qué.
 *
 * Sin `lastInboundAt` (conversación anterior a esa columna) esto devuelve
 * `{ open: true, closesAt: null }`: quien llama sustituye entonces la fecha por
 * la del último mensaje `user` del transcripto. Es nuestra hora de RECEPCIÓN y
 * no la de envío del comprador, así que puede sobrestimar el plazo restante en
 * lo que tardara la entrega — segundos en la práctica, y el camino de entrada
 * ya descarta lo que llega fuera de la ventana, así que el error está acotado.
 * Se prefiere a negarse: dejar mudo al comerciante en una conversación viva por
 * una columna que aún no existía es el peor de los dos fallos.
 */
export function instagramReplyWindow(
  lastInboundAt: Date | null | undefined,
  now: Date = new Date(),
): ReplyWindow {
  if (!lastInboundAt) return { open: true, closesAt: null };
  const sentAtMs = lastInboundAt.getTime();
  return {
    open: isWithinMessagingWindow(sentAtMs, now.getTime()),
    closesAt: new Date(sentAtMs + MESSAGING_WINDOW_MS),
  };
}
