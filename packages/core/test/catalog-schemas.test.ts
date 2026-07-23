import { describe, expect, it } from 'vitest';
import { productInputSchema, variantsReplaceSchema } from '../src/catalog-schemas';

describe('productInputSchema', () => {
  it('accepts a minimal valid product', () => {
    const p = productInputSchema.parse({ name: 'Camiseta', priceCents: 4590000 });
    expect(p.taxRate).toBe('19'); // default
    expect(p.status).toBe('draft');
  });
  it('rejects non-integer or negative money', () => {
    expect(() => productInputSchema.parse({ name: 'x', priceCents: 10.5 })).toThrow();
    expect(() => productInputSchema.parse({ name: 'x', priceCents: -1 })).toThrow();
  });
  it('rejects more than 3 variant options', () => {
    expect(() =>
      variantsReplaceSchema.parse({
        options: ['Talla', 'Color', 'Material', 'Extra'],
        variants: [],
      }),
    ).toThrow();
  });
});
