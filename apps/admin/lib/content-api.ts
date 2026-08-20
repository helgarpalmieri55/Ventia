import { apiFetch } from './api';

/** The five `TenantContent.type` values (see packages/db/prisma/schema.prisma's
 * `TenantContentType`), duplicated here as a plain union rather than imported
 * — apps/admin has no dependency on services/api, same as lib/checklist.ts. */
export const CONTENT_TYPES = ['about', 'policy_shipping', 'policy_returns', 'policy_privacy', 'faq'] as const;
export type ContentType = (typeof CONTENT_TYPES)[number];

/** es-CO labels, in the order a merchant most likely fills them in. */
export const CONTENT_LABELS: Record<ContentType, string> = {
  about: 'Contacto',
  policy_shipping: 'Envíos',
  policy_returns: 'Cambios y devoluciones',
  policy_privacy: 'Datos personales (Ley 1581)',
  faq: 'Preguntas frecuentes',
};

/** Where each page is published on the storefront — shown next to the editor
 * so the merchant knows what they are editing. `faq` is `null` on purpose:
 * it has no storefront route, it is only read by the AI assistant's
 * `get_store_info` tool (services/api/src/agent/agent-tools.service.ts). */
export const CONTENT_PATHS: Record<ContentType, string | null> = {
  about: '/contacto',
  policy_shipping: '/envios',
  policy_returns: '/cambios-y-devoluciones',
  policy_privacy: '/privacidad',
  faq: null,
};

export interface ContentItem {
  type: ContentType;
  title: string | null;
  bodyMd: string | null;
}

/** `GET /v1/admin/content` — always returns all five rows, with nulls for the
 * ones this store has not written yet. */
export function fetchContent(): Promise<{ items: ContentItem[] }> {
  return apiFetch<{ items: ContentItem[] }>('/v1/admin/content');
}

/** `PUT /v1/admin/content/:type` — upsert. Owner-only server-side. */
export function saveContent(type: ContentType, title: string, bodyMd: string) {
  return apiFetch<{ type: ContentType; title: string; bodyMd: string }>(`/v1/admin/content/${type}`, {
    method: 'PUT',
    body: JSON.stringify({ title, bodyMd }),
  });
}

export interface GeneratedPolicy {
  title: string;
  bodyMd: string;
  /** The `[COMPLETAR: ...]` hints still to be filled in, as a checklist. */
  placeholders: string[];
  /** Merchant-facing: this is a template, not legal advice, and the
   * Responsable del Tratamiento is the merchant. Never published. */
  disclaimer: string;
  /** Whether a policy is already saved — the UI must ask before replacing it. */
  hasExistingContent: boolean;
}

/** `POST /v1/admin/content/policy_privacy/generate` — fills the Ley 1581
 * template with this store's data and returns it for review. Writes nothing:
 * publishing is a separate, explicit {@link saveContent} call. */
export function generatePrivacyPolicy(): Promise<GeneratedPolicy> {
  return apiFetch<GeneratedPolicy>('/v1/admin/content/policy_privacy/generate', { method: 'POST' });
}
