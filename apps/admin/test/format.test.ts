import { describe, expect, it } from 'vitest';
import {
  centsToPesos,
  formatCOP,
  formatDateBogota,
  formatLongDateBogota,
  pesosToCents,
  toBogotaDateInput,
} from '../lib/format';

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

describe('Bogotá-pinned dates', () => {
  // The API stores `paidUntil: '2026-09-01'` as the END of that day in
  // America/Bogota, i.e. `2026-09-02T04:59:59.999Z` on the wire (verified by
  // running services/api/src/platform/subscription-window.ts directly). Every
  // assertion below is written against that real value.
  const paidUntilWire = '2026-09-02T04:59:59.999Z';
  // What the same run produced for `suspendsOn` with the default 7-day grace.
  const suspendsOnWire = '2026-09-09T04:59:59.999Z';

  it('renders the Bogotá calendar day, not the UTC one', () => {
    // The whole point: `formatDateCO` (runtime zone) would say 02/09/2026 for
    // anyone running in UTC or further east — a day later than the operator
    // typed, on the field that decides when a store goes offline.
    expect(formatDateBogota(paidUntilWire)).toBe('01/09/2026');
  });

  it('renders the suspension date as prose in Bogotá time', () => {
    // A store whose grace window ends at 2026-09-09T04:59:59.999Z goes dark on
    // the EIGHTH in Colombia. Saying "9 de septiembre" would be a day late.
    expect(formatLongDateBogota(suspendsOnWire)).toBe('8 de septiembre de 2026');
  });

  it('round-trips an instant back to the YYYY-MM-DD an <input type="date"> holds', () => {
    expect(toBogotaDateInput(paidUntilWire)).toBe('2026-09-01');
    expect(toBogotaDateInput(suspendsOnWire)).toBe('2026-09-08');
  });

  it('does not shift a plain midday instant', () => {
    expect(toBogotaDateInput('2026-03-14T17:00:00.000Z')).toBe('2026-03-14');
    expect(formatDateBogota('2026-03-14T17:00:00.000Z')).toBe('14/03/2026');
  });

  it('returns null rather than "Invalid Date" for unparseable input', () => {
    for (const bad of ['', 'no soy una fecha', '2026-13-45T00:00:00Z']) {
      expect(formatDateBogota(bad)).toBeNull();
      expect(formatLongDateBogota(bad)).toBeNull();
      expect(toBogotaDateInput(bad)).toBeNull();
    }
  });

  it('accepts a Date as well as a string', () => {
    expect(toBogotaDateInput(new Date(paidUntilWire))).toBe('2026-09-01');
  });
});
