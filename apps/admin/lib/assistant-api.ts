import { apiFetch } from './api';

/** Client for `POST /v1/admin/ai/command` — the merchant's business assistant.
 *
 * Types are hand-written rather than imported for the same reason
 * `conversations-api.ts` hand-writes its own: this app cannot reach into
 * `services/api/src`. They mirror `AgentCommandResponse` in `@ventia/core`. */

export const ASSISTANT_PATH = '/asistente';

/** What the answer cost against the plan.
 *
 * `remainingTotal` is the number that matters most and the one a merchant
 * would never think to ask for: the merchant assistant and the storefront's
 * sales agent spend ONE monthly allowance, so every question asked here is a
 * customer the shopper agent may not get to answer. */
export interface AssistantBudget {
  used: number;
  limit: number;
  /** Messages the assistant will not spend, held for shoppers. */
  shopperReserve: number;
  /** Questions left before THIS assistant stops. */
  remainingForCommands: number;
  /** Messages left before the storefront's agent goes quiet too. */
  remainingTotal: number;
  warning: boolean;
}

export interface AssistantAnswer {
  answer: string;
  /** Which lookups the answer was grounded in. An answer with a confident
   * figure and an empty list here is one to distrust. */
  usedTools: Array<{ name: string; ok: boolean }>;
  budget: AssistantBudget;
}

/** Human labels for the tool names the API reports, so the merchant sees "miré
 * tu tablero" rather than a snake_case identifier. */
export const TOOL_LABELS: Record<string, string> = {
  get_business_summary: 'Tablero de ventas',
  get_product_performance: 'Productos e inventario',
  get_orders_snapshot: 'Pedidos',
};

export async function askAssistant(question: string): Promise<AssistantAnswer> {
  return apiFetch<AssistantAnswer>('/v1/admin/ai/command', {
    method: 'POST',
    body: JSON.stringify({ question }),
  });
}
