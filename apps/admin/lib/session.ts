import { cookies } from 'next/headers';

export type Role = 'owner' | 'staff';

/** The `/v1/admin/me` 200 shape, plus a best-effort `tenant.name` that this
 * helper fetches separately (see below) — `/v1/admin/me` itself only ever
 * returns the flat `tenantId` string, never a nested tenant object. */
export interface Me {
  userId: string;
  email: string;
  tenantId: string;
  role: Role;
  emailVerified: boolean;
  tenant?: { name: string };
}

/** Discriminated union so callers (the (app) and (setup) layouts) can
 * switch on `kind` instead of juggling null/undefined:
 * - `anonymous`   — no session at all (no cookie, or an expired/invalid one).
 * - `no-tenant`   — a signed-in better-auth session with no membership yet
 *                    (server: 403 `NO_TENANT`). This is exactly the state a
 *                    freshly-registered user is in until they complete
 *                    `POST /onboarding/tenant`, so it still needs to reach
 *                    `/onboarding` rather than being treated like `anonymous`.
 *                    NOTE: `/v1/admin/me` returns only `{ error: 'NO_TENANT' }`
 *                    on 403 — no email/user fields — so this variant carries
 *                    no extra data. (The brief sketches `{ kind: 'no-tenant',
 *                    email }`; without an endpoint that returns identity for a
 *                    tenant-less session, there is no `email` to put there.)
 * - `member`      — full session with a tenant + role.
 */
export type SessionResult =
  | { kind: 'anonymous' }
  | { kind: 'no-tenant' }
  | { kind: 'member'; me: Me };

const API_INTERNAL_URL = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';

interface AdminMeResponse {
  userId: string;
  email: string;
  tenantId: string;
  role: Role;
  emailVerified: boolean;
}

interface AdminSettingsResponse {
  name: string;
}

/** Forwards the incoming request's cookies to the API's `${path}` under
 * `API_INTERNAL_URL` (server components can't use the same-origin `/api`
 * rewrite for their own requests — that rewrite only exists for the
 * client-side `fetch`/`apiFetch` calls Next.js itself proxies). */
async function fetchFromApi(path: string): Promise<Response> {
  const cookieStore = await cookies();
  const cookieHeader = cookieStore.toString();
  return fetch(`${API_INTERNAL_URL}${path}`, {
    headers: cookieHeader ? { cookie: cookieHeader } : {},
    cache: 'no-store',
  });
}

/** Best-effort store name for the shell header. `GET /v1/admin/settings` is
 * owner-only (@Roles('owner') — a staff session gets 403 FORBIDDEN_ROLE), so
 * this is only attempted for owners; staff sessions fall back to a generic
 * label in the shell. Any failure here (network, non-2xx, bad body) is
 * swallowed — a missing store name must never break the whole session
 * lookup. */
async function fetchStoreName(): Promise<string | undefined> {
  try {
    const response = await fetchFromApi('/v1/admin/settings');
    if (!response.ok) return undefined;
    const body = (await response.json()) as AdminSettingsResponse;
    return typeof body.name === 'string' ? body.name : undefined;
  } catch {
    return undefined;
  }
}

/** Server-side session lookup for the admin app's layouts. Never throws —
 * a network failure resolves to `anonymous` so a broken API doesn't crash
 * the page render, it just sends the visitor to /login. */
export async function getMe(): Promise<SessionResult> {
  let response: Response;
  try {
    response = await fetchFromApi('/v1/admin/me');
  } catch {
    return { kind: 'anonymous' };
  }

  if (response.status === 401) return { kind: 'anonymous' };
  if (response.status === 403) return { kind: 'no-tenant' };
  if (!response.ok) return { kind: 'anonymous' };

  const body = (await response.json()) as AdminMeResponse;
  const me: Me = { ...body };

  if (me.role === 'owner') {
    const name = await fetchStoreName();
    if (name) me.tenant = { name };
  }

  return { kind: 'member', me };
}
