import { shippingMethodSchema } from '@ventia/core';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SHIPPING_FORM,
  newFlatMethod,
  newFreeOverMethod,
  newPickupMethod,
  newZoneMethod,
  shippingToFormState,
} from '../lib/shipping-form';

describe('shippingToFormState', () => {
  it('falls back to defaults for an undefined shipping config (brand-new tenant, never PATCHed)', () => {
    expect(shippingToFormState(undefined)).toEqual(DEFAULT_SHIPPING_FORM);
  });

  it('falls back to defaults for an empty shipping config ({} — tenant has never PATCHed /settings/shipping)', () => {
    expect(shippingToFormState({})).toEqual(DEFAULT_SHIPPING_FORM);
  });

  it('maps a valid saved shape to form state unchanged', () => {
    const saved = {
      methods: [{ id: 'm1', type: 'flat', label: 'Envío estándar', priceCents: 12000, enabled: true }],
      codRestrictedDepartamentos: ['94'],
    };

    expect(shippingToFormState(saved)).toEqual({
      methods: [{ id: 'm1', type: 'flat', label: 'Envío estándar', priceCents: 12000, enabled: true }],
      codRestrictedDepartamentos: ['94'],
    });
  });

  it('falls back to an empty methods array when `methods` is not an array, rather than throwing', () => {
    const saved = { methods: 'not-an-array', codRestrictedDepartamentos: ['05'] };

    expect(() => shippingToFormState(saved)).not.toThrow();
    expect(shippingToFormState(saved)).toEqual({ methods: [], codRestrictedDepartamentos: ['05'] });
  });

  it('falls back to an empty codRestrictedDepartamentos array when it is not an array, rather than throwing', () => {
    const saved = { methods: [], codRestrictedDepartamentos: 'not-an-array' };

    expect(() => shippingToFormState(saved)).not.toThrow();
    expect(shippingToFormState(saved)).toEqual({ methods: [], codRestrictedDepartamentos: [] });
  });

  it('falls back to defaults per-field when both fields are malformed', () => {
    expect(shippingToFormState({ methods: 42, codRestrictedDepartamentos: null })).toEqual(DEFAULT_SHIPPING_FORM);
  });

  it('drops individual methods that fail shippingMethodSchema instead of throwing or passing them through', () => {
    const saved = {
      methods: [
        { id: 'ok', type: 'flat', label: 'Envío estándar', priceCents: 12000, enabled: true },
        null,
        'not-an-object',
        { id: 'bad-type', type: 'carrier-pigeon', label: 'x', enabled: true },
        { id: 'missing-price', type: 'flat', label: 'x', enabled: true }, // no priceCents
      ],
    };

    expect(() => shippingToFormState(saved)).not.toThrow();
    expect(shippingToFormState(saved).methods).toEqual([
      { id: 'ok', type: 'flat', label: 'Envío estándar', priceCents: 12000, enabled: true },
    ]);
  });
});

describe('new*Method constructors', () => {
  it('newFlatMethod() returns a shape shippingMethodSchema accepts as-is', () => {
    expect(shippingMethodSchema.safeParse(newFlatMethod()).success).toBe(true);
  });

  it('newZoneMethod() returns a shape shippingMethodSchema accepts as-is', () => {
    expect(shippingMethodSchema.safeParse(newZoneMethod()).success).toBe(true);
  });

  it('newFreeOverMethod() returns a shape shippingMethodSchema accepts as-is', () => {
    expect(shippingMethodSchema.safeParse(newFreeOverMethod()).success).toBe(true);
  });

  it('newPickupMethod() returns a shape shippingMethodSchema accepts as-is', () => {
    expect(shippingMethodSchema.safeParse(newPickupMethod()).success).toBe(true);
  });

  it('each new*Method() has a unique id', () => {
    const ids = new Set([newFlatMethod().id, newZoneMethod().id, newFreeOverMethod().id, newPickupMethod().id]);
    expect(ids.size).toBe(4);
  });
});
