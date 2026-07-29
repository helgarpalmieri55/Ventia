import { describe, expect, it } from 'vitest';
import { DEPARTAMENTOS, municipiosFor } from '@ventia/core';
import { municipioOptionsFor, validateCheckoutStep, type CheckoutFormState } from '../lib/checkout-form';

const VALID_DEPARTAMENTO = DEPARTAMENTOS.find((d) => d.code === '05')!; // Antioquia
const VALID_MUNICIPIO = municipiosFor(VALID_DEPARTAMENTO.code)[0]!.name; // Medellín
const OTHER_DEPARTAMENTO = DEPARTAMENTOS.find((d) => d.code === '76')!; // Valle del Cauca
const OTHER_MUNICIPIO = municipiosFor(OTHER_DEPARTAMENTO.code)[0]!.name; // Cali

function validState(overrides: Partial<CheckoutFormState> = {}): CheckoutFormState {
  return {
    email: 'shopper@example.com',
    phone: '3001234567',
    nombreCompleto: 'Ana María Gómez',
    departamentoCode: VALID_DEPARTAMENTO.code,
    municipioName: VALID_MUNICIPIO,
    direccion: 'Calle 10 # 20-30',
    complemento: '',
    barrio: '',
    notas: '',
    shippingMethodId: 'flat-1',
    paymentMethod: 'cod',
    ...overrides,
  };
}

describe('municipioOptionsFor', () => {
  it('returns entries only for the given departamento code', () => {
    const options = municipioOptionsFor(VALID_DEPARTAMENTO.code);
    const expected = municipiosFor(VALID_DEPARTAMENTO.code);
    expect(options).toHaveLength(expected.length);
    expect(options.every((o) => expected.some((m) => m.name === o.value))).toBe(true);
    // Spot-check it doesn't leak municipios from another departamento.
    expect(options.some((o) => o.value === OTHER_MUNICIPIO)).toBe(false);
  });

  it('returns an empty array for an unknown departamento code', () => {
    expect(municipioOptionsFor('00')).toEqual([]);
  });
});

describe("validateCheckoutStep('contact', ...)", () => {
  it('flags a missing email', () => {
    const errors = validateCheckoutStep('contact', validState({ email: '' }));
    expect(errors.email).toBeTruthy();
  });

  it('flags a missing phone', () => {
    const errors = validateCheckoutStep('contact', validState({ phone: '' }));
    expect(errors.phone).toBeTruthy();
  });

  it('flags a malformed email', () => {
    const errors = validateCheckoutStep('contact', validState({ email: 'not-an-email' }));
    expect(errors.email).toBeTruthy();
  });

  it('does not flag address/shipping fields for the contact step', () => {
    const errors = validateCheckoutStep('contact', validState({ direccion: '', shippingMethodId: '' }));
    expect(errors.direccion).toBeUndefined();
    expect(errors.shippingMethodId).toBeUndefined();
  });
});

describe("validateCheckoutStep('address', ...)", () => {
  it('flags a missing dirección', () => {
    const errors = validateCheckoutStep('address', validState({ direccion: '' }));
    expect(errors.direccion).toBeTruthy();
  });

  it('flags a municipio that does not belong to the selected departamento', () => {
    const errors = validateCheckoutStep(
      'address',
      validState({ departamentoCode: VALID_DEPARTAMENTO.code, municipioName: OTHER_MUNICIPIO }),
    );
    expect(errors.municipioName).toBeTruthy();
  });

  it('does not flag contact/shipping fields for the address step', () => {
    const errors = validateCheckoutStep('address', validState({ email: '', shippingMethodId: '' }));
    expect(errors.email).toBeUndefined();
    expect(errors.shippingMethodId).toBeUndefined();
  });
});

describe("validateCheckoutStep('shipping', ...)", () => {
  it('flags a missing shippingMethodId', () => {
    const errors = validateCheckoutStep('shipping', validState({ shippingMethodId: '' }));
    expect(errors.shippingMethodId).toBeTruthy();
  });
});

describe("validateCheckoutStep('payment', ...)", () => {
  it('flags an empty paymentMethod', () => {
    const errors = validateCheckoutStep('payment', validState({ paymentMethod: '' }));
    expect(errors.paymentMethod).toBeTruthy();
  });

  it("does not flag 'cod'", () => {
    const errors = validateCheckoutStep('payment', validState({ paymentMethod: 'cod' }));
    expect(errors.paymentMethod).toBeUndefined();
  });

  it("does not flag 'wompi'", () => {
    const errors = validateCheckoutStep('payment', validState({ paymentMethod: 'wompi' }));
    expect(errors.paymentMethod).toBeUndefined();
  });
});

describe('a fully valid state', () => {
  it("returns {} for 'contact'", () => {
    expect(validateCheckoutStep('contact', validState())).toEqual({});
  });

  it("returns {} for 'address'", () => {
    expect(validateCheckoutStep('address', validState())).toEqual({});
  });

  it("returns {} for 'shipping'", () => {
    expect(validateCheckoutStep('shipping', validState())).toEqual({});
  });

  it("returns {} for 'payment'", () => {
    expect(validateCheckoutStep('payment', validState())).toEqual({});
  });
});
