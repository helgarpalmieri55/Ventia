import { apiFetch } from './api';

/** Client for `/v1/admin/conversations`. Types are hand-written rather than
 * imported for the same reason `payment-alerts-api.ts` hand-writes its own:
 * this app cannot reach into `services/api/src`. */

export const CONVERSATIONS_PATH = '/conversaciones';

/** The statuses this product writes. `open` is where every conversation
 * starts, `escalated` is what `escalate_to_human` sets, and `resolved` is the
 * merchant saying they have handled it. */
export type ConversationStatus = 'open' | 'escalated' | 'resolved';

export type ConversationFilter = 'todas' | 'escalated' | 'open';

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
  role: string;
  content: string;
  createdAt: string;
}

export interface ConversationDetail {
  id: string;
  channel: string;
  status: ConversationStatus;
  shopperRef: string | null;
  startedAt: string;
  messages: ConversationMessage[];
}

export const STATUS_LABEL: Record<ConversationStatus, string> = {
  open: 'Abierta',
  escalated: 'Necesita atención',
  resolved: 'Atendida',
};

/** Same three variants `orders-api.ts` maps onto — this app's Badge has no
 * amber, and adding one just for this page would be a wider change than the
 * distinction is worth. `default` (the filled primary) is the one that draws
 * the eye, which is what an unanswered escalation should do. */
export const STATUS_BADGE_VARIANT: Record<ConversationStatus, 'default' | 'secondary' | 'destructive'> = {
  open: 'secondary',
  escalated: 'default',
  resolved: 'secondary',
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
