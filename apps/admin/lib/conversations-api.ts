import { apiFetch } from './api';

/** Client for `/v1/admin/conversations`. Types are hand-written rather than
 * imported for the same reason `payment-alerts-api.ts` hand-writes its own:
 * this app cannot reach into `services/api/src`. */

export const CONVERSATIONS_PATH = '/conversaciones';

/** The statuses this product writes. `open` is where every conversation
 * starts, `escalated` is what `escalate_to_human` sets, `human` es el
 * comerciante atendiéndola desde aquí (mientras dure, el asistente calla), y
 * `resolved` es el comerciante dando el caso por cerrado. */
export type ConversationStatus = 'open' | 'escalated' | 'human' | 'resolved';

export type ConversationFilter = 'todas' | 'escalated' | 'human' | 'open';

/** Los canales por los que puede llegar una conversación. */
export type ConversationChannel = 'web' | 'whatsapp' | 'instagram';

export interface ConversationSummary {
  id: string;
  channel: string;
  status: ConversationStatus;
  /** How to reach the shopper, when the channel carries it. `null` for a
   * web-widget visitor who never identified themselves — for those, the
   * transcript is the merchant's only context. */
  shopperRef: string | null;
  startedAt: string;
  messageCount: number;
  lastMessage: string | null;
  /** Cuándo se dijo lo último. Es lo que permite detectar que llegó algo nuevo
   * entre dos sondeos: comparar el TEXTO fallaría con dos mensajes iguales
   * seguidos, y comparar el número de mensajes fallaría cuando el retentor
   * borra los viejos. */
  lastMessageAt: string | null;
  /** Quién dijo lo último: `user`, `assistant` o `human`. Distingue «el cliente
   * escribió y nadie ha contestado» de «ya le contestamos». */
  lastMessageRole: string | null;
}

export interface ConversationListResponse {
  items: ConversationSummary[];
  total: number;
  page: number;
  pageSize: number;
  /** Always the UNFILTERED escalated count, so the "sin atender" figure stays
   * truthful while the merchant is looking at a filtered list. */
  escalatedCount: number;
}

export interface ConversationMessage {
  id: string;
  /** `user` el comprador, `assistant` el agente, `human` una persona del
   * equipo escribiendo desde este panel. */
  role: string;
  content: string;
  createdAt: string;
}

/** Por qué una conversación no admite respuesta humana. Espejo de
 * `ReplyBlockedReason` en services/api/src/agent/human-reply.service.ts. */
export type ReplyBlockedReason =
  | 'MESSAGING_WINDOW_CLOSED'
  | 'CHANNEL_NOT_CONNECTED'
  | 'CHANNEL_NOT_IN_PLAN'
  | 'SHOPPER_UNREACHABLE';

export interface ConversationDetail {
  id: string;
  channel: string;
  status: ConversationStatus;
  shopperRef: string | null;
  startedAt: string;
  messages: ConversationMessage[];
  /** Si el comerciante puede escribir AHORA. Viene decidido por el servidor y
   * se pinta antes de que escriba, no después de pulsar Enviar. */
  canReply: boolean;
  replyBlockedReason: ReplyBlockedReason | null;
  /** Cuándo se cierra la ventana de 24 horas de Instagram, para poder avisar
   * antes de que se cierre. `null` donde no hay ventana. */
  replyWindowClosesAt: string | null;
  /** El tope de caracteres del canal de ESTA conversación (1000 en Instagram,
   * 4096 en WhatsApp). Viene del servidor para que el contador diga el número
   * de verdad y no uno copiado a mano. */
  replyMaxChars: number;
}

export const STATUS_LABEL: Record<ConversationStatus, string> = {
  open: 'Abierta',
  escalated: 'Necesita atención',
  human: 'La atiendes tú',
  resolved: 'Atendida',
};

/** Same three variants `orders-api.ts` maps onto — this app's Badge has no
 * amber, and adding one just for this page would be a wider change than the
 * distinction is worth. `default` (the filled primary) is the one that draws
 * the eye, which is what an unanswered escalation should do.
 *
 * `human` va en `secondary` y no en `default`: una conversación que ya estás
 * atendiendo no es algo que reclame tu atención — es algo que ya la tiene. */
export const STATUS_BADGE_VARIANT: Record<ConversationStatus, 'default' | 'secondary' | 'destructive'> = {
  open: 'secondary',
  escalated: 'default',
  human: 'secondary',
  resolved: 'secondary',
};

/** Cómo se llama cada canal delante del comerciante. Un `Record` parcial
 * porque el servidor manda el canal como texto libre. */
export const CHANNEL_LABEL: Record<string, string> = {
  web: 'Chat de la tienda',
  whatsapp: 'WhatsApp',
  instagram: 'Instagram',
};

export async function listConversations(
  filter: ConversationFilter,
  page: number,
): Promise<ConversationListResponse> {
  const params = new URLSearchParams({ page: String(page) });
  if (filter !== 'todas') params.set('status', filter);
  return apiFetch<ConversationListResponse>(`/v1/admin/conversations?${params.toString()}`);
}

export async function getConversation(id: string): Promise<ConversationDetail> {
  return apiFetch<ConversationDetail>(`/v1/admin/conversations/${id}`);
}

export async function resolveConversation(id: string): Promise<{ id: string; status: ConversationStatus }> {
  return apiFetch(`/v1/admin/conversations/${id}/resolve`, { method: 'PATCH' });
}

/**
 * El comerciante contesta como persona.
 *
 * El servidor manda el texto TAL CUAL por el canal de la conversación y lo
 * guarda con rol `human` — sin la revelación de experiencia automatizada, que
 * es de la máquina y no de quien escribe aquí.
 */
export async function replyToConversation(
  id: string,
  text: string,
): Promise<{ id: string; status: ConversationStatus; message: ConversationMessage }> {
  return apiFetch(`/v1/admin/conversations/${id}/reply`, {
    method: 'POST',
    body: JSON.stringify({ text }),
  });
}

/** Le devuelve la conversación al asistente. Sin esto, contestar una vez
 * dejaría esa conversación muda para siempre. */
export async function handBackConversation(id: string): Promise<{ id: string; status: ConversationStatus }> {
  return apiFetch(`/v1/admin/conversations/${id}/handback`, { method: 'PATCH' });
}
