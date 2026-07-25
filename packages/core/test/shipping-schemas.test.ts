import { describe, expect, it } from 'vitest';
import { shippingMethodSchema, shippingSettingsSchema } from '../src/shipping-schemas';

describe('shippingMethodSchema', () => {
  it('parses a flat method', () => {
    const result = shippingMethodSchema.parse({
      id: 'm1',
      type: 'flat',
      label: 'Envío estándar',
      priceCents: 1200000,
      enabled: true,
    });
    expect(result.type).toBe('flat');
  });

  it('parses a zone method', () => {
    const result = shippingMethodSchema.parse({
      id: 'm2',
      type: 'zone',
      label: 'Envío por zona',
      ratesByDepartamento: { '11': 1000000, '05': 1500000 },
      defaultPriceCents: 2000000,
      enabled: true,
    });
    expect(result.type).toBe('zone');
  });

  it('parses a free_over method', () => {
    const result = shippingMethodSchema.parse({
      id: 'm3',
      type: 'free_over',
      label: 'Envío gratis',
      thresholdCents: 10000000,
      fallbackPriceCents: 1500000,
      enabled: true,
    });
    expect(result.type).toBe('free_over');
  });

  it('parses a pickup method', () => {
    const result = shippingMethodSchema.parse({
      id: 'm4',
      type: 'pickup',
      label: 'Recoger en tienda',
      instructions: 'Presentar cédula al recoger',
      enabled: true,
    });
    expect(result.type).toBe('pickup');
  });

  it('rejects an unknown type discriminator', () => {
    expect(() =>
      shippingMethodSchema.parse({
        id: 'm5',
        type: 'teleport',
        label: 'Envío cuántico',
        enabled: true,
      }),
    ).toThrow();
  });

  it('rejects a zone method with a negative rate in ratesByDepartamento', () => {
    expect(() =>
      shippingMethodSchema.parse({
        id: 'm6',
        type: 'zone',
        label: 'Envío por zona',
        ratesByDepartamento: { '11': -100 },
        enabled: true,
      }),
    ).toThrow();
  });
});

describe('shippingSettingsSchema', () => {
  it('parses a settings object with methods and codRestrictedDepartamentos', () => {
    const result = shippingSettingsSchema.parse({
      methods: [
        { id: 'm1', type: 'flat', label: 'Envío estándar', priceCents: 1200000, enabled: true },
        { id: 'm4', type: 'pickup', label: 'Recoger en tienda', enabled: true },
      ],
      codRestrictedDepartamentos: ['91'],
    });
    expect(result.methods).toHaveLength(2);
  });
});
