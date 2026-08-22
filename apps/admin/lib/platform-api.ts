import { apiFetch, ApiError } from './api';
import { errorMessage } from './errors';
import { centsToPesos, formatLongDateBogota, pesosToCents, toBogotaDateInput } from './format';

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
export const PLAN_IDS = ['emprende', 'crece', 'escala'] as const;
export type PlanId = (typeof PLAN_IDS)[number];

export const TENANT_STATUSES = ['draft', 'live', 'suspended'] as const;
export type TenantStatus = (typeof TENANT_STATUSES)[number];

/** The plan id IS the display name, capitalised. Kept as a map anyway so a
 * future plan whose id and label differ has somewhere to say so. */
export const PLAN_LABELS: Record<PlanId, string> = {
  emprende: 'Emprende',
  crece: 'Crece',
  escala: 'Escala',
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
  aiCreditsMonth: number;
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
 * The five states a subscription can be in, mirroring `SubscriptionDueState`
 * in `services/api/src/platform/subscription-window.ts` — the SAME derivation
 * the auto-suspend sweep acts on, so the date shown here is the date a store
 * actually goes offline.
 */
export const SUBSCRIPTION_DUE_STATES = ['sin_fecha', 'al_dia', 'vencida', 'por_suspender', 'suspendible'] as const;
export type SubscriptionDueState = (typeof SUBSCRIPTION_DUE_STATES)[number];

/**
 * Manual v1 subscription tracking (SPEC §6 M9). The API returns the tenant's
 * single `Subscription` row (upserted, one per tenant) or `null`.
 *
 * The four stored columns plus `updatedAt`, and then the DERIVED window —
 * `dueState`, `suspendsOn`, `warnsOn`, `daysPastDue`, `graceDays`. Those are
 * computed server-side from `paidUntil` and the deployment's
 * `SUBSCRIPTION_GRACE_DAYS`, never stored, and they are echoed **so this UI
 * never has to know that setting**. Re-deriving "paidUntil + 7 days" in the
 * browser would be a second source of truth for the day a Colombian business
 * goes dark, and it would be wrong on any deployment configured differently.
 *
 * `paidUntil`, `suspendsOn`, `warnsOn` and `updatedAt` are ISO-8601 INSTANTS
 * on the wire (Prisma `Date`s through `JSON.stringify`), not calendar days: a
 * `paidUntil` of `'2026-09-01'` comes back as `'2026-09-02T04:59:59.999Z'`,
 * because the API stores it as the end of that day in `America/Bogota`
 * (`paidUntilSchema`). Rendering them therefore goes through the
 * Bogotá-pinned helpers in `format.ts`, never `formatDateCO`.
 */
export interface PlatformSubscription {
  plan: PlanId;
  priceCents: number;
  /** ISO instant, or `null` — "we have their plan and price on file, nobody
   * has paid yet". The sweep treats `null` as not-delinquent. */
  paidUntil: string | null;
  notes: string | null;
  updatedAt: string;
  dueState: SubscriptionDueState;
  /** When the sweep takes the store offline. `null` exactly when `paidUntil`
   * is null, which is also when the sweep does nothing at all. */
  suspendsOn: string | null;
  /** When the warning email goes out (grace − 3 days). */
  warnsOn: string | null;
  /** Whole days past `paidUntil`, floored; 0 while still paid. */
  daysPastDue: number;
  /** The deployment's grace window, echoed so the copy below can say "7 días
   * de gracia" without this app owning the number. */
  graceDays: number;
}

/** `PUT /v1/platform/tenants/:id/subscription` body — the WHOLE subscription,
 * every time (`recordSubscriptionSchema`). `paidUntil` is a `YYYY-MM-DD`
 * Bogotá calendar day or an explicit `null`; it is nullable rather than
 * omittable precisely so "no date on file" is a thing an operator can record
 * on purpose and not something the wire confuses with "unchanged". */
export interface RecordSubscriptionBody {
  plan: PlanId;
  priceCents: number;
  paidUntil: string | null;
  notes: string | null;
}

export interface RecordSubscriptionResult {
  tenantId: string;
  /** The tenant's status AFTER the write, which is to say: unchanged by it.
   * Recording a payment does not reactivate a suspended store — that is a
   * separate, separately-audited decision. This field exists so the panel can
   * SAY so instead of leaving the operator believing they fixed it. */
  tenantStatus: TenantStatus;
  subscription: PlatformSubscription;
}

export interface GetSubscriptionResult {
  tenantId: string;
  /** `null` (with a 200, not a 404) when nothing has been recorded. */
  subscription: PlatformSubscription | null;
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

/** The subscription panel on its own. Used when OPENING the editor: the PUT
 * is a whole-body upsert, so an operator editing a copy that went stale in an
 * open tab would silently revert whatever changed in between. Re-reading
 * immediately before editing is what keeps "save" from meaning "revert". */
/**
 * Starts an impersonation session for `id` (design §3). Returns nothing the
 * caller needs: the whole effect is the `Set-Cookie` on the response, which is
 * why {@link startImpersonation} is followed by a FULL navigation rather than
 * a router push — see the note on `impersonationEntryHref`.
 */
export async function startImpersonation(id: string, reason?: string): Promise<void> {
  await apiFetch<{ impersonation: unknown }>(`/v1/platform/tenants/${id}/impersonate`, {
    method: 'POST',
    body: JSON.stringify(reason?.trim() ? { reason: reason.trim() } : {}),
  });
}

/**
 * Where the browser must land once the grant cookie exists: the merchant
 * admin root, reached by a FULL page load.
 *
 * Not `router.push`. The merchant shell reads the session on the server
 * (`app/(app)/layout.tsx` → `getMe()`), so a client-side navigation would
 * render the shell from a cache populated before the cookie existed — the
 * operator would land in the merchant admin with no impersonation banner,
 * which is precisely the state design §5's "visually unmistakable" AC exists
 * to make impossible. `window.location.assign` guarantees the server sees the
 * new cookie and returns a shell that knows it.
 */
export function impersonationEntryHref(): string {
  return '/';
}

export async function getSubscription(id: string): Promise<GetSubscriptionResult> {
  return apiFetch<GetSubscriptionResult>(`/v1/platform/tenants/${id}/subscription`);
}

/** Record or update the tenant's subscription. PUT, whole body, idempotent —
 * a retried request cannot produce a second billing record. */
export async function recordSubscription(
  id: string,
  body: RecordSubscriptionBody,
): Promise<RecordSubscriptionResult> {
  return apiFetch<RecordSubscriptionResult>(`/v1/platform/tenants/${id}/subscription`, {
    method: 'PUT',
    body: JSON.stringify(body),
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

// ---- subscription: derived copy and form logic ----------------------

/** `1 día` / `4 días`. */
function daysWord(n: number): string {
  return `${n} día${n === 1 ? '' : 's'}`;
}

export const SUBSCRIPTION_DUE_LABELS: Record<SubscriptionDueState, string> = {
  sin_fecha: 'Sin fecha',
  al_dia: 'Al día',
  vencida: 'Vencida',
  por_suspender: 'Por suspender',
  suspendible: 'Suspendible',
};

/** Same weighting logic as `TENANT_STATUS_BADGE`: the healthy case is the
 * quiet one, and the red is spent on the state where a store is about to go
 * (or has already gone) offline over money. */
export const SUBSCRIPTION_DUE_BADGE: Record<SubscriptionDueState, 'default' | 'secondary' | 'destructive'> = {
  sin_fecha: 'secondary',
  al_dia: 'secondary',
  vencida: 'default',
  por_suspender: 'default',
  suspendible: 'destructive',
};

export interface SubscriptionNotice {
  variant: 'info' | 'success' | 'warning' | 'error';
  text: string;
}

/**
 * What the operator is told about where this subscription sits in its cycle.
 *
 * Every date in here comes from the API's own `suspendsOn` / `warnsOn` /
 * `graceDays`, never from arithmetic performed in this file. That is the
 * whole reason those fields are on the wire: the sweep's grace window is a
 * per-deployment setting, and a UI that added seven days itself would be
 * confidently wrong on any deployment that changed it — while telling an
 * operator a specific day on which someone's business will stop selling.
 */
export function subscriptionDueNotice(subscription: PlatformSubscription): SubscriptionNotice {
  const on = subscription.suspendsOn ? formatLongDateBogota(subscription.suspendsOn) : null;
  // Degrades to a date-less sentence rather than to "el null" if the API ever
  // sends a state with no computable date.
  const suspendsPhrase = on ? `el ${on}` : 'al terminar la ventana de gracia';
  const past = subscription.daysPastDue;

  switch (subscription.dueState) {
    case 'sin_fecha':
      return {
        variant: 'info',
        text: 'Sin fecha de pago registrada. Mientras no haya una, la suspensión automática no toca esta tienda.',
      };
    case 'al_dia':
      return {
        variant: 'success',
        text: `Al día. Si no se registra un pago nuevo, la tienda se suspende sola ${suspendsPhrase} — ${daysWord(subscription.graceDays)} de gracia después de la fecha pagada.`,
      };
    case 'vencida':
      return {
        variant: 'warning',
        text: `${past === 0 ? 'Venció hoy' : `Venció hace ${daysWord(past)}`}. La tienda se suspende sola ${suspendsPhrase}.`,
      };
    case 'por_suspender':
      return {
        variant: 'warning',
        text: `Venció hace ${daysWord(past)} y ya entró en el aviso previo. La tienda se suspende sola ${suspendsPhrase}.`,
      };
    case 'suspendible':
      return {
        variant: 'error',
        text: `Venció hace ${daysWord(past)} y pasó la ventana de gracia de ${daysWord(subscription.graceDays)}. La barrida automática ya puede dejar esta tienda fuera de línea; si todavía aparece activa es porque aún no ha corrido.`,
      };
  }
}

/**
 * What to say after a successful `PUT`.
 *
 * The suspended branch is the reason `tenantStatus` is in the response at
 * all. An operator who just recorded "pagado hasta el 30 de septiembre" for a
 * store that was suspended last week has done half of a job and has every
 * reason to think they did all of it — nothing on screen would contradict
 * them. Saying it here, next to the button they just pressed, is the
 * difference between a merchant back online today and a merchant back online
 * whenever somebody notices.
 */
export function subscriptionSaveNotice(result: RecordSubscriptionResult): SubscriptionNotice {
  if (result.tenantStatus === 'suspended') {
    return {
      variant: 'warning',
      text: 'Guardamos la suscripción, pero la tienda sigue suspendida: registrar un pago no la reactiva. Reactivarla es una decisión aparte — usa «Reactivar tienda» en Estado de la cuenta si corresponde.',
    };
  }
  return {
    variant: 'success',
    text: `Suscripción guardada. ${subscriptionDueNotice(result.subscription).text}`,
  };
}

// ---- the edit form --------------------------------------------------

export interface SubscriptionFormValues {
  plan: PlanId;
  /** As typed, in PESOS — the unit merchants and operators speak. Converted
   * to cents on submit by `pesosToCents`, same as every other price field in
   * this app. */
  price: string;
  /** `YYYY-MM-DD` from an `<input type="date">`, or `''` for "no date on
   * file", which is a state the API accepts and the sweep respects. */
  paidUntil: string;
  notes: string;
}

export type SubscriptionFormField = 'plan' | 'price' | 'paidUntil' | 'notes';
export type SubscriptionFormErrors = Partial<Record<SubscriptionFormField, string>>;

export type ParsedSubscriptionForm =
  | { ok: true; body: RecordSubscriptionBody }
  | { ok: false; errors: SubscriptionFormErrors };

/** Seeds the editor from the row on file, falling back to the tenant's
 * assigned plan when there is no subscription yet — an operator recording a
 * first payment is almost always billing the plan the tenant already has, and
 * pre-selecting it is one less thing to get wrong. Price is left BLANK rather
 * than defaulted to 0, because 0 is a real, meaningful value here (a comped
 * or pilot account) and must be typed on purpose. */
export function subscriptionFormValues(
  subscription: PlatformSubscription | null,
  fallbackPlan: PlanId,
): SubscriptionFormValues {
  if (!subscription) return { plan: fallbackPlan, price: '', paidUntil: '', notes: '' };
  return {
    plan: subscription.plan,
    price: String(centsToPesos(subscription.priceCents)),
    paidUntil: subscription.paidUntil ? (toBogotaDateInput(subscription.paidUntil) ?? '') : '',
    notes: subscription.notes ?? '',
  };
}

/** The server's `priceCents` ceiling (`recordSubscriptionSchema`): 1 000 000 000
 * cents = $10 000 000. Mirrored so a typo is a field error next to the input
 * instead of a 400 with no field attached. */
const MAX_PRICE_CENTS = 1_000_000_000;
const MAX_NOTES = 1000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** `2026-02-31` is NOT a date. `new Date('2026-02-31T00:00:00Z')` does not
 * fail — it rolls forward to 3 March — so a typo would be silently accepted
 * as a LATER day, which on this particular field means a store staying online
 * longer than anyone agreed. Same check `paidUntilSchema` performs. */
function isRealCalendarDay(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * Validates the editor and produces the PUT body.
 *
 * Mirrors `recordSubscriptionSchema` rather than trusting the round trip: the
 * API is still the authority (this cannot be the security boundary, and it is
 * not written as one), but a 400 on this form arrives as a generic
 * VALIDATION_FAILED with no field attached, and an operator who mistyped a
 * date deserves to be told which field.
 *
 * An empty date is `null`, not "leave it alone". There is no "leave it alone"
 * on a PUT that carries the whole resource, and pretending otherwise on the
 * one field that decides whether a store stays up is how a UI silently
 * un-records a payment.
 */
export function parseSubscriptionForm(values: SubscriptionFormValues): ParsedSubscriptionForm {
  const errors: SubscriptionFormErrors = {};

  if (!PLAN_IDS.includes(values.plan)) errors.plan = 'Elige un plan.';

  const priceCents = pesosToCents(values.price);
  if (priceCents === null) {
    errors.price = 'Escribe el precio en pesos (0 o más).';
  } else if (priceCents > MAX_PRICE_CENTS) {
    errors.price = 'El precio supera el máximo permitido.';
  }

  const typedDate = values.paidUntil.trim();
  let paidUntil: string | null = null;
  if (typedDate !== '') {
    if (!DATE_ONLY.test(typedDate) || !isRealCalendarDay(typedDate)) {
      errors.paidUntil = 'Usa una fecha válida con formato AAAA-MM-DD.';
    } else {
      const year = Number(typedDate.slice(0, 4));
      if (year < 2020 || year > 2100) {
        errors.paidUntil = 'La fecha debe estar entre 2020 y 2100.';
      } else {
        paidUntil = typedDate;
      }
    }
  }

  const notes = values.notes.trim();
  if (notes.length > MAX_NOTES) errors.notes = `La nota no puede superar ${MAX_NOTES} caracteres.`;

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  return {
    ok: true,
    body: { plan: values.plan, priceCents: priceCents as number, paidUntil, notes: notes === '' ? null : notes },
  };
}
