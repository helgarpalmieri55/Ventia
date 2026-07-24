import { describe, expect, it } from 'vitest';
import { productInputSchema, productUpdateSchema, variantsReplaceSchema } from '../src/catalog-schemas';

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

describe('productUpdateSchema', () => {
  it('does not have a stock field: stock changes must go through POST /:id/stock', () => {
    expect(productUpdateSchema.shape).not.toHaveProperty('stock');
    // a `stock` key in the input is simply stripped (zod objects drop unknown
    // keys by default), not rejected -- callers relying on PATCH to move
    // stock silently no-op rather than error, which is why the removal is
    // also enforced at the service layer (see products.service.ts).
    const parsed = productUpdateSchema.parse({ name: 'x', stock: 999 });
    expect(parsed).not.toHaveProperty('stock');
  });
});
