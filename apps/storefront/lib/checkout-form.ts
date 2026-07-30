/** Pure, unit-tested helpers backing `app/checkout/page.tsx`'s form state —
 * unlike most page-local logic in this app, this one is genuinely non-trivial
 * (cross-field municipio/departamento validation, per-step field scoping),
 * so it's split out and tested directly rather than only exercised through
 * the page.
 */

import { DEPARTAMENTOS, municipiosFor } from '@ventia/core';

export interface CheckoutFormState {
  email: string;
  phone: string;
  nombreCompleto: string;
  departamentoCode: string;
  municipioName: string;
  direccion: string;
  complemento: string;
  barrio: string;
  notas: string;
  shippingMethodId: string;
  // Widened for P3b (Task 6): 'mercadopago'/'epayco' join 'wompi' as the
  // online-payment options, matching `services/api/src/checkout/
  // checkout.service.ts`'s `'cod' | PaymentProviderId` union. Kept as a
  // plain hand-rolled literal union here rather than importing
  // `PaymentProviderId` from `@ventia/payments` — this app has no existing
  // dependency on that package, and this codebase's established convention
  // (see e.g. this file's own header comment, `checkout-api.ts`'s
  // `CheckoutSubmitInput`, and the order-confirmation page's local
  // `OrderConfirmationDto`) is to keep storefront-local types hand-rolled
  // rather than share DTOs with the API/packages layer.
  paymentMethod: 'cod' | 'wompi' | 'mercadopago' | 'epayco' | '';
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Wraps `@ventia/core`'s `municipiosFor` as `{value, label}` options for a
 * `<select>` — `value`/`label` are the same municipio `name` (there's no
 * separate stable id per municipio in the reference data, and the server's
 * `checkoutAddressSchema` matches on `name` directly). Returns `[]` for an
 * unknown/empty departamento code (matches `municipiosFor`'s own behavior —
 * a `.filter()` that simply finds nothing). */
export function municipioOptionsFor(departamentoCode: string): { value: string; label: string }[] {
  return municipiosFor(departamentoCode).map((m) => ({ value: m.name, label: m.name }));
}

/** Mirrors (loosely — UX only, not the real gate) `@ventia/core`'s
 * `checkoutAddressSchema` constraints, scoped per wizard-section so a step's
 * validation never flags fields that belong to a later/earlier step. Returns
 * a `{field: message}` map; `{}` means every field relevant to this step is
 * valid. */
export function validateCheckoutStep(
  step: 'contact' | 'address' | 'shipping' | 'payment',
  state: CheckoutFormState,
): Record<string, string> {
  const errors: Record<string, string> = {};

  if (step === 'contact') {
    if (!EMAIL_RE.test(state.email.trim())) {
      errors.email = 'Ingresa un correo válido.';
    }
    if (state.phone.trim().length < 7) {
      errors.phone = 'Ingresa un teléfono válido.';
    }
    if (state.nombreCompleto.trim().length < 2) {
      errors.nombreCompleto = 'Ingresa tu nombre completo.';
    }
  }

  if (step === 'address') {
    if (!state.departamentoCode || !DEPARTAMENTOS.some((d) => d.code === state.departamentoCode)) {
      errors.departamentoCode = 'Selecciona un departamento.';
    }
    if (!state.municipioName) {
      errors.municipioName = 'Selecciona un municipio.';
    } else if (
      state.departamentoCode &&
      !municipiosFor(state.departamentoCode).some((m) => m.name === state.municipioName)
    ) {
      errors.municipioName = 'El municipio no pertenece al departamento seleccionado.';
    }
    if (state.direccion.trim().length < 3) {
      errors.direccion = 'Ingresa una dirección válida.';
    }
  }

  if (step === 'shipping') {
    if (!state.shippingMethodId) {
      errors.shippingMethodId = 'Selecciona un método de envío.';
    }
  }

  if (step === 'payment') {
    if (!state.paymentMethod) {
      errors.paymentMethod = 'Selecciona un método de pago.';
    }
  }

  return errors;
}
