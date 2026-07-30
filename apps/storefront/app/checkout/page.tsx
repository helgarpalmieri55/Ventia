'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Alert, Button, Card, CardContent, CardHeader, CardTitle, FormField, Input, Select, Spinner } from '@ventia/ui';
import { DEPARTAMENTOS } from '@ventia/core';
import { useCart } from '../../lib/cart-context';
import { formatCOP } from '../../lib/format';
import { municipioOptionsFor, validateCheckoutStep, type CheckoutFormState } from '../../lib/checkout-form';
import {
  CheckoutApiError,
  fetchShippingQuote,
  submitCheckout,
  type ShippingQuoteLine,
} from '../../lib/checkout-api';

const EMPTY_FORM: CheckoutFormState = {
  email: '',
  phone: '',
  nombreCompleto: '',
  departamentoCode: '',
  municipioName: '',
  direccion: '',
  complemento: '',
  barrio: '',
  notas: '',
  shippingMethodId: '',
  paymentMethod: '',
};

const GENERIC_ERROR = 'Ocurrió un error al procesar tu pedido. Intenta de nuevo.';
const VALIDATION_BANNER = 'Revisa los campos marcados.';

/** Field-error keys in top-to-bottom form order, matching each field's
 * `htmlFor`/wrapper `id` (the shipping radiogroup's wrapping `div` carries
 * `id="shippingMethodId"` for exactly this purpose, since it has no single
 * `<input id>` of its own). Used only to pick which invalid field to scroll
 * to first — a purely cosmetic ordering, not a validation rule. */
const FIELD_ORDER = [
  'email',
  'phone',
  'nombreCompleto',
  'departamentoCode',
  'municipioName',
  'direccion',
  'complemento',
  'barrio',
  'notas',
  'shippingMethodId',
  'paymentMethod',
] as const;

/** Scrolls to and focuses the first invalid field (in top-to-bottom form
 * order) so a shopper who submits while scrolled down near the button sees
 * SOMETHING happen, rather than the page silently doing nothing while the
 * actual errors render off-screen above. */
function scrollToFirstError(errors: Record<string, string>) {
  const firstKey = FIELD_ORDER.find((key) => key in errors);
  if (!firstKey) return;
  const el = document.getElementById(firstKey);
  el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  if (el instanceof HTMLElement) el.focus({ preventScroll: true });
}

/** Extracts a `{field: message}` map from a `CheckoutApiError`'s `details`,
 * local equivalent of `apps/admin/lib/errors.ts`'s `fieldErrors` helper
 * (not imported — this is a separate app with no shared package for this,
 * per the task brief). Two shapes are merged here, matching
 * `checkout.controller.ts`'s `parseCheckoutBody`:
 * - top-level fields (`email`/`phone`/`shippingMethodId`/`paymentMethod`)
 *   are plain string messages directly on `details`;
 * - the nested `address` field is itself a zod `.flatten()` shape
 *   (`{formErrors, fieldErrors: {municipioName: [...], direccion: [...], ...}}`)
 *   since `checkoutAddressSchema` is validated as its own sub-schema — this
 *   is also where a bad municipio/departamento pairing surfaces
 *   (`fieldErrors.municipioName`), NOT as a distinct `INVALID_MUNICIPIO`
 *   code (see this task's report for the full discrepancy note vs. the task
 *   brief). */
function fieldErrorsFrom(details: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  if (!details || typeof details !== 'object') return result;
  const d = details as Record<string, unknown>;

  for (const key of ['email', 'phone', 'shippingMethodId', 'paymentMethod'] as const) {
    if (typeof d[key] === 'string') result[key] = d[key];
  }

  const address = d.address;
  if (address && typeof address === 'object') {
    const fieldErrors = (address as { fieldErrors?: Record<string, unknown> }).fieldErrors;
    if (fieldErrors) {
      for (const [field, messages] of Object.entries(fieldErrors)) {
        if (Array.isArray(messages) && typeof messages[0] === 'string') {
          result[field] = messages[0];
        }
      }
    }
  }
  return result;
}

/** es-CO display name for each online payment provider, used only to
 * personalize the `PAYMENT_PROVIDER_NOT_CONFIGURED` banner below — brand
 * proper nouns, not translated. */
const PROVIDER_LABELS: Record<string, string> = {
  wompi: 'Wompi',
  mercadopago: 'Mercado Pago',
  epayco: 'ePayco',
};

/** Maps a `CheckoutApiError`'s code to a top-of-page es-CO banner message.
 * `productName` (looked up from the current cart, when available) lets the
 * `INSUFFICIENT_STOCK` case name the specific product per the task brief,
 * rather than only a generic "something's out of stock". `paymentMethod` is
 * the method the shopper actually selected when the submit failed — needed
 * so `PAYMENT_PROVIDER_NOT_CONFIGURED` can name whichever of the three
 * online providers was chosen (Task 6 widened this from a Wompi-only
 * codebase to three online providers; this message must not keep saying
 * "Wompi" when a shopper picked Mercado Pago or ePayco). */
function bannerMessageFor(
  err: CheckoutApiError,
  productName: string | undefined,
  paymentMethod: string,
): string {
  switch (err.code) {
    case 'CART_EMPTY':
      return 'Tu carrito está vacío.';
    case 'INSUFFICIENT_STOCK':
      return productName
        ? `Ya no hay suficiente inventario de "${productName}". Ajusta la cantidad en tu carrito.`
        : 'Uno de los productos de tu carrito ya no tiene inventario suficiente.';
    case 'SHIPPING_METHOD_UNAVAILABLE':
      return 'El método de envío elegido ya no está disponible. Elige otro.';
    case 'PAYMENT_PROVIDER_NOT_CONFIGURED': {
      const providerLabel = PROVIDER_LABELS[paymentMethod];
      return providerLabel
        ? `${providerLabel} no está disponible en este momento para esta tienda. Elige otro método de pago.`
        : 'Este método de pago no está disponible en este momento. Elige otro.';
    }
    case 'VALIDATION_FAILED':
      return 'Revisa los campos marcados.';
    default:
      return GENERIC_ERROR;
  }
}

/** The storefront's first fully client-driven page (per the design's
 * "checkout essentials only" JS-scope note) — a sectioned single-page form
 * (contact / address / shipping / review), not a multi-step wizard with page
 * transitions: all sections render at once and client-side validation
 * (`validateCheckoutStep`) gates the single submit at the bottom rather than
 * gating navigation between "pages". This matches the brief's "sectioned
 * single-page form" phrasing more directly than a wizard would, and avoids
 * wizard-specific state (current step, back/next transitions) for what's
 * fundamentally one short form. */
export default function CheckoutPage() {
  const router = useRouter();
  const { cart, loading: cartLoading, clearCart } = useCart();

  const [form, setForm] = React.useState<CheckoutFormState>(EMPTY_FORM);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [quoteLines, setQuoteLines] = React.useState<ShippingQuoteLine[] | null>(null);
  const [quoteLoading, setQuoteLoading] = React.useState(false);
  const [quoteError, setQuoteError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const [bannerError, setBannerError] = React.useState<string | null>(null);

  function setField<K extends keyof CheckoutFormState>(key: K, value: CheckoutFormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  function handleDepartamentoChange(code: string) {
    // Changing departamento invalidates BOTH the previously selected
    // municipio (it belonged to the old departamento — leaving it selected
    // would silently reintroduce the exact bad municipio/departamento
    // pairing this form exists to prevent) and the previously selected
    // shipping method (shipping options are quoted per-departamento; the old
    // selection may not even appear in the new quote). Both are cleared
    // together here, in the same state update as the departamento change
    // itself, so there's never a render with a stale, now-invalid pairing.
    setForm((prev) => ({ ...prev, departamentoCode: code, municipioName: '', shippingMethodId: '' }));
    setErrors((prev) => {
      const next = { ...prev };
      delete next.departamentoCode;
      delete next.municipioName;
      delete next.shippingMethodId;
      return next;
    });
  }

  const municipioOptions = React.useMemo(
    () => (form.departamentoCode ? municipioOptionsFor(form.departamentoCode) : []),
    [form.departamentoCode],
  );

  React.useEffect(() => {
    if (!form.departamentoCode) {
      setQuoteLines(null);
      setQuoteError(null);
      return;
    }
    let cancelled = false;
    setQuoteLoading(true);
    setQuoteError(null);
    fetchShippingQuote(form.departamentoCode)
      .then((lines) => {
        if (cancelled) return;
        setQuoteLines(lines);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('[checkout] failed to fetch shipping quote', err);
        setQuoteLines([]);
        setQuoteError('No pudimos cargar los métodos de envío. Intenta de nuevo.');
      })
      .finally(() => {
        if (!cancelled) setQuoteLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [form.departamentoCode]);

  const selectedShippingLine = quoteLines?.find((l) => l.id === form.shippingMethodId) ?? null;
  const shippingCents = selectedShippingLine?.priceCents ?? 0;
  const subtotalCents = cart?.subtotalCents ?? 0;
  const taxCents = cart?.taxCents ?? 0;
  const grandTotalCents = subtotalCents + taxCents + shippingCents;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBannerError(null);

    const stepErrors = {
      ...validateCheckoutStep('contact', form),
      ...validateCheckoutStep('address', form),
      ...validateCheckoutStep('shipping', form),
      ...validateCheckoutStep('payment', form),
    };
    if (Object.keys(stepErrors).length > 0) {
      setErrors(stepErrors);
      setBannerError(VALIDATION_BANNER);
      scrollToFirstError(stepErrors);
      return;
    }

    setSubmitting(true);
    try {
      const result = await submitCheckout({
        email: form.email.trim(),
        phone: form.phone.trim(),
        address: {
          nombreCompleto: form.nombreCompleto.trim(),
          telefono: form.phone.trim(),
          departamentoCode: form.departamentoCode,
          municipioName: form.municipioName,
          direccion: form.direccion.trim(),
          complemento: form.complemento.trim() || undefined,
          barrio: form.barrio.trim() || undefined,
          notas: form.notas.trim() || undefined,
        },
        shippingMethodId: form.shippingMethodId,
        // Safe cast: validateCheckoutStep('payment', ...) above already
        // guarantees form.paymentMethod is non-empty by the time this runs
        // (same pattern as shippingMethodId, a plain `string` here relied on
        // having already been validated non-empty). Widened for Task 6 to
        // the full online-provider union.
        paymentMethod: form.paymentMethod as 'cod' | 'wompi' | 'mercadopago' | 'epayco',
      });
      if (result.redirectUrl) {
        // Any online-provider checkout (`wompi`/`mercadopago`/`epayco`): the
        // order exists but payment isn't confirmed yet (each provider's
        // webhook confirms it asynchronously later), so the cart is NOT
        // cleared here — this browser is about to navigate away to the
        // provider's hosted checkout (Wompi/Mercado Pago directly, or
        // ePayco's own same-origin `/pago/epayco` bridge page, which itself
        // then hands off to ePayco's widget), and clearing first would only
        // risk a flash of an "empty cart" state if that navigation were ever
        // interrupted before it actually leaves this page. `window.location
        // .href` works identically whether `redirectUrl` is same-origin
        // (epayco's bridge page) or cross-origin (wompi/mercadopago's
        // hosted checkouts) — no special-casing needed here.
        window.location.href = result.redirectUrl;
      } else {
        clearCart();
        router.push(`/checkout/confirmacion/${result.orderNumber}`);
      }
    } catch (err) {
      if (err instanceof CheckoutApiError) {
        setErrors((prev) => ({ ...prev, ...fieldErrorsFrom(err.details) }));
        const details = err.details as { productId?: string } | undefined;
        const productName = cart?.lines.find((l) => l.productId === details?.productId)?.name;
        setBannerError(bannerMessageFor(err, productName, form.paymentMethod));
      } else {
        console.error('[checkout] submit failed', err);
        setBannerError(GENERIC_ERROR);
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (cartLoading && !cart) {
    return (
      <main className="mx-auto max-w-2xl px-4 py-8">
        <p className="text-sm text-muted-foreground">Cargando…</p>
      </main>
    );
  }

  if (!cart || cart.lines.length === 0) {
    return (
      <main className="mx-auto max-w-2xl px-4 py-8">
        <h1 className="mb-4 text-2xl font-semibold">Pagar</h1>
        <p className="text-sm text-muted-foreground">
          Tu carrito está vacío, así que no hay nada que pagar todavía.
        </p>
        <Button href="/carrito" className="mt-4">
          Volver al carrito
        </Button>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-2xl px-4 py-8">
      <h1 className="mb-6 text-2xl font-semibold">Pagar</h1>

      {bannerError ? (
        <Alert variant="error" className="mb-6">
          {bannerError}
          {bannerError === 'Tu carrito está vacío.' ? (
            <>
              {' '}
              <a href="/carrito" className="underline">
                Ir al carrito
              </a>
            </>
          ) : null}
        </Alert>
      ) : null}

      <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Contacto</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <FormField label="Correo electrónico" htmlFor="email" error={errors.email}>
              <Input
                type="email"
                value={form.email}
                onChange={(e) => setField('email', e.target.value)}
                autoComplete="email"
              />
            </FormField>
            <FormField label="Teléfono" htmlFor="phone" error={errors.phone}>
              <Input
                type="tel"
                value={form.phone}
                onChange={(e) => setField('phone', e.target.value)}
                autoComplete="tel"
              />
            </FormField>
            <FormField label="Nombre completo" htmlFor="nombreCompleto" error={errors.nombreCompleto}>
              <Input
                value={form.nombreCompleto}
                onChange={(e) => setField('nombreCompleto', e.target.value)}
                autoComplete="name"
              />
            </FormField>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Dirección de envío</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <FormField label="Departamento" htmlFor="departamentoCode" error={errors.departamentoCode}>
              <Select
                value={form.departamentoCode}
                onChange={(e) => handleDepartamentoChange(e.target.value)}
              >
                <option value="" disabled>
                  Selecciona un departamento
                </option>
                {DEPARTAMENTOS.map((d) => (
                  <option key={d.code} value={d.code}>
                    {d.name}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField label="Municipio" htmlFor="municipioName" error={errors.municipioName}>
              <Select
                value={form.municipioName}
                onChange={(e) => setField('municipioName', e.target.value)}
                disabled={!form.departamentoCode}
              >
                <option value="" disabled>
                  {form.departamentoCode ? 'Selecciona un municipio' : 'Elige primero un departamento'}
                </option>
                {municipioOptions.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField label="Dirección" htmlFor="direccion" error={errors.direccion}>
              <Input value={form.direccion} onChange={(e) => setField('direccion', e.target.value)} />
            </FormField>
            <FormField label="Complemento (opcional)" htmlFor="complemento" error={errors.complemento}>
              <Input value={form.complemento} onChange={(e) => setField('complemento', e.target.value)} />
            </FormField>
            <FormField label="Barrio (opcional)" htmlFor="barrio" error={errors.barrio}>
              <Input value={form.barrio} onChange={(e) => setField('barrio', e.target.value)} />
            </FormField>
            <FormField label="Notas para la entrega (opcional)" htmlFor="notas" error={errors.notas}>
              <Input value={form.notas} onChange={(e) => setField('notas', e.target.value)} />
            </FormField>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Envío</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {!form.departamentoCode ? (
              <p className="text-sm text-muted-foreground">
                Selecciona un departamento para ver los métodos de envío disponibles.
              </p>
            ) : quoteLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Spinner /> Buscando métodos de envío…
              </div>
            ) : quoteError ? (
              <p className="text-sm text-destructive">{quoteError}</p>
            ) : !quoteLines || quoteLines.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No hay métodos de envío disponibles para este departamento.
              </p>
            ) : (
              <div id="shippingMethodId" role="radiogroup" aria-label="Método de envío" className="flex flex-col gap-2">
                {quoteLines.map((line) => (
                  <label
                    key={line.id}
                    className="flex items-center justify-between gap-2 rounded-md border border-border p-3 text-sm"
                  >
                    <span className="flex items-center gap-2">
                      <input
                        type="radio"
                        name="shippingMethodId"
                        value={line.id}
                        checked={form.shippingMethodId === line.id}
                        onChange={() => setField('shippingMethodId', line.id)}
                      />
                      {line.label}
                    </span>
                    <span>{formatCOP(line.priceCents)}</span>
                  </label>
                ))}
              </div>
            )}
            {errors.shippingMethodId ? (
              <p className="text-sm text-destructive" role="alert">
                {errors.shippingMethodId}
              </p>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Pago</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div id="paymentMethod" role="radiogroup" aria-label="Método de pago" className="flex flex-col gap-2">
              <label className="flex items-center gap-2 rounded-md border border-border p-3 text-sm">
                <input
                  type="radio"
                  name="paymentMethod"
                  value="cod"
                  checked={form.paymentMethod === 'cod'}
                  onChange={() => setField('paymentMethod', 'cod')}
                />
                Contra entrega
              </label>
              <label className="flex items-center gap-2 rounded-md border border-border p-3 text-sm">
                <input
                  type="radio"
                  name="paymentMethod"
                  value="wompi"
                  checked={form.paymentMethod === 'wompi'}
                  onChange={() => setField('paymentMethod', 'wompi')}
                />
                Wompi (tarjeta, PSE, Nequi, Bancolombia)
              </label>
              <label className="flex items-center gap-2 rounded-md border border-border p-3 text-sm">
                <input
                  type="radio"
                  name="paymentMethod"
                  value="mercadopago"
                  checked={form.paymentMethod === 'mercadopago'}
                  onChange={() => setField('paymentMethod', 'mercadopago')}
                />
                Mercado Pago
              </label>
              <label className="flex items-center gap-2 rounded-md border border-border p-3 text-sm">
                <input
                  type="radio"
                  name="paymentMethod"
                  value="epayco"
                  checked={form.paymentMethod === 'epayco'}
                  onChange={() => setField('paymentMethod', 'epayco')}
                />
                ePayco
              </label>
            </div>
            {errors.paymentMethod ? (
              <p className="text-sm text-destructive" role="alert">
                {errors.paymentMethod}
              </p>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Resumen</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <ul className="flex flex-col gap-2 text-sm">
              {cart.lines.map((line) => (
                <li key={line.id} className="flex justify-between">
                  <span>
                    {line.name} × {line.qty}
                  </span>
                  <span>{formatCOP(line.lineSubtotalCents)}</span>
                </li>
              ))}
            </ul>
            <div className="flex flex-col gap-1 border-t border-border pt-3 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Subtotal</span>
                <span>{formatCOP(subtotalCents)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Impuestos</span>
                <span>{formatCOP(taxCents)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Envío</span>
                <span>{selectedShippingLine ? formatCOP(shippingCents) : '—'}</span>
              </div>
              <div className="flex justify-between text-base font-semibold">
                <span>Total</span>
                <span>{formatCOP(grandTotalCents)}</span>
              </div>
            </div>
          </CardContent>
        </Card>

        <Button type="submit" disabled={submitting} className="self-end">
          {submitting ? (
            <>
              <Spinner /> Confirmando pedido…
            </>
          ) : (
            'Confirmar pedido'
          )}
        </Button>
      </form>
    </main>
  );
}
