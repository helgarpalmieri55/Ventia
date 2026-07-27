import { describe, expect, it } from 'vitest';
import { checkoutAddressSchema } from '../src/address-schemas';

describe('checkoutAddressSchema', () => {
  it('accepts a valid Bogotá D.C. address', () => {
    const result = checkoutAddressSchema.parse({
      nombreCompleto: 'Maria Fernanda Gomez',
      telefono: '3001234567',
      departamentoCode: '11',
      municipioName: 'Bogotá, D.C.',
      direccion: 'Calle 100 # 15-20',
      complemento: 'Apto 301',
      barrio: 'Chapinero',
      notas: 'Dejar con el portero',
    });
    expect(result.municipioName).toBe('Bogotá, D.C.');
  });

  it('rejects a municipio that belongs to a different departamento, erroring on municipioName', () => {
    const result = checkoutAddressSchema.safeParse({
      nombreCompleto: 'Maria Fernanda Gomez',
      telefono: '3001234567',
      departamentoCode: '11', // Bogotá D.C.
      municipioName: 'Medellín', // belongs to Antioquia (05), not Bogotá
      direccion: 'Calle 100 # 15-20',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.join('.') === 'municipioName');
      expect(issue).toBeDefined();
    }
  });

  it('rejects a missing direccion', () => {
    const result = checkoutAddressSchema.safeParse({
      nombreCompleto: 'Maria Fernanda Gomez',
      telefono: '3001234567',
      departamentoCode: '11',
      municipioName: 'Bogotá, D.C.',
    });
    expect(result.success).toBe(false);
  });
});
