import { apiFetch, ApiError } from './api';
import { errorMessage } from './errors';

/**
 * Client for `/v1/platform/*` — **Ventia's own back office** (docs/SPEC.md §6
 * M9), not a merchant surface.
 *
 * Everything reachable through this module is data about OTHER companies. The
 * merchant client (`orders-api.ts`, `customers-api.ts`, …) talks to
 * `/v1/admin/*`, which is one merchant's view of themselves; this one talks to
 * `/v1/platform/*`, which is the operator's view across all of them. The two
 * are kept in separate modules on purpose so that nothing in the merchant app
 * ever imports a cross-tenant call by accident, and so a reader of any page
 * can tell which world it belongs to from its imports alone.
 *
 * Types are hand-written rather than imported from `services/api` — same
 * reason as every other client here: this app cannot reach into that
 * deployable's source. They mirror `PlatformService`'s return shapes
 * field-for-field, and were checked against real responses from a running
 * API (see the report accompanying this change).
 */

/** The route prefix of the operator console. Exported so `nav.ts`'s test can
 * assert that NO merchant nav item ever points inside it. */
export const PLATFORM_PATH = '/plataforma';

export function platformTenantPath(tenantId: string): string {
  return `${PLATFORM_PATH}/${tenantId}`;
}

// ---- vocabulary -----------------------------------------------------

/** Mirrors `PLAN_IDS` in `@ventia/core/platform-schemas` — ascending tiers. */
export const PLAN_IDS = ['basico', 'pro', 'premium'] as const;
export type PlanId = (typeof PLAN_IDS)[number];

export const TENANT_STATUSES = ['draft', 'live', 'suspended'] as const;
export type TenantStatus = (typeof TENANT_STATUSES)[number];

export const PLAN_LABELS: Record<PlanId, string> = {
  basico: 'Básico',
  pro: 'Pro',
  premium: 'Premium',
};

export const TENANT_STATUS_LABELS: Record<TenantStatus, string> = {
  draft: 'En configuración',
  live: 'Activa',
  suspended: 'Suspendida',
};

/**
 * Badge weight per status, ordered by how much an operator needs to notice it.
 *
 * The healthy majority is the QUIET one. `live` is `secondary` (muted) rather
 * than `default` (the console's amber) because a list of forty stores is
 * forty "Activa" pills, and painting the normal case in the accent colour
 * makes the two states worth stopping on compete with it. Amber is spent on
 * `draft` — a store that signed up and never launched, the one that wants a
 * phone call — and red on `suspended`, which means a business is offline
 * right now because Ventia put it there.
 */
export const TENANT_STATUS_BADGE: Record<TenantStatus, 'default' | 'secondary' | 'destructive'> = {
  draft: 'default',
  live: 'secondary',
  suspended: 'destructive',
};

// ---- wire shapes ----------------------------------------------------

export interface PlatformGmv {
  totalCents: number;
  orders: number;
}

export interface PlatformAiUsage {
  messages: number;
  /** Read off `TenantLimits`, NOT derived from the plan — `0` means the
   * tenant has no provisioned AI budget at all, which the API enforces as a
   * hard cap of zero. */
  messagesLimit: number;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
  /** `null` when `messagesLimit` is 0 — there is no percentage of zero, and
   * rendering "0 %" for a tenant capped at zero would read as healthy. */
  percentUsed: number | null;
}

export interface PlatformTenantRow {
  id: string;
  slug: string;
  name: string;
  status: TenantStatus;
  plan: PlanId;
  createdAt: string;
  gmv: PlatformGmv;
  ai: PlatformAiUsage;
}

export interface PlatformTenantList {
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
  /** `YYYY-MM` — the month the AI counters cover. */
  month: string;
  tenants: PlatformTenantRow[];
}

export interface PlatformTenantLimits {
  productsMax: number;
  aiMessagesMonth: number;
  staffSeats: number;
  customDomain: boolean;
  humanHandoff: boolean;
  whatsappChannel: boolean;
}

export interface PlatformTenantDomain {
  domain: string;
  isPrimary: boolean;
  verifiedAt: string | null;
}

/**
 * Manual v1 subscription tracking (SPEC §6 M9). The API returns the newest
 * `Subscription` row or `null`.
 *
 * **Seam:** this is the panel that grows when subscription tracking lands
 * properly (editing price/paid-until/notes from here). Everything about it is
 * confined to `SubscriptionPanel` in the tenant detail — adding fields means
 * extending this interface and that one component, with no other page
 * touched.
 */
export interface PlatformSubscription {
  plan: PlanId;
  priceCents: number;
  paidUntil: string | null;
  notes: string | null;
}

export interface PlatformTenantDetail {
  id: string;
  slug: string;
  name: string;
  status: TenantStatus;
  plan: PlanId;
  createdAt: string;
  month: string;
  domains: PlatformTenantDomain[];
  limits: PlatformTenantLimits | null;
  /** False when `limits` is missing or has drifted from what `plan` grants.
   * Re-assigning the same plan is the fix. */
  limitsMatchPlan: boolean;
  subscription: PlatformSubscription | null;
  counts: { staff: number; products: number };
  gmv: PlatformGmv;
  ai: PlatformAiUsage;
}

export interface AssignPlanResult {
  id: string;
  plan: PlanId;
  limits: PlatformTenantLimits;
  previousPlan: PlanId;
}

/** `'immediate'` when the storefront's resolver cache was cleared as part of
 * the write, `'within-60s'` when Redis could not be reached and the change
 * has to wait out the cache TTL. The status change itself has committed
 * either way. */
export type StorefrontEffect = 'immediate' | 'within-60s';

export interface SetStatusResult {
  id: string;
  status: TenantStatus;
  previousStatus: TenantStatus;
  storefrontEffective: StorefrontEffect;
}

// ---- query building -------------------------------------------------

export interface TenantListFilters {
  q?: string;
  status?: TenantStatus | '';
  plan?: PlanId | '';
  page?: number;
  perPage?: number;
}

/**
 * Builds the `GET /v1/platform/tenants` query string.
 *
 * Empty filters are OMITTED rather than sent blank, because
 * `platformTenantListQuerySchema` rejects `q: ''` (`.min(1)`) and
 * `status: ''` (not in the enum) with a 400 — so a UI that sent its "Todos"
 * option as an empty string would break the page instead of clearing the
 * filter. `q` is trimmed for the same reason: an all-whitespace search is
 * "no search", not a search for spaces.
 */
export function buildTenantListQuery(filters: TenantListFilters = {}): string {
  const params = new URLSearchParams();
  const q = filters.q?.trim();
  if (q) params.set('q', q);
  if (filters.status) params.set('status', filters.status);
  if (filters.plan) params.set('plan', filters.plan);
  params.set('page', String(filters.page ?? 1));
  params.set('perPage', String(filters.perPage ?? 25));
  return params.toString();
}

// ---- calls ----------------------------------------------------------

export async function listPlatformTenants(filters: TenantListFilters): Promise<PlatformTenantList> {
  return apiFetch<PlatformTenantList>(`/v1/platform/tenants?${buildTenantListQuery(filters)}`);
}

export async function getPlatformTenant(id: string): Promise<PlatformTenantDetail> {
  return apiFetch<PlatformTenantDetail>(`/v1/platform/tenants/${id}`);
}

export async function assignPlan(id: string, plan: PlanId, note?: string): Promise<AssignPlanResult> {
  const trimmed = note?.trim();
  return apiFetch<AssignPlanResult>(`/v1/platform/tenants/${id}/plan`, {
    method: 'PATCH',
    body: JSON.stringify(trimmed ? { plan, note: trimmed } : { plan }),
  });
}

/** `reason` is required by the API and required here: the audit row for a
 * storefront that went offline has to answer "why". */
export async function suspendTenant(id: string, reason: string): Promise<SetStatusResult> {
  return apiFetch<SetStatusResult>(`/v1/platform/tenants/${id}/suspend`, {
    method: 'POST',
    body: JSON.stringify({ reason: reason.trim() }),
  });
}

export async function reactivateTenant(id: string, note?: string): Promise<SetStatusResult> {
  const trimmed = note?.trim();
  return apiFetch<SetStatusResult>(`/v1/platform/tenants/${id}/reactivate`, {
    method: 'POST',
    body: JSON.stringify(trimmed ? { note: trimmed } : {}),
  });
}

// ---- operator-facing copy -------------------------------------------

/**
 * es-CO copy for the error codes only the platform API emits, falling back to
 * the shared merchant table.
 *
 * Kept separate from `errors.ts` rather than merged into it: that table's
 * copy is addressed to a merchant about their own store ("Tu tienda está
 * suspendida"), and the same code means something different here — an
 * operator reading "tu tienda" about a company they have never met is exactly
 * the confusion this whole surface is designed against.
 */
const PLATFORM_MESSAGES: Record<string, string> = {
  NOT_PLATFORM_ADMIN:
    'Tu cuenta no tiene acceso a la consola de plataforma. Si crees que es un error, escríbele al equipo de infraestructura.',
  TENANT_NOT_FOUND: 'No encontramos esta cuenta de comercio. Puede que la hayan eliminado; vuelve al listado.',
  TENANT_NOT_SUSPENDED:
    'Esta cuenta no está suspendida, así que no hay nada que reactivar. Actualiza la página para ver su estado real.',
  UNAUTHENTICATED: 'Tu sesión de operador expiró. Vuelve a iniciar sesión.',
  VALIDATION_FAILED: 'Revisa los campos marcados.',
};

export function platformErrorMessage(e: ApiError): string {
  return PLATFORM_MESSAGES[e.code] ?? errorMessage(e);
}

/** Narrows an unknown thrown value to operator copy — the same shape every
 * merchant page uses, with the platform table in front. */
export function platformErrorText(e: unknown): string {
  return e instanceof ApiError ? platformErrorMessage(e) : 'Ocurrió un error inesperado. Intenta de nuevo.';
}

// ---- derived state --------------------------------------------------

export type AiUsageLevel = 'sin-cupo' | 'normal' | 'alerta' | 'excedido';

/**
 * How a tenant's month-to-date AI consumption should read at a glance.
 *
 * - `sin-cupo`  — `messagesLimit` is 0. The agent is hard-capped at zero, so
 *                 this tenant's shoppers get no AI at all. Surfaced as its own
 *                 level rather than as "0 % usado", which reads as healthy.
 * - `alerta`    — at or past 90 %, the same threshold the API warns on.
 * - `excedido`  — at or past 100 %: the cap is being enforced right now.
 */
export function aiUsageLevel(ai: PlatformAiUsage): AiUsageLevel {
  if (ai.messagesLimit <= 0) return 'sin-cupo';
  if (ai.percentUsed === null) return 'sin-cupo';
  if (ai.percentUsed >= 100) return 'excedido';
  if (ai.percentUsed >= 90) return 'alerta';
  return 'normal';
}

/** Short es-CO reading of {@link aiUsageLevel}, for a cell that has room for
 * a few words and no room for a paragraph. */
export function aiUsageLabel(ai: PlatformAiUsage): string {
  switch (aiUsageLevel(ai)) {
    case 'sin-cupo':
      return 'Sin cupo de IA';
    case 'excedido':
      return `${ai.percentUsed} % · tope alcanzado`;
    case 'alerta':
      return `${ai.percentUsed} % del cupo`;
    default:
      return `${ai.percentUsed} % del cupo`;
  }
}

/**
 * What to tell the operator about the storefront after a status change.
 *
 * The distinction is not cosmetic: `within-60s` is the case where an operator
 * loads the storefront to check their work, still sees it serving, and
 * reasonably concludes the button did nothing. Saying so up front is the
 * difference between "wait a minute" and a second click.
 */
export function storefrontEffectMessage(result: SetStatusResult): string {
  const suspended = result.status === 'suspended';
  if (result.storefrontEffective === 'immediate') {
    return suspended
      ? 'La tienda ya está fuera de línea: sus dominios responden 503 desde este momento.'
      : 'La tienda ya está en línea otra vez: sus dominios responden desde este momento.';
  }
  return suspended
    ? 'El cambio quedó guardado, pero no pudimos limpiar la caché de dominios. La tienda puede seguir respondiendo hasta 60 segundos más.'
    : 'El cambio quedó guardado, pero no pudimos limpiar la caché de dominios. La tienda puede tardar hasta 60 segundos en volver a responder.';
}

/** es-CO summary of a plan change, for the success alert. */
export function planChangeSummary(result: AssignPlanResult): string {
  const to = PLAN_LABELS[result.plan];
  if (result.previousPlan === result.plan) {
    return `El plan sigue siendo ${to}. Se reescribieron sus límites para que coincidan con el plan.`;
  }
  return `Plan cambiado de ${PLAN_LABELS[result.previousPlan]} a ${to}. Sus límites se reescribieron para coincidir.`;
}

/**
 * The word an operator must type to suspend a tenant: **the tenant's own
 * slug**, not a fixed word like the `ANONIMIZAR` used on the Clientes page.
 *
 * The risk being defended against here is not "clicked without thinking", it
 * is "acted on the wrong company". An operator works through a list of other
 * people's stores; a constant confirmation word is muscle memory after the
 * second suspension and stops discriminating between rows entirely. A
 * per-tenant token cannot be typed from memory — producing it requires
 * reading the identifier of the store actually on screen, which is the exact
 * check that matters before taking a live business offline.
 */
export function suspendConfirmationToken(tenant: { slug: string }): string {
  return tenant.slug;
}

/** Case- and whitespace-insensitive, because the slug is an identifier being
 * transcribed, not a password: rejecting `Mi-Tienda ` for `mi-tienda` would
 * only teach operators to paste it, which defeats the point of typing it. */
export function suspendConfirmationMatches(typed: string, tenant: { slug: string }): boolean {
  const expected = suspendConfirmationToken(tenant).trim().toLowerCase();
  // An empty expected token would make an EMPTY confirmation box match, i.e.
  // a suspend button with no confirmation at all. `Tenant.slug` is unique and
  // non-empty in the schema, so this should be unreachable — which is exactly
  // why it is written down instead of assumed: the failure mode of the
  // assumption is the most destructive button in the product firing on a
  // blank form.
  if (expected.length === 0) return false;
  return typed.trim().toLowerCase() === expected;
}

const monthFormatter = new Intl.DateTimeFormat('es-CO', { month: 'long', year: 'numeric' });

/**
 * Renders the API's `YYYY-MM` AI-metering month as es-CO prose
 * (`'2026-08'` -> `'agosto de 2026'`).
 *
 * Built from explicit numeric parts rather than `new Date('2026-08')`, which
 * JS parses as UTC midnight and would render as July for anyone west of
 * Greenwich — Colombia is UTC-5, so the naive version is wrong for every user
 * of this product, every month, and only on the first day would anyone
 * notice. Anything that is not a well-formed `YYYY-MM` is returned untouched
 * rather than rendered as "Invalid Date".
 */
export function formatMonthCO(month: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) return month;
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  if (monthIndex < 0 || monthIndex > 11) return month;
  return monthFormatter.format(new Date(year, monthIndex, 1));
}
