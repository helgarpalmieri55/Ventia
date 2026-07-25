import { describe, expect, it } from 'vitest';
import { buildVariantsPayload, type VariantRowInput } from '../lib/variants';

function row(partial: Partial<VariantRowInput>): VariantRowInput {
  return { values: ['', '', ''], sku: '', priceCentsPesos: '', stock: '', ...partial };
}

describe('buildVariantsPayload', () => {
  it('trims labels and drops blank ones, preserving order', () => {
    const payload = buildVariantsPayload([' Talla ', '', ' Color '], []);
    expect(payload.options).toEqual(['Talla', 'Color']);
  });

  it('caps labels at 3 (variantsReplaceSchema max)', () => {
    const payload = buildVariantsPayload(['A', 'B', 'C', 'D'], []);
    expect(payload.options).toEqual(['A', 'B', 'C']);
  });

  it('drops a row where every field is blank', () => {
    const payload = buildVariantsPayload(
      ['Talla'],
      [row({ values: ['S', '', ''] }), row({})],
    );
    expect(payload.variants).toHaveLength(1);
  });

  it('keeps a row with only a sku filled in (no option value)', () => {
    const payload = buildVariantsPayload(['Talla'], [row({ sku: 'SKU-1' })]);
    expect(payload.variants).toHaveLength(1);
    expect(payload.variants[0]).toEqual({ sku: 'SKU-1', stock: 0 });
  });

  it('builds a full row: trims values, converts pesos to priceCents, parses stock', () => {
    const payload = buildVariantsPayload(
      ['Talla', 'Color'],
      [row({ values: [' S ', ' Rojo ', ''], sku: ' SKU-S-ROJO ', priceCentsPesos: ' 10000 ', stock: ' 5 ' })],
    );
    expect(payload.options).toEqual(['Talla', 'Color']);
    expect(payload.variants[0]).toEqual({
      option1: 'S',
      option2: 'Rojo',
      sku: 'SKU-S-ROJO',
      priceCents: 1_000_000,
      stock: 5,
    });
  });

  it('aligns row values to kept label indices when a middle label is blank', () => {
    // labels[1] ('') is dropped, so only values[0] and values[2] survive,
    // landing on option1/option2 respectively (not option1/option3).
    const payload = buildVariantsPayload(
      ['Talla', '', 'Color'],
      [row({ values: ['XL', 'unused', 'Azul'] })],
    );
    expect(payload.options).toEqual(['Talla', 'Color']);
    expect(payload.variants[0]).toEqual({ option1: 'XL', option2: 'Azul', stock: 0 });
  });

  it('omits priceCents when the pesos input is blank or invalid', () => {
    const blank = buildVariantsPayload(['Talla'], [row({ values: ['S', '', ''] })]);
    expect(blank.variants[0]!.priceCents).toBeUndefined();

    const invalid = buildVariantsPayload(['Talla'], [row({ values: ['S', '', ''], priceCentsPesos: 'abc' })]);
    expect(invalid.variants[0]!.priceCents).toBeUndefined();
  });

  it('defaults stock to 0 when blank', () => {
    const payload = buildVariantsPayload(['Talla'], [row({ values: ['S', '', ''] })]);
    expect(payload.variants[0]!.stock).toBe(0);
  });

  it('returns an empty variants array when every row is blank', () => {
    const payload = buildVariantsPayload(['Talla'], [row({}), row({})]);
    expect(payload.variants).toEqual([]);
  });
});
