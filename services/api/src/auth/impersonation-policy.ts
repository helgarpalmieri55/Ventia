import { HttpException } from '@nestjs/common';

/**
 * What a Ventia operator may DO inside a merchant's store while impersonating
 * (docs/superpowers/specs/2026-08-19-impersonation-design.md §4).
 *
 * ## Allow-list, default deny
 *
 * A deny-list is wrong here for the reason it is always wrong: every route
 * added after it was written is permitted by default, and the failure is
 * silent. So:
 *
 *   - **Reads (`GET`/`HEAD`) are broadly available.** Support means seeing the
 *     store as the merchant sees it, and no admin read endpoint in this
 *     codebase returns decrypted credentials — `PaymentsService.decrypt` is
 *     reachable only from checkout and the webhook verifier, never from an
 *     HTTP response (see `settings.controller.ts`'s doc comment), and
 *     `WhatsAppNumbersService.listForTenant` projects away every token. If
 *     that ever stops being true, the route belongs in `HARD_DENY` below with
 *     `method: '*'`.
 *   - **Writes start at ZERO.** `WRITE_ALLOWLIST` ships empty. That is not an
 *     oversight and it is not a TODO: the design says widening it is "a
 *     reviewed, one-line-per-route decision with a name attached", and no such
 *     review has happened. An operator who needs to change something in a
 *     merchant's store asks the merchant, or a named human adds a line here.
 *
 * ## HARD_DENY, and why it exists when the allow-list is already empty
 *
 * Three categories in §4 are refused *regardless of what the audit log would
 * say*, because an audit row answers "who did this?" and is no remedy at all
 * for an action whose effect has already left the building. Today the empty
 * allow-list refuses them along with everything else — so HARD_DENY changes
 * no behaviour at all right now.
 *
 * It is here so that the FIRST person to widen the allow-list cannot
 * accidentally take one of them with it. The categories are a property of the
 * routes, not of the current list's contents, and encoding them separately is
 * what keeps "refused" from quietly becoming "was refused, once".
 */

export type ImpersonationRouteMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | '*';

export interface ImpersonationRouteRule {
  method: ImpersonationRouteMethod;
  /** A NORMALIZED path (see `normalizeRoutePath`): every uuid segment
   * replaced by `:id`, no query string, no trailing slash. Matched exactly —
   * no prefixes, no globs, because a prefix rule is a deny-list wearing an
   * allow-list's clothes. */
  path: string;
  /** Why. Read by nobody at runtime; read by everybody at review time. */
  why: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `/v1/admin/customers/1f8f.../anonymize?x=1` → `/v1/admin/customers/:id/anonymize`.
 *
 * Uuid segments collapse to `:id` so a rule names a route rather than a row.
 * Anything that is not a uuid is left alone — `/v1/admin/settings/payments`
 * and `/v1/admin/content/policy_privacy` are routes whose last segment is
 * meaningful, and collapsing those would make one rule cover endpoints it was
 * never reviewed for.
 */
export function normalizeRoutePath(rawPath: string): string {
  const path = rawPath.split('?')[0].split('#')[0];
  const segments = path.split('/').filter((s) => s.length > 0);
  const normalized = segments.map((s) => (UUID.test(s) ? ':id' : s));
  return `/${normalized.join('/')}`;
}

/**
 * §4's three categories. Refused during impersonation no matter what the
 * allow-list says.
 *
 * 1. Irreversible destruction of a third party's rights.
 * 2. Anything that emails or messages a real customer.
 * 3. Credential and identity surfaces.
 */
export const IMPERSONATION_HARD_DENY: readonly ImpersonationRouteRule[] = Object.freeze([
  // -- 1. irreversible destruction of a third party's rights ---------------
  {
    method: 'POST',
    path: '/v1/admin/customers/:id/anonymize',
    why: '§4.1 Ley 1581 supresión — one-way by design, rewrites PII in place, cannot be undone. An operator must never trigger a shopper\'s supresión while wearing a merchant\'s face, and the merchant must never have to explain to the SIC an anonymization they did not request.',
  },

  // -- 2. anything that emails or messages a real customer -----------------
  // Order transitions send shopper-facing mail (orders.service.ts sends
  // confirmed/shipped/delivered). An audit row does not unsend them.
  { method: 'PATCH', path: '/v1/admin/orders/:id/confirm', why: '§4.2 sends the shopper a confirmation email' },
  { method: 'PATCH', path: '/v1/admin/orders/:id/preparing', why: '§4.2 shopper-facing order transition' },
  { method: 'PATCH', path: '/v1/admin/orders/:id/shipped', why: '§4.2 sends the shopper a shipping email' },
  { method: 'PATCH', path: '/v1/admin/orders/:id/delivered', why: '§4.2 sends the shopper a delivery email' },
  { method: 'PATCH', path: '/v1/admin/orders/:id/cancel', why: '§4.2 shopper-facing order transition' },
  {
    method: 'PATCH',
    path: '/v1/admin/conversations/:id/resolve',
    why: '§4.2 closes a live conversation with a real shopper on the merchant\'s WhatsApp number',
  },

  // -- 3. credential and identity surfaces ---------------------------------
  {
    method: 'PATCH',
    path: '/v1/admin/settings/payments',
    why: '§4.3 rewires where a merchant\'s money lands',
  },
  {
    method: 'POST',
    path: '/v1/admin/settings/payments/:id/test-connection',
    why: '§4.3 exercises the merchant\'s gateway credentials against the gateway',
  },
  { method: 'POST', path: '/v1/admin/whatsapp/numbers', why: '§4.3 WhatsApp credentials' },
  { method: 'PATCH', path: '/v1/admin/whatsapp/numbers/:id', why: '§4.3 WhatsApp credentials' },
  { method: 'DELETE', path: '/v1/admin/whatsapp/numbers/:id', why: '§4.3 WhatsApp credentials' },
  {
    method: 'POST',
    path: '/v1/admin/staff/invites',
    why: '§4.3 mints a persistent membership that outlives the thirty minutes and the audit trail\'s usefulness',
  },
  { method: 'DELETE', path: '/v1/admin/staff/invites/:id', why: '§4.3 staff/identity surface' },
  { method: 'DELETE', path: '/v1/admin/staff/:id', why: '§4.3 staff/identity surface' },
  { method: 'POST', path: '/v1/admin/domains', why: '§4.3 custom domains are an identity surface' },
  { method: 'POST', path: '/v1/admin/domains/:id/verify', why: '§4.3 custom domains are an identity surface' },
  { method: 'DELETE', path: '/v1/admin/domains/:id', why: '§4.3 custom domains are an identity surface' },
]);

/**
 * Writes an operator may perform inside a store.
 *
 * EMPTY, deliberately. See the header comment. Adding an entry is a reviewed
 * decision: put the route, the method, and WHY a Ventia operator taking this
 * action on a merchant's behalf is defensible — and satisfy yourself it is in
 * none of §4's three categories, because HARD_DENY only catches the routes
 * somebody already thought of.
 */
let writeAllowlist: readonly ImpersonationRouteRule[] = Object.freeze([]);

export function impersonationWriteAllowlist(): readonly ImpersonationRouteRule[] {
  return writeAllowlist;
}

/**
 * Runs `fn` with extra routes temporarily allow-listed, then restores.
 *
 * This exists for ONE reason: design §7 requires a test proving that "every
 * write performed under impersonation records the operator's `userId`, not
 * the merchant's" — and with a genuinely empty allow-list there is no write to
 * perform, so that assertion would be untestable and the property the whole
 * design exists for would go unproven. The alternative was to ship a write
 * allow-listed purely so a test could reach it, which would be a security
 * decision made by a test.
 *
 * It is a lexically-scoped, restoring override in application code, not a
 * runtime knob: nothing reads an env var or a request field to get here, so
 * no HTTP request can widen the list.
 *
 * ## Why it refuses to run outside a test
 *
 * `writeAllowlist` is module state, so the widening is process-wide for the
 * duration of `fn` — a concurrent request arriving inside that window would
 * inherit it. In a test that is harmless (one call, no traffic). In a serving
 * process it would be a cross-request privilege leak, and the fact that it can
 * only be reached by editing application code makes that a review question
 * rather than an impossibility.
 *
 * So it is made impossible instead. Vitest sets both `VITEST` and
 * `NODE_ENV=test`; this deployment sets neither (nothing in `.env.example`,
 * the Dockerfile or `main.ts` assigns `NODE_ENV`, which is also why the grant
 * cookie's `Secure` flag is derived from `API_URL` rather than from it). A
 * serving process therefore throws here rather than quietly widening what an
 * operator may do inside a merchant's store.
 */
export async function withImpersonationWriteAllowlist<T>(
  rules: readonly ImpersonationRouteRule[],
  fn: () => Promise<T>,
): Promise<T> {
  if (!process.env.VITEST && process.env.NODE_ENV !== 'test') {
    throw new Error(
      'withImpersonationWriteAllowlist is a test-only affordance and must never run in a serving ' +
        'process: it widens the impersonation write allow-list process-wide for the duration of the ' +
        'call, so a concurrent request would inherit it. To let an operator perform a write, add the ' +
        'route to the allow-list above as a reviewed decision.',
    );
  }

  const previous = writeAllowlist;
  writeAllowlist = Object.freeze([...previous, ...rules]);
  try {
    return await fn();
  } finally {
    writeAllowlist = previous;
  }
}

export type ImpersonationRouteDecision =
  | { allowed: true }
  | { allowed: false; error: 'IMPERSONATION_FORBIDDEN_ROUTE' | 'IMPERSONATION_READ_ONLY'; why: string };

function matches(rule: ImpersonationRouteRule, method: string, path: string): boolean {
  return (rule.method === '*' || rule.method === method) && rule.path === path;
}

/**
 * The whole policy, in order:
 *
 *   1. HARD_DENY wins over everything, including a future allow-list entry.
 *   2. Reads are allowed.
 *   3. Writes are allowed only if enumerated.
 *   4. Otherwise denied.
 *
 * `method` is upper-cased by the caller (`req.method` already is).
 */
export function impersonationRouteDecision(method: string, rawPath: string): ImpersonationRouteDecision {
  const path = normalizeRoutePath(rawPath);

  const denied = IMPERSONATION_HARD_DENY.find((rule) => matches(rule, method, path));
  if (denied) {
    return { allowed: false, error: 'IMPERSONATION_FORBIDDEN_ROUTE', why: denied.why };
  }

  if (method === 'GET' || method === 'HEAD') return { allowed: true };

  const allowed = writeAllowlist.find((rule) => matches(rule, method, path));
  if (allowed) return { allowed: true };

  return {
    allowed: false,
    error: 'IMPERSONATION_READ_ONLY',
    why: 'Writes during impersonation are an allow-list and this route is not on it (design §4).',
  };
}

/**
 * The per-request enforcement, called by both guards that can produce an
 * impersonated `SessionContext` (`AdminSessionGuard` and `AuthenticatedGuard`).
 *
 * Two refusals, in order:
 *
 * 1. **Tenant mismatch.** A grant for tenant X on a request that RESOLVES
 *    tenant Y (design §7). On the admin surface the tenant normally comes from
 *    the grant itself, so this bites when an operator drives an `/v1/admin/*`
 *    call at a merchant's storefront host, where `TenantMiddleware` has
 *    already resolved a different tenant from the `Host` header. Postgres RLS
 *    would stop the query anyway — `tenantDb` still sets `app.tenant_id` and
 *    `SET LOCAL ROLE ventia_app`, unchanged by this feature (design §6) — but
 *    a request that names two tenants is incoherent and should be refused
 *    before it reaches a query, not survive by accident of a lower layer.
 * 2. **The route policy** (`impersonationRouteDecision`).
 */
export function assertImpersonatedRequestAllowed(
  impersonatedTenantId: string,
  method: string,
  rawPath: string,
  resolvedTenantId: string | null | undefined,
): void {
  if (resolvedTenantId && resolvedTenantId !== impersonatedTenantId) {
    throw new HttpException({ error: 'IMPERSONATION_TENANT_MISMATCH' }, 403);
  }
  const decision = impersonationRouteDecision(method.toUpperCase(), rawPath);
  if (!decision.allowed) {
    throw new HttpException({ error: decision.error, why: decision.why }, 403);
  }
}
