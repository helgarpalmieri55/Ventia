import { describe, expect, it } from 'vitest';
import { centsToPesos, formatCOP, pesosToCents } from '../lib/format';

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

describe('pesosToCents', () => {
  it('converts a peso number to integer cents', () => {
    expect(pesosToCents(45900)).toBe(4590000);
  });

  it('converts a peso string (as typed into a form input) to integer cents', () => {
    expect(pesosToCents('45900')).toBe(4590000);
  });

  it('trims whitespace around a string input', () => {
    expect(pesosToCents(' 45900 ')).toBe(4590000);
  });

  it('rounds a fractional-peso input to the nearest cent', () => {
    expect(pesosToCents('45900.005')).toBe(4590001);
  });

  it('converts zero', () => {
    expect(pesosToCents(0)).toBe(0);
    expect(pesosToCents('0')).toBe(0);
  });

  it('returns null for an empty string', () => {
    expect(pesosToCents('')).toBeNull();
    expect(pesosToCents('   ')).toBeNull();
  });

  it('returns null for a non-numeric string', () => {
    expect(pesosToCents('abc')).toBeNull();
  });

  it('returns null for a negative amount', () => {
    expect(pesosToCents(-100)).toBeNull();
    expect(pesosToCents('-100')).toBeNull();
  });
});

describe('centsToPesos', () => {
  it('converts integer cents to a peso number', () => {
    expect(centsToPesos(4590000)).toBe(45900);
  });

  it('converts zero', () => {
    expect(centsToPesos(0)).toBe(0);
  });

  it('preserves fractional pesos rather than rounding (an editable-input concern, unlike formatCOP)', () => {
    expect(centsToPesos(4590050)).toBe(45900.5);
  });
});

describe('pesosToCents / centsToPesos round-trip', () => {
  it('round-trips a whole-peso amount', () => {
    expect(centsToPesos(pesosToCents(45900)!)).toBe(45900);
  });

  it('round-trips a string input through both conversions', () => {
    expect(centsToPesos(pesosToCents('129900')!)).toBe(129900);
  });

  it('round-trips zero', () => {
    expect(centsToPesos(pesosToCents('0')!)).toBe(0);
  });
});
