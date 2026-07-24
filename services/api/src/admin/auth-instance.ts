import type { createAuth } from '../auth/auth';

/**
 * DI token for the single shared better-auth instance. Provided by
 * AdminModule (useFactory) and reused both by admin-only providers (the
 * AdminSessionGuard) and by main.ts (`app.get(AUTH_INSTANCE)`) for the
 * `toNodeHandler` mount at `/v1/auth/*` — one instance, not two.
 *
 * Kept in its own module (rather than admin.module.ts, despite the brief's
 * inline example) so admin-session.guard.ts can import the token without a
 * require cycle through admin.module.ts (which itself imports the guard as a
 * provider).
 */
export const AUTH_INSTANCE = Symbol('AUTH_INSTANCE');

export type AuthInstance = ReturnType<typeof createAuth>;
