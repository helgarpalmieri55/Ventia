import type {
  ConversationDetail,
  ConversationMessage,
  ConversationSummary,
  ReplyBlockedReason,
} from './conversations-api';

/**
 * Las reglas de la bandeja EN VIVO, como funciones puras.
 *
 * Están fuera del componente a propósito: decidir si llegó un mensaje nuevo, si
 * hay que seguir el scroll y qué se le dice al comerciante cuando no puede
 * responder son decisiones que se pueden equivocar en silencio y que no
 * necesitan un navegador para probarse. Lo que queda en `page.tsx` y en
 * `conversacion-panel.tsx` es el `setInterval` y el `useState`.
 *
 * ## Por qué SONDEO y no SSE ni WebSocket
 *
 * La API ya tiene un transporte SSE (`/v1/storefront/agent/stream`) y aun así
 * esto sondea. Tres razones, en orden de peso:
 *
 *  1. **Lo que hay que ver no lo produce esta petición.** El mensaje que llega
 *     por Instagram entra por un webhook de Meta, en otro proceso y sin ninguna
 *     relación con la sesión del panel. Un stream serviría para eso solo con un
 *     bus entre procesos —Redis pub/sub más una ruta SSE por inquilino— que es
 *     infraestructura nueva para un panel que mira una tienda a la vez.
 *  2. **Un panel de administración no es un chat en vivo.** Que un mensaje
 *     tarde hasta cinco segundos en aparecer no cambia nada para el
 *     comerciante; que se pierda para siempre porque una conexión se cayó, sí.
 *     Un sondeo es idempotente y se recupera solo: la petición siguiente trae
 *     el estado completo, sin reconexión, sin latidos y sin `Last-Event-ID`.
 *  3. **El coste es conocido y pequeño.** Una consulta acotada por inquilino
 *     cada cinco segundos, y solo mientras la pestaña está visible (ver
 *     {@link INTERVALO_LISTA_MS}).
 *
 * Si algún día el panel tiene que servir a un equipo de diez agentes con la
 * bandeja abierta todo el día, esto se cambia por un canal servidor→cliente. No
 * es hoy, y construirlo hoy sería infraestructura sin usuario.
 */

/**
 * Cada cuánto se vuelve a pedir la lista.
 *
 * Cinco segundos: por debajo, el comerciante no nota diferencia y la base de
 * datos sí; por encima, un mensaje que llega mientras se graba un vídeo tarda
 * lo bastante como para que parezca que no llegó. Es también el orden de
 * magnitud de lo que tarda Meta en entregar un webhook, así que afinar más
 * sería afinar por debajo del ruido.
 */
export const INTERVALO_LISTA_MS = 5000;

/**
 * Cada cuánto se vuelve a pedir el transcripto abierto.
 *
 * Más rápido que la lista porque es donde el comerciante está mirando: ahí un
 * mensaje que tarda cinco segundos en aparecer se nota, y es la pantalla desde
 * la que está contestando.
 */
export const INTERVALO_DETALLE_MS = 3000;

/**
 * Las conversaciones cuyo último mensaje cambió entre dos sondeos.
 *
 * Se compara `lastMessageAt` y no el texto: dos mensajes iguales seguidos son
 * completamente normales («hola», «hola»), y compararlos por contenido perdería
 * el segundo. Tampoco vale el número de mensajes — el barrido de retención
 * borra los viejos, así que puede bajar sin que nadie haya dicho nada.
 *
 * Una conversación que aparece por primera vez cuenta como novedad: es
 * exactamente el caso de un cliente nuevo escribiendo, que es lo que más se
 * quiere ver. La ÚNICA excepción es la primera carga (`previas` vacío), donde
 * marcarlo todo como nuevo sería pintar la pantalla entera de resaltado.
 */
export function conversacionesConNovedad(
  previas: readonly ConversationSummary[],
  actuales: readonly ConversationSummary[],
): Set<string> {
  const nuevas = new Set<string>();
  if (previas.length === 0) return nuevas;

  const antes = new Map(previas.map((c) => [c.id, c.lastMessageAt]));
  for (const conversacion of actuales) {
    if (!antes.has(conversacion.id)) {
      nuevas.add(conversacion.id);
      continue;
    }
    if (conversacion.lastMessageAt !== antes.get(conversacion.id)) nuevas.add(conversacion.id);
  }
  return nuevas;
}

/** Los ids de mensajes que no estaban en el transcripto anterior.
 *
 * Igual que arriba, la primera carga no marca nada: un transcripto entero
 * resaltado no señala nada. */
export function mensajesNuevos(
  previos: readonly ConversationMessage[],
  actuales: readonly ConversationMessage[],
): Set<string> {
  if (previos.length === 0) return new Set();
  const antes = new Set(previos.map((m) => m.id));
  return new Set(actuales.filter((m) => !antes.has(m.id)).map((m) => m.id));
}

/**
 * Si el transcripto debe seguir bajando solo al llegar un mensaje.
 *
 * Solo cuando el comerciante YA estaba mirando el final. Si subió a releer algo
 * —que es lo que uno hace justo antes de contestar—, arrastrarle la vista al
 * fondo cada tres segundos convierte el panel en algo con lo que no se puede
 * trabajar. El margen absorbe el redondeo de subpíxeles del navegador y el
 * caso de «casi abajo», que para una persona ES abajo.
 */
export function estaAlFondo(
  caja: { scrollTop: number; scrollHeight: number; clientHeight: number },
  margenPx = 48,
): boolean {
  return caja.scrollHeight - caja.scrollTop - caja.clientHeight <= margenPx;
}

/**
 * Lo que se le dice al comerciante cuando no puede responder. En español y en
 * términos de qué pasó y qué puede hacer, nunca del código.
 *
 * Exportado —y no copiado— porque estos mismos cuatro motivos vuelven como
 * códigos de error 409 cuando la pantalla se quedó vieja y el envío se intenta
 * igual: `lib/errors.ts` los incorpora a su tabla en vez de escribirlos otra
 * vez, para que el aviso que se pinta ANTES de escribir y el que aparece
 * DESPUÉS de pulsar Enviar no puedan acabar diciendo cosas distintas.
 */
export const MOTIVO_BLOQUEO: Record<ReplyBlockedReason, string> = {
  // El caso importante, y el único que no es un fallo de configuración: Meta
  // solo permite escribirle libremente a alguien dentro de las 24 horas
  // siguientes a SU último mensaje.
  MESSAGING_WINDOW_CLOSED:
    'Pasaron más de 24 horas desde el último mensaje del cliente. Instagram no permite escribirle hasta que vuelva a escribirte.',
  CHANNEL_NOT_CONNECTED:
    'La cuenta de este canal ya no está conectada. Vuelve a conectarla en Ajustes para poder responder desde aquí.',
  CHANNEL_NOT_IN_PLAN: 'Tu plan ya no incluye este canal. Mejora tu plan para responder desde aquí.',
  SHOPPER_UNREACHABLE:
    'Este cliente no dejó datos de contacto, así que no hay por dónde escribirle. Su conversación queda como referencia.',
};

/** Qué debe pintar el cuadro de respuesta. */
export interface EstadoCompositor {
  /** Si se deja escribir. */
  habilitado: boolean;
  /** Por qué no, en español, cuando no. */
  aviso: string | null;
  /** El tope de caracteres del canal. */
  maxChars: number;
}

/**
 * El estado del cuadro de respuesta, decidido ANTES de que el comerciante
 * escriba.
 *
 * Es la diferencia entre una interfaz que se explica y una que se rompe:
 * escribir tres párrafos para que un botón conteste «no se pudo» es tiempo
 * perdido por un dato que ya teníamos antes de que empezara.
 */
export function estadoCompositor(detalle: ConversationDetail): EstadoCompositor {
  if (detalle.canReply) return { habilitado: true, aviso: null, maxChars: detalle.replyMaxChars };
  return {
    habilitado: false,
    aviso: detalle.replyBlockedReason
      ? MOTIVO_BLOQUEO[detalle.replyBlockedReason]
      : 'Ahora mismo no se puede responder por este canal.',
    maxChars: detalle.replyMaxChars,
  };
}

/**
 * El aviso de «te queda poco» de la ventana de 24 horas, o `null`.
 *
 * Solo aparece en las últimas horas. Un contador permanente en una conversación
 * que empezó hace diez minutos es ansiedad sin información: lo que hay que
 * avisar es el borde, no el reloj.
 */
export function avisoVentana(
  cierraEn: string | null,
  ahora: Date = new Date(),
  umbralHoras = 3,
): string | null {
  if (!cierraEn) return null;
  const cierre = new Date(cierraEn).getTime();
  if (!Number.isFinite(cierre)) return null;

  const restanteMs = cierre - ahora.getTime();
  if (restanteMs <= 0) return null;
  if (restanteMs > umbralHoras * 60 * 60 * 1000) return null;

  const minutos = Math.max(1, Math.round(restanteMs / 60_000));
  if (minutos < 60) return `Te queda ${minutos} min para responder por este canal.`;
  const horas = Math.floor(minutos / 60);
  return `Te ${horas === 1 ? 'queda' : 'quedan'} menos de ${horas + 1} h para responder por este canal.`;
}

/**
 * Cómo se pinta cada mensaje del transcripto.
 *
 * Tres burbujas y no dos. Que lo que escribió una persona del equipo se vea
 * distinto de lo que escribió el agente es el punto: el comerciante tiene que
 * poder leer de un vistazo dónde entró él, y quien revise la conversación
 * después tiene que poder saber quién dijo cada cosa.
 */
export type EstiloMensaje = 'cliente' | 'agente' | 'equipo';

export function estiloDeMensaje(role: string): EstiloMensaje {
  if (role === 'human') return 'equipo';
  if (role === 'assistant') return 'agente';
  return 'cliente';
}

/** El nombre que se pinta encima de cada burbuja. */
export const AUTOR_MENSAJE: Record<EstiloMensaje, string> = {
  cliente: 'Cliente',
  agente: 'Asistente',
  equipo: 'Tú',
};
