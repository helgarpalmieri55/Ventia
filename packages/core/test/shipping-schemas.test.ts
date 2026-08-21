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

describe('shippingMethodSchema — tiempo de entrega', () => {
  const flat = { id: 'm1', type: 'flat', label: 'Envío estándar', priceCents: 1200000, enabled: true };

  it('accepts a method without any estimate', () => {
    // Es opcional: un comerciante que no sabe cuánto tarda no debe quedar
    // bloqueado para guardar sus métodos de envío.
    expect(shippingMethodSchema.parse(flat)).not.toHaveProperty('etaMinDays');
  });

  it('accepts a coherent range on every tipo de método', () => {
    expect(shippingMethodSchema.parse({ ...flat, etaMinDays: 2, etaMaxDays: 5 })).toMatchObject({
      etaMinDays: 2,
      etaMaxDays: 5,
    });
    expect(
      shippingMethodSchema.parse({
        id: 'm2',
        type: 'pickup',
        label: 'Recoger en tienda',
        enabled: true,
        etaMinDays: 0,
        etaMaxDays: 1,
      }),
    ).toMatchObject({ etaMinDays: 0, etaMaxDays: 1 });
    expect(
      shippingMethodSchema.parse({
        id: 'm3',
        type: 'zone',
        label: 'Por departamento',
        ratesByDepartamento: { '11': 1000 },
        enabled: true,
        etaMinDays: 3,
        etaMaxDays: 8,
      }),
    ).toMatchObject({ etaMinDays: 3, etaMaxDays: 8 });
    expect(
      shippingMethodSchema.parse({
        id: 'm4',
        type: 'free_over',
        label: 'Envío gratis',
        thresholdCents: 10_000_00,
        fallbackPriceCents: 1000,
        enabled: true,
        etaMinDays: 1,
        etaMaxDays: 2,
      }),
    ).toMatchObject({ etaMinDays: 1, etaMaxDays: 2 });
  });

  it('rechaza medio rango: no se puede redactar "entre … y 5 días"', () => {
    expect(shippingMethodSchema.safeParse({ ...flat, etaMinDays: 2 }).success).toBe(false);
    expect(shippingMethodSchema.safeParse({ ...flat, etaMaxDays: 5 }).success).toBe(false);
  });

  it('rechaza un rango invertido', () => {
    expect(shippingMethodSchema.safeParse({ ...flat, etaMinDays: 9, etaMaxDays: 2 }).success).toBe(false);
  });

  it('rechaza días negativos o absurdamente lejanos', () => {
    expect(shippingMethodSchema.safeParse({ ...flat, etaMinDays: -1, etaMaxDays: 5 }).success).toBe(false);
    expect(shippingMethodSchema.safeParse({ ...flat, etaMinDays: 1, etaMaxDays: 91 }).success).toBe(false);
    expect(shippingMethodSchema.safeParse({ ...flat, etaMinDays: 1.5, etaMaxDays: 5 }).success).toBe(false);
  });

  it('sigue discriminando por `type` con el refinamiento encima de la unión', () => {
    // El `superRefine` va sobre la unión justamente porque envolver un miembro
    // en ZodEffects rompería `discriminatedUnion`. Esto lo fija: un `type`
    // desconocido tiene que fallar como unión, no pasar de largo.
    expect(shippingMethodSchema.safeParse({ ...flat, type: 'inventado' }).success).toBe(false);
    expect(shippingMethodSchema.safeParse({ id: 'm9', type: 'flat', label: 'X', enabled: true }).success).toBe(false);
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
