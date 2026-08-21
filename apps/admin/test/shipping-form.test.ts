import { shippingMethodSchema } from '@ventia/core';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SHIPPING_FORM,
  etaFromDraft,
  etaToDraft,
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

describe('etaToDraft / etaFromDraft', () => {
  const flat: ShippingMethodInput = {
    id: 'm1',
    type: 'flat',
    label: 'Envío estándar',
    priceCents: 1_200_000,
    enabled: true,
  };

  it('round-trips a saved estimate through the form and back', () => {
    const draft = etaToDraft({ ...flat, etaMinDays: 2, etaMaxDays: 5 });
    expect(draft).toEqual({ etaMinDays: '2', etaMaxDays: '5' });
    expect(etaFromDraft(draft)).toEqual({ etaMinDays: 2, etaMaxDays: 5 });
  });

  it('round-trips zero, which is a real answer and not "unset"', () => {
    // "Llega el mismo día" is 0 business days. A truthiness check anywhere in
    // this path would silently turn it into "no estimate".
    const draft = etaToDraft({ ...flat, etaMinDays: 0, etaMaxDays: 1 });
    expect(draft).toEqual({ etaMinDays: '0', etaMaxDays: '1' });
    expect(etaFromDraft(draft)).toEqual({ etaMinDays: 0, etaMaxDays: 1 });
  });

  it('shows a half-filled or inverted saved pair as blank rather than half-populated', () => {
    // Both cases are refused by shippingMethodSchema today, but can sit in
    // settings JSON written before that refinement. Loading them as blanks
    // makes the merchant enter a whole range instead of saving the broken one
    // straight back.
    expect(etaToDraft({ ...flat, etaMinDays: 3 })).toEqual({ etaMinDays: '', etaMaxDays: '' });
    expect(etaToDraft({ ...flat, etaMinDays: 9, etaMaxDays: 2 })).toEqual({ etaMinDays: '', etaMaxDays: '' });
  });

  it('omits the pair entirely when the merchant left both boxes empty', () => {
    expect(etaFromDraft({ etaMinDays: '', etaMaxDays: '' })).toEqual({});
    expect(etaFromDraft({ etaMinDays: '  ', etaMaxDays: '' })).toEqual({});
  });

  it('sends a half-filled range on for the server to reject, rather than guessing', () => {
    // NaN is what shippingMethodSchema's z.number() refuses, surfacing as the
    // ordinary VALIDATION_FAILED. Silently dropping the filled half would
    // discard what the merchant typed without telling them.
    const missingMax = etaFromDraft({ etaMinDays: '2', etaMaxDays: '' });
    expect(missingMax.etaMinDays).toBe(2);
    expect(Number.isNaN(missingMax.etaMaxDays)).toBe(true);
    expect(shippingMethodSchema.safeParse({ ...flat, ...missingMax }).success).toBe(false);

    // The dangerous direction: `Number('')` is 0, so an empty "desde" box left
    // to plain coercion would save as a valid 0–5 day range — a same-day
    // delivery promise the merchant never made.
    const missingMin = etaFromDraft({ etaMinDays: '', etaMaxDays: '5' });
    expect(Number.isNaN(missingMin.etaMinDays)).toBe(true);
    expect(shippingMethodSchema.safeParse({ ...flat, ...missingMin }).success).toBe(false);

    // Non-numeric text, same treatment.
    expect(Number.isNaN(etaFromDraft({ etaMinDays: 'dos', etaMaxDays: '5' }).etaMinDays)).toBe(true);
  });

  it('produces a method the schema accepts', () => {
    const method = { ...flat, ...etaFromDraft({ etaMinDays: '1', etaMaxDays: '3' }) };
    expect(shippingMethodSchema.safeParse(method).success).toBe(true);
  });
});
