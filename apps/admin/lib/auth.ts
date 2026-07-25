/** Client-side helpers for the three better-auth endpoints the auth pages
 * use. NOT built on top of `apiFetch`/`ApiError` (lib/api.ts, lib/errors.ts):
 * those assume our own API's `{ error: string, details? }` error body, but
 * better-auth (mounted at `/v1/auth/*`, see services/api/src/main.ts) throws
 * its own `APIError`, which serializes as `{ code: string, message: string }`
 * (verified against the installed better-auth@1.6.25 + better-call sources —
 * see services/api/src/auth/auth.ts). Reusing `apiFetch` here would silently
 * collapse every auth error to the generic UNKNOWN message, since
 * `body.error` is never a string on a better-auth error body. */

export interface AuthErrorBody {
  code?: string;
  message?: string;
}

/** Thrown by the sign-in/sign-up/sign-out helpers below. */
export class AuthError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(status: number, code?: string) {
    super(code ?? 'AUTH_ERROR');
    this.name = 'AuthError';
    this.status = status;
    this.code = code;
  }
}

/** es-CO copy for the better-auth error codes the sign-in/sign-up forms can
 * realistically hit (see auth.ts's doc comment for how these were verified).
 * Unrecognized codes fall back to a generic message, same policy as
 * lib/errors.ts's `errorMessage`. */
const MESSAGES: Record<string, string> = {
  INVALID_EMAIL_OR_PASSWORD: 'Correo o contraseña incorrectos.',
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: 'Ese correo ya está registrado.',
  INVALID_EMAIL: 'Ingresa un correo válido.',
  INVALID_PASSWORD: 'Ingresa una contraseña válida.',
  PASSWORD_TOO_SHORT: 'La contraseña es demasiado corta.',
  PASSWORD_TOO_LONG: 'La contraseña es demasiado larga.',
  NETWORK: 'No pudimos conectar con el servidor. Verifica tu conexión.',
};

/** Maps an {@link AuthError} to an es-CO message safe to show a merchant.
 * Falls back on `status` when the code itself isn't recognized (a bare 401
 * with an unmapped/missing code still reads as bad credentials). */
export function authErrorMessage(e: AuthError): string {
  if (e.code && MESSAGES[e.code]) return MESSAGES[e.code];
  if (e.status === 401) return MESSAGES.INVALID_EMAIL_OR_PASSWORD;
  return 'Ocurrió un error inesperado. Intenta de nuevo.';
}

async function postAuth(path: string, body: unknown): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`/api/v1/auth${path}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new AuthError(0, 'NETWORK');
  }

  if (!response.ok) {
    let parsed: AuthErrorBody = {};
    try {
      parsed = (await response.json()) as AuthErrorBody;
    } catch {
      // Unparseable body — fall through with an empty AuthErrorBody so the
      // caller still gets a status-based fallback message.
    }
    throw new AuthError(response.status, parsed.code);
  }
}

export async function signInEmail(email: string, password: string): Promise<void> {
  await postAuth('/sign-in/email', { email, password });
}

export async function signUpEmail(name: string, email: string, password: string): Promise<void> {
  await postAuth('/sign-up/email', { name, email, password });
}

export async function signOut(): Promise<void> {
  await postAuth('/sign-out', {});
}
