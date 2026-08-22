/**
 * The pure half of the saved-address screens: form state, validation,
 * display formatting, and the checkout pre-fill rule.
 *
 * Split out of the components for the same reason `checkout-form.ts` and
 * `account-form.ts` are — this app's vitest runs under Node with no DOM, so
 * anything worth testing has to live in `lib/`. That is not a testing
 * convenience here: the two rules below (a municipio must belong to its
 * departamento; pre-fill must never overwrite) are the only places in this
 * feature where being wrong sends a parcel to the wrong address.
 */

import { DEPARTAMENTOS, municipiosFor } from '@ventia/core';
import type { CheckoutAddress, SavedAddress } from './account-api';
import type { CheckoutFormState } from './checkout-form';

/**
 * The saved-address form.
 *
 * Every field is a `string`, including the ones the API takes as optional —
 * a controlled `<input>` cannot hold `undefined` without React warning about
 * a component switching between controlled and uncontrolled, and the
 * blank-to-`undefined` conversion happens once, in `addressFormToInput`,
 * rather than at each field.
 *
 * `label` is the shopper's own name for it ("Casa", "Oficina"); it is NOT
 * part of the address the carrier sees, which is why it lives here alongside
 * the address rather than inside it.
 */
export interface AddressFormState {
  label: string;
  nombreCompleto: string;
  telefono: string;
  departamentoCode: string;
  municipioName: string;
  direccion: string;
  complemento: string;
  barrio: string;
  notas: string;
  isDefault: boolean;
}

export const EMPTY_ADDRESS_FORM: AddressFormState = {
  label: '',
  nombreCompleto: '',
  telefono: '',
  departamentoCode: '',
  municipioName: '',
  direccion: '',
  complemento: '',
  barrio: '',
  notas: '',
  isDefault: false,
};

/** Field ids in top-to-bottom form order, for scrolling to the first invalid
 * one — same purely cosmetic ordering as checkout's `FIELD_ORDER`. */
export const ADDRESS_FIELD_ORDER = [
  'label',
  'nombreCompleto',
  'telefono',
  'departamentoCode',
  'municipioName',
  'direccion',
  'complemento',
  'barrio',
  'notas',
] as const;

/**
 * Fills the form from a saved address, for the edit screen.
 *
 * The optional fields come back as `undefined` from the API and become `''`
 * here — the inverse of `addressFormToInput`, and the pair has to round-trip
 * exactly or editing an address would quietly drop whichever optional field
 * the shopper had filled in.
 */
export function addressToForm(saved: SavedAddress): AddressFormState {
  const a = saved.address;
  return {
    label: saved.label ?? '',
    nombreCompleto: a.nombreCompleto,
    telefono: a.telefono,
    departamentoCode: a.departamentoCode,
    municipioName: a.municipioName,
    direccion: a.direccion,
    complemento: a.complemento ?? '',
    barrio: a.barrio ?? '',
    notas: a.notas ?? '',
    isDefault: saved.isDefault,
  };
}

/**
 * The API payload for a form.
 *
 * Trims everything and drops blank optionals to `undefined` rather than
 * sending `''`: `checkoutAddressSchema` types them as `.optional()`, so an
 * empty string is a value the server would store and later print on a label
 * as an empty line, while an absent key is the honest "there is no
 * complemento".
 */
export function addressFormToInput(form: AddressFormState): CheckoutAddress {
  const optional = (value: string): string | undefined => {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  };
  return {
    nombreCompleto: form.nombreCompleto.trim(),
    telefono: form.telefono.trim(),
    departamentoCode: form.departamentoCode,
    municipioName: form.municipioName,
    direccion: form.direccion.trim(),
    complemento: optional(form.complemento),
    barrio: optional(form.barrio),
    notas: optional(form.notas),
  };
}

/**
 * Mirrors `checkoutAddressSchema`'s constraints for the shopper's benefit —
 * UX only, never the gate. The server validates the same values and is the
 * real arbiter; this exists so someone can see what is wrong while looking at
 * the field, instead of after a round trip.
 *
 * The one rule here that is not a length check is the municipio/departamento
 * pairing, and it is the reason this function is tested directly: a municipio
 * that does not belong to its departamento is a 400 from the server and an
 * undeliverable parcel if it ever got past one.
 */
export function validateAddressForm(form: AddressFormState): Record<string, string> {
  const errors: Record<string, string> = {};

  if (form.label.trim().length > 60) errors.label = 'Usa máximo 60 caracteres.';

  const nombre = form.nombreCompleto.trim();
  if (nombre.length < 2) errors.nombreCompleto = 'Ingresa el nombre de quien recibe.';
  else if (nombre.length > 120) errors.nombreCompleto = 'Usa máximo 120 caracteres.';

  const telefono = form.telefono.trim();
  if (telefono.length < 7) errors.telefono = 'Ingresa un teléfono válido.';
  else if (telefono.length > 20) errors.telefono = 'Usa máximo 20 caracteres.';

  if (!form.departamentoCode || !DEPARTAMENTOS.some((d) => d.code === form.departamentoCode)) {
    errors.departamentoCode = 'Selecciona un departamento.';
  }

  if (!form.municipioName) {
    errors.municipioName = 'Selecciona un municipio.';
  } else if (
    form.departamentoCode &&
    !municipiosFor(form.departamentoCode).some((m) => m.name === form.municipioName)
  ) {
    errors.municipioName = 'El municipio no pertenece al departamento seleccionado.';
  }

  const direccion = form.direccion.trim();
  if (direccion.length < 3) errors.direccion = 'Ingresa una dirección válida.';
  else if (direccion.length > 200) errors.direccion = 'Usa máximo 200 caracteres.';

  if (form.complemento.trim().length > 100) errors.complemento = 'Usa máximo 100 caracteres.';
  if (form.barrio.trim().length > 100) errors.barrio = 'Usa máximo 100 caracteres.';
  if (form.notas.trim().length > 500) errors.notas = 'Usa máximo 500 caracteres.';

  return errors;
}

/** Departamento display name for a code, falling back to the code itself.
 * A saved address holds the CODE, and a build whose reference data has since
 * dropped a code should still show the shopper something recognisable rather
 * than a blank line where their department used to be. */
export function departamentoName(code: string): string {
  return DEPARTAMENTOS.find((d) => d.code === code)?.name ?? code;
}

/**
 * The address as lines to print in a card, in the order a Colombian address
 * is read: street, then complemento/barrio, then municipio, departamento.
 *
 * Blank optionals are dropped rather than rendered as empty lines. The
 * recipient's name and phone are NOT here — the card shows them separately,
 * because "who receives it" is a different question from "where".
 */
export function addressLines(address: CheckoutAddress): string[] {
  const lines: string[] = [address.direccion];
  const second = [address.complemento, address.barrio].filter((v) => v && v.trim().length > 0);
  if (second.length > 0) lines.push(second.join(' · '));
  lines.push(`${address.municipioName}, ${departamentoName(address.departamentoCode)}`);
  return lines;
}

/** What to show as the heading of a saved-address card. The shopper's own
 * label when they gave one; otherwise the street, which is what actually
 * distinguishes two addresses — never a generic "Dirección 1", which
 * distinguishes nothing. */
export function addressCardTitle(saved: SavedAddress): string {
  const label = saved.label?.trim();
  return label && label.length > 0 ? label : saved.address.direccion;
}

/**
 * Applies a saved address to the checkout form.
 *
 * ## Only ever fills a field that is still EMPTY
 *
 * This is the same rule the existing account pre-fill on that page follows,
 * and it is not politeness. Overwriting what someone already typed would be
 * the checkout quietly changing the address an order ships to — a shopper
 * with a saved home address may be sending this particular order to their
 * office, and having typed that, must not watch it revert.
 *
 * ## Departamento and municipio move together or not at all
 *
 * A municipio is only meaningful paired with its departamento, and the
 * checkout page CLEARS the municipio whenever the departamento changes for
 * exactly that reason. So this fills the pair only when the departamento is
 * still unset; filling a municipio into a departamento the shopper already
 * chose could produce precisely the mismatched pairing that
 * `checkoutAddressSchema`'s cross-field refinement exists to reject.
 *
 * Returns the same object identity when nothing changed, so a caller can use
 * it inside `setState` without forcing a re-render on every run.
 */
export function applyAddressPrefill(
  form: CheckoutFormState,
  saved: SavedAddress,
): CheckoutFormState {
  const a = saved.address;
  const next: CheckoutFormState = { ...form };
  let changed = false;

  const fill = (key: 'phone' | 'nombreCompleto' | 'direccion' | 'complemento' | 'barrio' | 'notas', value: string | undefined) => {
    if (next[key] !== '' || !value) return;
    next[key] = value;
    changed = true;
  };

  // `telefono` from the address, into checkout's `phone`. They are the same
  // number in practice — the checkout submit sends `phone` as the address's
  // `telefono` — but they are separate FIELDS, and only one of them is on
  // the form.
  fill('phone', a.telefono);
  fill('nombreCompleto', a.nombreCompleto);
  fill('direccion', a.direccion);
  fill('complemento', a.complemento);
  fill('barrio', a.barrio);
  fill('notas', a.notas);

  if (next.departamentoCode === '') {
    next.departamentoCode = a.departamentoCode;
    next.municipioName = a.municipioName;
    changed = true;
  }

  return changed ? next : form;
}
