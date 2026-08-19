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
  // Widened for P3b (Task 6) to include 'mercadopago'/'epayco' — see
  // `checkout-form.ts`'s identical widening for why this stays a local,
  // hand-rolled union rather than importing `PaymentProviderId` from
  // `@ventia/payments`.
  paymentMethod: 'cod' | 'wompi' | 'mercadopago' | 'epayco';
  /**
   * The shopper's Ley 1581 art. 9 authorization, ticked at checkout.
   *
   * A bare boolean, and deliberately nothing more: the server records WHEN it
   * was given (its own clock) and WHICH published policy text was in force
   * (a fingerprint it computes itself — see
   * services/api/src/checkout/privacy-consent.ts). Evidence supplied by the
   * party whose consent is being evidenced is not evidence, so this client
   * has nothing else to say about it.
   *
   * Required, not optional: the API 400s a checkout body without it, and a
   * type that let a caller omit it would push that failure to runtime.
   */
  acceptedPrivacyPolicy: boolean;
}

export interface CheckoutResult {
  orderNumber: number;
  totalCents: number;
  // Only present for an online-provider checkout (`wompi`/`mercadopago`/
  // `epayco`) — see checkout.service.ts's `CheckoutResult` for the full
  // contract. Absent entirely for `cod`. For `epayco` specifically, this
  // points at THIS storefront's own `/pago/epayco` bridge page rather than
  // an epayco.co URL directly (design doc decision 6) — the calling page
  // doesn't need to know or care about that distinction, since
  // `window.location.href = redirectUrl` works identically for a
  // same-origin or cross-origin URL.
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

/** Records a gateway transaction id against an order as a RECONCILIATION
 * HINT (P3c Task 2) — `PATCH /v1/storefront/checkout/:orderNumber/provider-ref-hint`
 * via this app's own `/api/checkout/*` proxy.
 *
 * Called from the Wompi return page (`/pago/wompi-retorno/[orderNumber]`)
 * with the `?id=` Wompi appends to its redirect. The value is a HINT only —
 * never proof of payment — and the API endpoint it hits writes
 * `Order.providerRef` and nothing else. See that endpoint's doc comment in
 * `services/api/src/checkout/checkout.controller.ts` for why it's safe for
 * this call to be unauthenticated.
 *
 * Throws `CheckoutApiError` on a non-2xx like every other client here: this
 * module stays honest about failures, and it's the CALLER's job to make the
 * call non-blocking (the return page fires it without awaiting, with its own
 * `.catch()`, so a slow or failing hint can never delay the shopper's
 * redirect). Deliberately NOT swallowing errors in here: a silent-by-default
 * client would make a genuinely broken hint path invisible in the console. */
export async function sendProviderRefHint(
  orderNumber: string,
  providerRef: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const res = await fetchImpl(`/api/checkout/${encodeURIComponent(orderNumber)}/provider-ref-hint`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ providerRef }),
    credentials: 'include',
  });
  if (!res.ok) return parseErrorAndThrow(res);
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
