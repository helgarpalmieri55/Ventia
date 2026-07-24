/** Typed error thrown by {@link apiFetch} for both HTTP and network failures. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, details?: unknown) {
    super(`ApiError ${status} ${code}`);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

interface ErrorBody {
  error?: unknown;
  details?: unknown;
}

function isErrorBody(value: unknown): value is ErrorBody {
  return typeof value === 'object' && value !== null;
}

/** Fetches `${path}` under the same-origin `/api` prefix (proxied to the
 * backend by next.config.ts rewrites) and parses the JSON response.
 *
 * - Non-2xx responses are parsed as `{ error, details }` and thrown as an
 *   {@link ApiError}; an unparseable body falls back to code `'UNKNOWN'`.
 * - A network failure (fetch rejecting, e.g. offline/DNS/CORS) is thrown as
 *   `ApiError(0, 'NETWORK')`.
 */
export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      credentials: 'include',
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...init?.headers,
      },
    });
  } catch {
    throw new ApiError(0, 'NETWORK');
  }

  if (!response.ok) {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }

    if (isErrorBody(body) && typeof body.error === 'string') {
      throw new ApiError(response.status, body.error, body.details);
    }
    throw new ApiError(response.status, 'UNKNOWN');
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}
