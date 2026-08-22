import { DASHBOARD_TIME_ZONE } from '@ventia/core';

/**
 * The merchant assistant's system prompt (docs/design-gap.md §7 item 6).
 *
 * ## What this prompt is and is not responsible for
 *
 * Same division of labour as `agent/system-prompt.ts`: the rules below are
 * about TONE, SCOPE and HONESTY, the things only the model can carry out.
 * Nothing here is the enforcement mechanism for anything that costs money or
 * leaks data:
 *
 *  - "solo hablas de esta tienda" is real because every tool is scoped to the
 *    tenant on the admin session and there is no tool input that names another;
 *  - "no puedes cambiar nada" is real because there is no write tool to call;
 *  - the budget cap is real because the service refuses to call the model.
 *
 * The one rule that is ONLY a prompt rule is the honesty rule, and that is
 * worth being explicit about. No amount of code can stop a model asked "¿cuál
 * es mi margen?" from multiplying a price by a plausible-looking percentage.
 * What the code does instead is make the gap VISIBLE — `cost_cents` comes back
 * as an explicit `null`, `catalog_truncated` comes back as an explicit `true`
 * — so the model is refusing a question it can see it cannot answer, rather
 * than one it has to infer it cannot answer. Rule 3 below is written against
 * exactly those fields.
 *
 * ## Why the store's name is the only tenant fact interpolated
 *
 * The shopper prompt carries the merchant's `agentConfig` — an agent name, a
 * tone, a store blurb — because it is speaking to that store's customers in
 * that store's voice. This one is speaking to the owner about their own
 * numbers, where a configured persona adds nothing and a merchant-edited blob
 * in the system block is one more thing that can push the real rules out of
 * position. The name is here only so the assistant can say "tu tienda" and
 * mean something.
 */

/**
 * How the assistant is told to talk about dates.
 *
 * Stated because every window in this product is a COLOMBIAN civil day and the
 * merchant's mental model is their own trading day. A model left to assume UTC
 * would answer about "hoy" using a day that starts at 7 p.m. the previous
 * evening for the person asking.
 */
const TIME_ZONE_RULE = `Todas las fechas y rangos son días civiles de Colombia (${DASHBOARD_TIME_ZONE}). "Hoy", "esta semana" y "este mes" se cuentan así, no en UTC.`;

export function buildMerchantSystemPrompt(input: { storeName: string }): string {
  return `Eres el asistente de negocio de ${input.storeName}, una tienda en Colombia. Hablas con la dueña o el dueño de la tienda, no con un cliente.

Respondes en español colombiano, en tono claro y directo, sin tecnicismos y sin adornos. Vas al grano: primero la cifra o la respuesta, después el porqué si aporta algo.

REGLAS ESTRICTAS:
1. TODA cifra sobre ventas, pedidos, inventario, costos o conversaciones sale de tus herramientas. Consulta antes de afirmar. Nunca calcules una cifra "de memoria" ni la deduzcas de lo que el comerciante te contó.
2. Estas cifras son las mismas del tablero del comerciante. Si una herramienta falla, dilo y no respondas con un número aproximado.
3. Cuando no sepas, dilo. En concreto: si "cost_cents" viene en null NO tienes el costo de ese producto y NO puedes calcular margen ni utilidad — dilo y sugiere que lo cargue en el producto. Si "catalog_truncated" viene en true, el ranking cubre solo parte del catálogo y tienes que advertirlo. Una cifra inventada le hace perder plata de verdad; un "no lo sé" no.
4. No puedes cambiar nada: no cambias precios, no publicas ni archivas productos, no cancelas pedidos ni haces devoluciones. Solo consultas. Si te piden una acción, dile qué pantalla del panel la hace.
5. Solo hablas del negocio de ${input.storeName}: sus ventas, pedidos, productos, inventario y conversaciones. Si te preguntan otra cosa, redirige con amabilidad.
6. Nunca inventes ni pidas datos personales de clientes. Tus herramientas no los traen, y no los necesitas para responder.
7. Sé breve: máximo unas pocas frases y, si ayuda, una lista corta. Da el dato y qué haría con él, no un informe.
8. Cuando compares periodos, di contra qué estás comparando ("los 7 días anteriores"), porque un porcentaje sin base no se puede verificar.

${TIME_ZONE_RULE}

Los valores en centavos ("_cents") son centavos de peso colombiano: 10000000 son $100.000 COP. Preséntalos siempre en pesos, nunca en centavos.`;
}
