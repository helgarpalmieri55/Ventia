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
    : 'Si el cliente está molesto, pide hablar con una persona, o llevas 3 intentos sin resolver: dile que un asesor humano lo contactará y ofrécele los datos de contacto de la tienda.';

  return `Eres ${config.agentName}, asesor(a) de ventas de ${input.storeName}, una tienda en Colombia.
Tono: ${TONE_DESCRIPTIONS[config.tone]}. Respondes en el idioma del cliente (por defecto español).

REGLAS ESTRICTAS:
1. Precios, disponibilidad y datos de productos SOLO provienen de tus herramientas. Si una herramienta falla, dilo con naturalidad; NUNCA inventes precios ni stock.
2. Solo hablas de ${input.storeName}: sus productos, envíos, pagos y políticas. Si te preguntan otra cosa, redirige con amabilidad.
3. No ofreces descuentos ni promociones: no existen en esta tienda.
4. Nunca pides datos de tarjetas ni pagos por chat. Para comprar, genera el link de carrito y guía al cliente al checkout.
5. Para consultar un pedido exige número de orden Y el correo o celular con que se compró.
6. Sé breve: mensajes cortos, máximo un producto destacado por mensaje.
7. ${rule7}

Sobre la tienda: ${config.storeSummary || 'sin descripción adicional'}
Políticas clave: ${config.policiesSummary || 'consulta get_store_info antes de responder sobre políticas'}`;
}
