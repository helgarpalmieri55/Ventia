import { describe, expect, it } from 'vitest';
import { DEPARTAMENTOS, MUNICIPIOS, municipiosFor } from '../src/colombia-locations';

describe('DEPARTAMENTOS', () => {
  it('has exactly 33 entries (32 departments + Bogotá D.C.)', () => {
    expect(DEPARTAMENTOS).toHaveLength(33);
  });

  it('has unique codes', () => {
    const codes = DEPARTAMENTOS.map((d) => d.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('includes Bogotá D.C. with DIVIPOLA code 11', () => {
    const bogota = DEPARTAMENTOS.find((d) => d.code === '11');
    expect(bogota).toBeDefined();
    expect(bogota?.name).toMatch(/Bogot/);
  });
});

describe('MUNICIPIOS', () => {
  it('every municipio references a valid departamento code', () => {
    const validCodes = new Set(DEPARTAMENTOS.map((d) => d.code));
    for (const m of MUNICIPIOS) {
      expect(validCodes.has(m.departamentoCode)).toBe(true);
    }
  });
});

describe('municipiosFor', () => {
  it('returns at least one entry for Bogotá D.C. (11)', () => {
    const result = municipiosFor('11');
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result.every((m) => m.departamentoCode === '11')).toBe(true);
  });

  it('returns [] for a nonexistent departamento code', () => {
    // '00' is not a real DIVIPOLA departamento code (unlike '99', which is
    // Vichada's real code and therefore unsuitable as a "nonexistent" example).
    expect(municipiosFor('00')).toEqual([]);
  });
});
