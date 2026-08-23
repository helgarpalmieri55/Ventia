import type { Prisma } from '@ventia/db';

/**
 * Builds the agent's system prompt from SPEC.md §7's template, filled per
 * tenant.
 *
 * ## What the prompt is and is not responsible for
 *
 * The rules below are about TONE, SCOPE and HONESTY — things only the model can
 * carry out. They are deliberately not the enforcement mechanism for anything
 * that costs money or leaks data:
 *
 *  - "prices only from tools" is real because the tools are the only source of
 *    prices in the response at all (agent-tools.service.ts);
 *  - "never echo a full address" is real because `get_order_status` does not
 *    return one;
 *  - the budget cap is real because the service refuses to call the model.
 *
 * Stating them here too is still worth it — a model that understands why a
 * constraint exists behaves better inside it — but every one of them holds if
 * the model ignores the prompt entirely. That is the test for whether a rule
 * belongs in code: if violating it would be expensive or unrecoverable, the
 * prompt is not where it lives.
 *
 * ## La revelación de que el agente es automático es justo un caso de esos
 *
 * La política de experiencias automatizadas de Meta (Messenger Platform e
 * Instagram Messaging, y el requisito equivalente de vía de escalado de la
 * política de WhatsApp Business) exige revelar que quien contesta es un
 * sistema automático «al principio de cualquier conversación o hilo, tras un
 * lapso significativo de tiempo, o cuando el chat pasa de atención humana a
 * automática».
 *
 * Por el criterio de arriba, eso NO puede vivir en el prompt. No porque cueste
 * dinero, sino porque es irrecuperable de la peor forma: si el modelo se salta
 * la instrucción una vez, el revisor de Meta que abrió esa conversación ya vio
 * un supuesto «asesor» presentándose como persona, y el rechazo no cae sobre
 * una tienda sino sobre la app de la plataforma —es decir, sobre TODAS las
 * tiendas—. Es la misma lógica de radio de daño compartido que
 * `packages/instagram/src/window.ts` usa para no tocar la etiqueta
 * `HUMAN_AGENT`.
 *
 * Y hay una diferencia práctica ante una revisión: «el modelo tiene
 * instrucciones de decirlo» no se puede demostrar, «el sistema lo antepone
 * siempre» sí. Así que {@link buildAutomationDisclosure} produce un texto FIJO
 * que `AgentService` antepone él mismo a la primera respuesta de cada sesión,
 * y el prompt solo se encarga de lo que el código no puede: que el modelo no
 * se contradiga después ni repita el aviso en cada mensaje.
 *
 * ## Por qué el comerciante no puede desactivarla
 *
 * `agentConfig` es un blob que edita el comerciante, y de él salen el nombre y
 * el tono — es decir, CÓMO suena la revelación. Nunca SI aparece: no se lee
 * ninguna clave que pueda apagarla, y ponerla sería regalarle a cualquier
 * tienda un interruptor que le quita el canal de mensajería a todas las demás.
 * Un comerciante que ponga `agentName: 'María'` sigue recibiendo «soy María,
 * el asistente virtual de …»: el nombre humano no borra la revelación, que es
 * exactamente el caso que la política persigue.
 */

export interface TenantAgentConfig {
  agentName: string;
  tone: 'cercano' | 'profesional' | 'juvenil';
  storeSummary: string;
  policiesSummary: string;
}

const TONE_DESCRIPTIONS: Record<TenantAgentConfig['tone'], string> = {
  cercano: 'cercano y cálido, tuteando al cliente',
  profesional: 'profesional y claro, sin excesos de confianza',
  juvenil: 'juvenil y relajado, pero siempre respetuoso',
};

const DEFAULTS: TenantAgentConfig = {
  agentName: 'Asesor',
  tone: 'cercano',
  storeSummary: '',
  policiesSummary: '',
};

/** Reads the tenant's `agentConfig` JSON defensively — it is an operator-edited
 * blob, so a missing or wrong-typed field falls back rather than throwing a
 * shopper's message away. */
export function parseAgentConfig(raw: Prisma.JsonValue | null | undefined): TenantAgentConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return DEFAULTS;
  const config = raw as Record<string, unknown>;

  const tone = config.tone;
  return {
    agentName: typeof config.agentName === 'string' && config.agentName.trim() ? config.agentName.trim() : DEFAULTS.agentName,
    tone: tone === 'profesional' || tone === 'juvenil' || tone === 'cercano' ? tone : DEFAULTS.tone,
    storeSummary: typeof config.storeSummary === 'string' ? config.storeSummary : DEFAULTS.storeSummary,
    policiesSummary: typeof config.policiesSummary === 'string' ? config.policiesSummary : DEFAULTS.policiesSummary,
  };
}

/**
 * Cuánto silencio convierte el siguiente mensaje en una sesión nueva y obliga
 * a repetir la revelación.
 *
 * Meta pide revelarlo «al principio de cualquier conversación o hilo» y
 * también «tras un lapso significativo de tiempo», sin decir cuánto. 24 horas
 * no es un número inventado: es exactamente la ventana de mensajería de
 * Instagram y de WhatsApp (`packages/instagram/src/window.ts`). Pasado ese
 * plazo la propia plataforma considera cerrada la sesión y ya no nos deja
 * escribir libremente, así que el primer mensaje que la reabre ES el principio
 * de un hilo nuevo — para Meta y para quien escribe, que hace un día que no
 * habla con la tienda.
 *
 * El efecto en una conversación normal es ninguno: un ida y vuelta de compra
 * dura minutos y la revelación sale UNA vez. Lo que evita es el otro extremo,
 * el de convertir cada mensaje en un descargo legal, que arruinaría la venta
 * sin añadir cumplimiento.
 */
export const DISCLOSURE_SESSION_GAP_MS = 24 * 60 * 60 * 1000;

/**
 * Si a esta conversación le toca revelación en este turno.
 *
 * @param lastAssistantAt cuándo contestó el agente por última vez en esta
 *   conversación, o `null` si nunca lo hizo. `null` — conversación nueva, o
 *   una que solo tiene mensajes del comprador — siempre revela.
 */
export function needsDisclosure(lastAssistantAt: Date | null | undefined, now: Date = new Date()): boolean {
  if (!lastAssistantAt) return true;
  return now.getTime() - lastAssistantAt.getTime() >= DISCLOSURE_SESSION_GAP_MS;
}

/** Cómo se presenta el asistente en cada tono. La frase que revela —«el
 * asistente virtual de …», «te respondo de forma automática»— es la misma en
 * los tres: lo que cambia es el registro, nunca el hecho revelado. */
const DISCLOSURE_INTRO: Record<TenantAgentConfig['tone'], (agentName: string, storeName: string) => string> = {
  cercano: (agentName, storeName) =>
    `Hola, soy ${agentName}, el asistente virtual de ${storeName}. Te respondo de forma automática.`,
  profesional: (agentName, storeName) =>
    `Hola, soy ${agentName}, el asistente virtual de ${storeName}. Le respondo de forma automatizada.`,
  juvenil: (agentName, storeName) =>
    `¡Hola! Soy ${agentName}, el asistente virtual de ${storeName} 🤖 Te respondo automáticamente.`,
};

/**
 * La salida hacia una persona, que va pegada a la revelación en la misma
 * frase.
 *
 * No es adorno: la política de WhatsApp Business exige una vía de escalado
 * humana clara y directa DENTRO del hilo para quien automatiza respuestas, y
 * anunciarla en el mismo mensaje que revela la automatización es la forma más
 * barata de que exista de verdad y no solo en un menú que nadie abre.
 *
 * Cambia con el plan porque tiene que ser verdad: una tienda sin
 * `humanHandoff` no tiene `escalate_to_human`, y prometer un traspaso que no
 * va a ocurrir es peor que ofrecer el contacto de la tienda, que sí puede
 * cumplir.
 */
const DISCLOSURE_HANDOFF: Record<TenantAgentConfig['tone'], string> = {
  cercano: 'Si en algún momento prefieres hablar con una persona del equipo, dímelo y te paso con alguien.',
  profesional: 'Si en algún momento prefiere hablar con una persona del equipo, indíquemelo y le paso con alguien.',
  juvenil: 'Si quieres hablar con una persona del equipo, solo dímelo.',
};

const DISCLOSURE_CONTACT: Record<TenantAgentConfig['tone'], string> = {
  cercano:
    'Si en algún momento prefieres hablar con una persona del equipo, dímelo y te paso los datos de contacto de la tienda.',
  profesional:
    'Si en algún momento prefiere hablar con una persona del equipo, indíquemelo y le comparto los datos de contacto de la tienda.',
  juvenil: 'Si quieres hablar con una persona del equipo, dime y te paso los datos de contacto de la tienda.',
};

/**
 * El texto exacto con el que el sistema se presenta como automático.
 *
 * Determinista y sin llamada al modelo: es lo que permite que una prueba
 * —y un revisor de Meta— compruebe que está, en vez de confiar en que el
 * modelo se acordó. `AgentService` lo antepone a la primera respuesta de la
 * sesión, sea esa respuesta del modelo o una de las fijas.
 *
 * Cae en los mismos valores por defecto que el prompt (`parseAgentConfig`), de
 * modo que un `agentConfig` vacío, corrupto o con un tono desconocido produce
 * igualmente una revelación válida. No hay forma de que devuelva cadena vacía.
 */
export function buildAutomationDisclosure(input: {
  storeName: string;
  agentConfig: Prisma.JsonValue | null | undefined;
  handoffEnabled?: boolean;
  /**
   * Si se añade la frase de salida hacia una persona. Por defecto sí.
   *
   * `false` existe para un solo caso: la respuesta de tope de presupuesto,
   * donde el agente ya no va a contestar nada más y esa frase sería una
   * promesa vacía («dímelo y te paso con alguien» seguido de «no puedo
   * responderte por chat»). Ahí la vía humana la da el propio texto fijo, que
   * manda a escribirle a la tienda. NO es una forma de quitar la revelación:
   * lo que se recorta es el ofrecimiento, nunca el hecho revelado.
   */
  includeEscalation?: boolean;
}): string {
  const config = parseAgentConfig(input.agentConfig);
  const intro = DISCLOSURE_INTRO[config.tone](config.agentName, input.storeName);
  if (input.includeEscalation === false) return intro;
  const salida = input.handoffEnabled ? DISCLOSURE_HANDOFF[config.tone] : DISCLOSURE_CONTACT[config.tone];
  return `${intro} ${salida}`;
}

export function buildSystemPrompt(input: {
  storeName: string;
  agentConfig: Prisma.JsonValue | null | undefined;
  /** Whether this tenant's plan includes human handoff. Decides which version
   * of rule 7 the model gets — and it must match whether `escalate_to_human`
   * is actually in the tool array, or the prompt is describing a tool that
   * isn't there. */
  handoffEnabled?: boolean;
}): string {
  const config = parseAgentConfig(input.agentConfig);
  // SPEC.md §7 rule 7. A store without handoff gets the fallback it can
  // actually deliver — its own contact details — rather than an instruction to
  // use a tool it was never given.
  const rule7 = input.handoffEnabled
    ? 'Si el cliente está molesto, pide hablar con una persona, o llevas 3 intentos sin resolver: usa escalate_to_human y dile que un asesor lo contactará.'
    : 'Si el cliente está molesto, pide hablar con una persona, o llevas 3 intentos sin resolver: dile que lo atenderá una persona del equipo y dale los datos de contacto reales de la tienda consultando get_store_info. Nunca lo dejes sin una forma de llegar a una persona.';

  return `Eres ${config.agentName}, el asistente virtual (automatizado) de ventas de ${input.storeName}, una tienda en Colombia. No eres una persona.
Tono: ${TONE_DESCRIPTIONS[config.tone]}. Respondes en el idioma del cliente (por defecto español).

REGLAS ESTRICTAS:
1. Precios, disponibilidad y datos de productos SOLO provienen de tus herramientas. Si una herramienta falla, dilo con naturalidad; NUNCA inventes precios ni stock.
2. Solo hablas de ${input.storeName}: sus productos, envíos, pagos y políticas. Si te preguntan otra cosa, redirige con amabilidad.
3. No ofreces descuentos ni promociones: no existen en esta tienda.
4. Nunca pides datos de tarjetas ni pagos por chat. Para comprar, genera el link de carrito y guía al cliente al checkout.
5. Para consultar un pedido exige número de orden Y el correo o celular con que se compró.
6. Sé breve: mensajes cortos, máximo un producto destacado por mensaje.
7. ${rule7}
8. Nunca dices ni das a entender que eres una persona. Si te preguntan si eres un bot, un robot, una IA o alguien de carne y hueso, lo confirmas sin rodeos: eres el asistente automático de ${input.storeName}. Tampoco finges tareas humanas ("voy a la bodega a mirar", "te llamo").
9. El sistema YA se presenta como asistente virtual al empezar la conversación y al retomarla tras un día sin hablar. No repitas ese aviso en cada mensaje: una vez revelado, vendes con naturalidad.

Sobre la tienda: ${config.storeSummary || 'sin descripción adicional'}
Políticas clave: ${config.policiesSummary || 'consulta get_store_info antes de responder sobre políticas'}`;
}
