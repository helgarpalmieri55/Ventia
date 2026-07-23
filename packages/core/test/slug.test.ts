import { describe, expect, it } from 'vitest';
import { slugify } from '../src/slug';

describe('slugify', () => {
  it('lowercases, strips accents, dashes spaces', () => {
    expect(slugify('Camiseta Básica Ñoño')).toBe('camiseta-basica-nono');
  });
  it('collapses symbols and trims dashes', () => {
    expect(slugify('  ¡Jean -- Clásico! 30% ')).toBe('jean-clasico-30');
  });
  it('caps length at 60', () => {
    expect(slugify('x'.repeat(100))).toHaveLength(60);
  });
});
