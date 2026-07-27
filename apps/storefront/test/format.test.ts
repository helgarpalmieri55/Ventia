import { describe, expect, it } from 'vitest';
import { formatCOP } from '../lib/format';

describe('formatCOP', () => {
  it('formats integer cents (pesos = cents / 100) as es-CO COP with no decimals', () => {
    expect(formatCOP(4590000)).toBe('$ 45.900');
  });

  it('formats zero', () => {
    expect(formatCOP(0)).toBe('$ 0');
  });

  it('formats a larger amount with thousands separators', () => {
    expect(formatCOP(12990000)).toBe('$ 129.900');
  });

  it('rounds a non-multiple-of-100 cents value to the nearest peso', () => {
    // 150 cents / 100 = 1.5 pesos -> rounds to 2.
    expect(formatCOP(150)).toBe('$ 2');
  });
});
