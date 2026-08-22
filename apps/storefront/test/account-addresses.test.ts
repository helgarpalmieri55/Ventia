import { describe, expect, it } from 'vitest';
import { DEPARTAMENTOS, municipiosFor } from '@ventia/core';
import type { CheckoutAddress, SavedAddress } from '../lib/account-api';
import type { CheckoutFormState } from '../lib/checkout-form';
import {
  addressCardTitle,
  addressFormToInput,
  addressLines,
  addressToForm,
  applyAddressPrefill,
  departamentoName,
  EMPTY_ADDRESS_FORM,
  validateAddressForm,
  type AddressFormState,
} from '../lib/account-addresses';

const ANTIOQUIA = DEPARTAMENTOS.find((d) => d.code === '05')!;
const MEDELLIN = municipiosFor(ANTIOQUIA.code)[0]!.name;
const VALLE = DEPARTAMENTOS.find((d) => d.code === '76')!;
const CALI = municipiosFor(VALLE.code)[0]!.name;

function validForm(overrides: Partial<AddressFormState> = {}): AddressFormState {
  return {
    ...EMPTY_ADDRESS_FORM,
    label: 'Casa',
    nombreCompleto: 'Ana María Gómez',
    telefono: '3001234567',
    departamentoCode: ANTIOQUIA.code,
    municipioName: MEDELLIN,
    direccion: 'Calle 10 # 20-30',
    ...overrides,
  };
}

function saved(overrides: Partial<SavedAddress> = {}, address: Partial<CheckoutAddress> = {}): SavedAddress {
  return {
    id: 'a1',
    label: 'Casa',
    isDefault: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    address: {
      nombreCompleto: 'Ana María Gómez',
      telefono: '3001234567',
      departamentoCode: ANTIOQUIA.code,
      municipioName: MEDELLIN,
      direccion: 'Calle 10 # 20-30',
      ...address,
    },
    ...overrides,
  };
}

function emptyCheckout(overrides: Partial<CheckoutFormState> = {}): CheckoutFormState {
  return {
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
    acceptedPrivacyPolicy: false,
    ...overrides,
  };
}

describe('validateAddressForm', () => {
  it('accepts a complete Colombian address', () => {
    expect(validateAddressForm(validForm())).toEqual({});
  });

  it('accepts an address with no label — most people have one address and naming it is a chore', () => {
    expect(validateAddressForm(validForm({ label: '' }))).toEqual({});
  });

  it('rejects a municipio that belongs to another departamento', () => {
    // The one cross-field rule in the whole feature, and the one whose
    // failure mode is a parcel sent to the wrong city rather than a 400.
    const errors = validateAddressForm(validForm({ departamentoCode: ANTIOQUIA.code, municipioName: CALI }));
    expect(errors.municipioName).toBe('El municipio no pertenece al departamento seleccionado.');
  });

  it('accepts the same municipio once its own departamento is selected', () => {
    expect(validateAddressForm(validForm({ departamentoCode: VALLE.code, municipioName: CALI }))).toEqual({});
  });

  it('flags a missing departamento and a missing municipio separately', () => {
    const errors = validateAddressForm(validForm({ departamentoCode: '', municipioName: '' }));
    expect(errors.departamentoCode).toBeDefined();
    expect(errors.municipioName).toBe('Selecciona un municipio.');
  });

  it('rejects a departamento code that is not in the reference data', () => {
    expect(validateAddressForm(validForm({ departamentoCode: '00' })).departamentoCode).toBeDefined();
  });

  it('requires a recipient name of at least 2 characters, matching the server schema', () => {
    expect(validateAddressForm(validForm({ nombreCompleto: 'A' })).nombreCompleto).toBeDefined();
    expect(validateAddressForm(validForm({ nombreCompleto: 'Ab' })).nombreCompleto).toBeUndefined();
  });

  it('counts the name after trimming, so spaces cannot stand in for a name', () => {
    expect(validateAddressForm(validForm({ nombreCompleto: '   ' })).nombreCompleto).toBeDefined();
  });

  it('requires a phone of at least 7 characters and at most 20', () => {
    expect(validateAddressForm(validForm({ telefono: '300123' })).telefono).toBeDefined();
    expect(validateAddressForm(validForm({ telefono: '3001234' })).telefono).toBeUndefined();
    expect(validateAddressForm(validForm({ telefono: '3'.repeat(21) })).telefono).toBeDefined();
  });

  it('requires a street of at least 3 characters and at most 200', () => {
    expect(validateAddressForm(validForm({ direccion: 'Cl' })).direccion).toBeDefined();
    expect(validateAddressForm(validForm({ direccion: 'Cl1' })).direccion).toBeUndefined();
    expect(validateAddressForm(validForm({ direccion: 'x'.repeat(201) })).direccion).toBeDefined();
  });

  it('bounds the optional fields at the same lengths the server does', () => {
    expect(validateAddressForm(validForm({ label: 'x'.repeat(61) })).label).toBeDefined();
    expect(validateAddressForm(validForm({ label: 'x'.repeat(60) })).label).toBeUndefined();
    expect(validateAddressForm(validForm({ complemento: 'x'.repeat(101) })).complemento).toBeDefined();
    expect(validateAddressForm(validForm({ barrio: 'x'.repeat(101) })).barrio).toBeDefined();
    expect(validateAddressForm(validForm({ notas: 'x'.repeat(501) })).notas).toBeDefined();
    expect(validateAddressForm(validForm({ notas: 'x'.repeat(500) })).notas).toBeUndefined();
  });

  it('reports every problem at once rather than one at a time', () => {
    const errors = validateAddressForm({ ...EMPTY_ADDRESS_FORM });
    expect(Object.keys(errors).sort()).toEqual(
      ['departamentoCode', 'direccion', 'municipioName', 'nombreCompleto', 'telefono'].sort(),
    );
  });
});

describe('addressFormToInput', () => {
  it('trims the required fields', () => {
    const input = addressFormToInput(validForm({ nombreCompleto: '  Ana  ', direccion: '  Calle 1  ' }));
    expect(input.nombreCompleto).toBe('Ana');
    expect(input.direccion).toBe('Calle 1');
  });

  it('drops blank optionals to undefined rather than sending empty strings', () => {
    // `checkoutAddressSchema` types these `.optional()`; an empty string is a
    // value the server stores and later prints as a blank line on a label.
    const input = addressFormToInput(validForm({ complemento: '', barrio: '   ', notas: '' }));
    expect(input.complemento).toBeUndefined();
    expect(input.barrio).toBeUndefined();
    expect(input.notas).toBeUndefined();
  });

  it('keeps optionals the shopper actually filled in, trimmed', () => {
    const input = addressFormToInput(validForm({ complemento: ' Apto 301 ', barrio: 'Laureles' }));
    expect(input.complemento).toBe('Apto 301');
    expect(input.barrio).toBe('Laureles');
  });

  it('never carries the label into the address — it is not part of what the carrier sees', () => {
    expect(Object.keys(addressFormToInput(validForm()))).not.toContain('label');
  });

  it('round-trips through addressToForm without losing an optional field', () => {
    const original = validForm({ complemento: 'Apto 301', barrio: 'Laureles', notas: 'Dejar en portería' });
    const back = addressToForm({ ...saved(), label: original.label, address: addressFormToInput(original) });
    expect(back.complemento).toBe('Apto 301');
    expect(back.barrio).toBe('Laureles');
    expect(back.notas).toBe('Dejar en portería');
    expect(back.direccion).toBe(original.direccion);
  });
});

describe('addressToForm', () => {
  it('turns absent optionals into empty strings so the inputs stay controlled', () => {
    const form = addressToForm(saved({ label: null }));
    expect(form.label).toBe('');
    expect(form.complemento).toBe('');
    expect(form.barrio).toBe('');
    expect(form.notas).toBe('');
  });

  it('carries the default flag through, so editing the default does not silently demote it', () => {
    expect(addressToForm(saved({ isDefault: true })).isDefault).toBe(true);
    expect(addressToForm(saved({ isDefault: false })).isDefault).toBe(false);
  });
});

describe('addressLines / addressCardTitle / departamentoName', () => {
  it('reads street, then complemento and barrio, then municipio and departamento', () => {
    const lines = addressLines({ ...saved().address, complemento: 'Apto 301', barrio: 'Laureles' });
    expect(lines[0]).toBe('Calle 10 # 20-30');
    expect(lines[1]).toBe('Apto 301 · Laureles');
    expect(lines[2]).toBe(`${MEDELLIN}, ${ANTIOQUIA.name}`);
  });

  it('drops the second line entirely when there is no complemento or barrio', () => {
    const lines = addressLines(saved().address);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe(`${MEDELLIN}, ${ANTIOQUIA.name}`);
  });

  it('shows only the one optional that is present, with no stray separator', () => {
    expect(addressLines({ ...saved().address, barrio: 'Laureles' })[1]).toBe('Laureles');
    expect(addressLines({ ...saved().address, complemento: 'Apto 301' })[1]).toBe('Apto 301');
  });

  it('falls back to the raw code for a departamento this build does not know', () => {
    // `'00'` is not a DANE code; `'99'` is Vichada, so it would NOT be a
    // fallback case. A saved address holds the code, and a build whose
    // reference data has since dropped one must still show the shopper
    // something rather than a blank line.
    expect(DEPARTAMENTOS.some((d) => d.code === '00')).toBe(false);
    expect(departamentoName('00')).toBe('00');
    expect(departamentoName(ANTIOQUIA.code)).toBe(ANTIOQUIA.name);
  });

  it('titles a card with the shopper label, falling back to the street rather than a generic name', () => {
    expect(addressCardTitle(saved({ label: 'Oficina' }))).toBe('Oficina');
    expect(addressCardTitle(saved({ label: null }))).toBe('Calle 10 # 20-30');
    expect(addressCardTitle(saved({ label: '   ' }))).toBe('Calle 10 # 20-30');
  });
});

describe('applyAddressPrefill', () => {
  it('fills an empty checkout form from the saved address', () => {
    const next = applyAddressPrefill(emptyCheckout(), saved({}, { complemento: 'Apto 301', barrio: 'Laureles', notas: 'Portería' }));
    expect(next.nombreCompleto).toBe('Ana María Gómez');
    expect(next.phone).toBe('3001234567');
    expect(next.departamentoCode).toBe(ANTIOQUIA.code);
    expect(next.municipioName).toBe(MEDELLIN);
    expect(next.direccion).toBe('Calle 10 # 20-30');
    expect(next.complemento).toBe('Apto 301');
    expect(next.barrio).toBe('Laureles');
    expect(next.notas).toBe('Portería');
  });

  it('never overwrites a field the shopper already typed', () => {
    // The whole point: a shopper with a saved home address may be sending
    // THIS order to their office, and must not watch it revert.
    const typed = emptyCheckout({ direccion: 'Carrera 7 # 1-1', nombreCompleto: 'Otra Persona', phone: '3009999999' });
    const next = applyAddressPrefill(typed, saved());
    expect(next.direccion).toBe('Carrera 7 # 1-1');
    expect(next.nombreCompleto).toBe('Otra Persona');
    expect(next.phone).toBe('3009999999');
  });

  it('leaves the email alone — it is not part of the address', () => {
    const next = applyAddressPrefill(emptyCheckout({ email: 'guest@example.com' }), saved());
    expect(next.email).toBe('guest@example.com');
  });

  it('does not touch departamento or municipio once a departamento is chosen', () => {
    // Filling a municipio into a departamento the shopper picked themselves
    // is exactly the mismatched pairing the address schema exists to reject.
    const chosen = emptyCheckout({ departamentoCode: VALLE.code, municipioName: '' });
    const next = applyAddressPrefill(chosen, saved());
    expect(next.departamentoCode).toBe(VALLE.code);
    expect(next.municipioName).toBe('');
  });

  it('fills departamento and municipio together, never one without the other', () => {
    const next = applyAddressPrefill(emptyCheckout(), saved());
    expect(next.departamentoCode).toBe(ANTIOQUIA.code);
    expect(next.municipioName).toBe(MEDELLIN);
    // And the pairing it produced is one the address schema accepts.
    expect(municipiosFor(next.departamentoCode).some((m) => m.name === next.municipioName)).toBe(true);
  });

  it('leaves absent optionals empty rather than writing "undefined" into the form', () => {
    const next = applyAddressPrefill(emptyCheckout(), saved());
    expect(next.complemento).toBe('');
    expect(next.barrio).toBe('');
    expect(next.notas).toBe('');
  });

  it('never touches the shipping method, payment method or the privacy consent', () => {
    // The consent must be an act of the shopper's; a pre-fill that ticked it
    // would produce a record of an authorization that never happened.
    const next = applyAddressPrefill(emptyCheckout(), saved());
    expect(next.shippingMethodId).toBe('');
    expect(next.paymentMethod).toBe('');
    expect(next.acceptedPrivacyPolicy).toBe(false);
  });

  it('returns the SAME object when there is nothing left to fill', () => {
    // Identity matters: this runs inside setState, and a fresh object every
    // time would re-render checkout on every pass.
    const full = emptyCheckout({
      phone: '3',
      nombreCompleto: 'x',
      direccion: 'y',
      complemento: 'c',
      barrio: 'b',
      notas: 'n',
      departamentoCode: VALLE.code,
      municipioName: CALI,
    });
    expect(applyAddressPrefill(full, saved())).toBe(full);
  });
});
