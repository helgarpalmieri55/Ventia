/** Client-side typed checkout client, called from the browser — same
 * proxy-route pattern as `cart-api.ts` (see that file's header comment for
 * the full rationale on why `apiUrl`/`tenantHost` params are dropped in
 * favor of a fixed same-origin path).
 *
 * Deviation from the task brief's illustrative signatures
 * (`fetchShippingQuote(apiUrl, tenantHost, departamentoCode)` and
 * `submitCheckout(apiUrl, tenantHost, input)`): following Task 7's resolved
 * pattern, both params are dropped here too — the browser calls the
 * same-origin `/api/checkout/...` Route Handler proxy
 * (`app/api/checkout/[[...path]]/route.ts`), which resolves the tenant off
 * the incoming request's own `Host` header server-side, so the client never
 * needs to pass either.
 *
 * `fetchImpl` is still threaded through (default `fetch`), matching
 * `cart-api.ts`'s injectable-fetch convention, so `checkout-api.test.ts` can
 * assert on call shape without a real network.
 */

export interface ShippingQuoteLine {
  id: string;
  type: string;
  label: string;
  priceCents: number;
}

export interface CheckoutSubmitInput {
  email: string;
  phone: string;
  address: {
    nombreCompleto: string;
    telefono: string;
    departamentoCode: string;
    municipioName: string;
    direccion: string;
    complemento?: string;
    barrio?: string;
    notas?: string;
  };
  shippingMethodId: string;
  paymentMethod: 'cod' | 'wompi';
}

export interface CheckoutResult {
  orderNumber: number;
  totalCents: number;
  // Only present for a `wompi` checkout — see checkout.service.ts's
  // `CheckoutResult` for the full contract. Absent entirely for `cod`.
  redirectUrl?: string;
}

interface ErrorBody {
  error?: unknown;
  details?: unknown;
}

function isErrorBody(value: unknown): value is ErrorBody {
  return typeof value === 'object' && value !== null;
}

/** Thrown for any non-2xx response from the `/api/checkout/...` proxy.
 *
 * Deliberately DIFFERENT from `CartApiError`'s plain status+raw-body-text
 * shape: the checkout page needs to branch on the API's `error` CODE (e.g.
 * `CART_EMPTY` vs `INSUFFICIENT_STOCK` vs `VALIDATION_FAILED`) to show a
 * shopper-appropriate message per case, and `VALIDATION_FAILED` in
 * particular needs its nested `details` (a zod `.flatten()` shape, itself
 * nested one level deeper under `details.address` for address-field errors —
 * see `checkout.controller.ts`'s `parseCheckoutBody`) to surface per-field
 * messages. That's worth the small extra JSON-parsing this class does over
 * `CartApiError`'s "just carry the raw text" approach, since cart mutations
 * never needed to branch on the error code this granularly. */
export class CheckoutApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly details?: unknown,
  ) {
    super(`checkout api error ${status}: ${code}`);
  }
}

async function parseErrorAndThrow(res: Response): Promise<never> {
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    body = undefined;
  }
  if (isErrorBody(body) && typeof body.error === 'string') {
    throw new CheckoutApiError(res.status, body.error, body.details);
  }
  throw new CheckoutApiError(res.status, 'UNKNOWN', text);
}

export async function fetchShippingQuote(
  departamentoCode: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ShippingQuoteLine[]> {
  const res = await fetchImpl(
    `/api/checkout/shipping-quote?departamento=${encodeURIComponent(departamentoCode)}`,
    {
      method: 'GET',
      credentials: 'include',
    },
  );
  if (!res.ok) return parseErrorAndThrow(res);
  return (await res.json()) as ShippingQuoteLine[];
}

export async function submitCheckout(
  input: CheckoutSubmitInput,
  fetchImpl: typeof fetch = fetch,
): Promise<CheckoutResult> {
  const res = await fetchImpl('/api/checkout', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
    credentials: 'include',
  });
  if (!res.ok) return parseErrorAndThrow(res);
  return (await res.json()) as CheckoutResult;
}
