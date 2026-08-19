import { cookies } from 'next/headers';

/**
 * Server-side gate for the `/plataforma` route group.
 *
 * ## This is not the security boundary, and it is not written as if it were
 *
 * `PlatformAdminGuard` on the API is the boundary: an env allowlist the
 * product cannot write to, AND `User.isPlatformAdmin`, AND a verified email.
 * Every `/v1/platform/*` response is 401/403 for anyone who fails it,
 * regardless of what this file does. Nothing here grants access to data;
 * the data lives behind that guard.
 *
 * What this file decides is only **what the browser renders** for someone who
 * would be refused anyway: a merchant who types `/plataforma` should get an
 * honest "no tienes acceso" page instead of an operator console that then
 * fills with red error alerts on every panel.
 *
 * ## Why it asks the API instead of reading a claim
 *
 * The obvious cheap implementation is to read a flag off the session and
 * branch on it. There is no such flag — `/v1/admin/me` returns
 * `userId/email/tenantId/role/emailVerified` and deliberately not
 * `isPlatformAdmin` — and inventing one would be worse than useless: a
 * client-side boolean that says "you are an operator" is a claim about the
 * user, not a check of the three conditions the guard actually enforces, and
 * the two could silently disagree (allowlist rotated, column revoked, email
 * unverified). So the probe is the real endpoint, with the caller's own
 * cookies, and the answer is whatever the guard says. There is exactly one
 * authority and this file is not it.
 *
 * The probe asks for one row (`perPage=1`) because the cheapest true question
 * is "would the guard let me in", not "give me the data".
 */

export type PlatformAccess = 'operator' | 'anonymous' | 'denied' | 'unavailable';

/**
 * Maps the probe's HTTP status onto what the shell should do.
 *
 * Fails closed by construction: `operator` is returned for exactly one status
 * and everything else — including statuses this app has never seen — lands on
 * `unavailable`, which renders an error rather than a console. A default that
 * fell through to `operator` would turn any API hiccup into a rendered
 * cross-tenant surface.
 */
export function platformAccessFromStatus(status: number): PlatformAccess {
  if (status === 200) return 'operator';
  if (status === 401) return 'anonymous';
  if (status === 403) return 'denied';
  return 'unavailable';
}

export interface PlatformSession {
  access: PlatformAccess;
  /** Best-effort: the operator's own login, shown in the console chrome so an
   * operator can see WHICH account they are acting as before they act on
   * someone else's store. Undefined when it could not be resolved — an
   * operator with no merchant tenant of their own gets 403 NO_TENANT from
   * `/v1/admin/me`, which is a perfectly normal state for a Ventia employee
   * and must not block the console. */
  email?: string;
}

const API_INTERNAL_URL = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';

/** Forwards the incoming request's cookies to the API — server components
 * cannot use the same-origin `/api` rewrite, which only exists for
 * client-side fetches. Same helper shape as `session.ts`'s. */
async function fetchFromApi(path: string): Promise<Response> {
  const cookieStore = await cookies();
  const cookieHeader = cookieStore.toString();
  return fetch(`${API_INTERNAL_URL}${path}`, {
    headers: cookieHeader ? { cookie: cookieHeader } : {},
    cache: 'no-store',
  });
}

async function fetchOperatorEmail(): Promise<string | undefined> {
  try {
    const response = await fetchFromApi('/v1/admin/me');
    if (!response.ok) return undefined;
    const body = (await response.json()) as { email?: unknown };
    return typeof body.email === 'string' ? body.email : undefined;
  } catch {
    return undefined;
  }
}

/** Never throws: a network failure resolves to `unavailable`, which renders
 * an error page. It deliberately does NOT resolve to `operator`. */
export async function getPlatformSession(): Promise<PlatformSession> {
  let response: Response;
  try {
    response = await fetchFromApi('/v1/platform/tenants?perPage=1');
  } catch {
    return { access: 'unavailable' };
  }

  const access = platformAccessFromStatus(response.status);
  if (access !== 'operator') return { access };

  return { access, email: await fetchOperatorEmail() };
}
