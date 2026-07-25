import { describe, expect, it } from 'vitest';
import { buildThemeVars, fontPairVars } from '../lib/theme';

describe('buildThemeVars', () => {
  it('maps a saved theme to CSS variables', () => {
    const vars = buildThemeVars({
      colors: { primary: '#4f46e5', background: '#ffffff', foreground: '#111827' },
      fontPair: 'inter-lora',
      radius: 'md',
      logoUrl: '',
      faviconUrl: '',
    });
    expect(vars['--color-primary']).toBe('#4f46e5');
    expect(vars['--radius']).toBe('0.5rem');
  });

  it('falls back to neutral defaults when no theme is saved', () => {
    const vars = buildThemeVars(null);
    expect(vars['--color-primary']).toBeTruthy();
    expect(vars['--radius']).toBeTruthy();
  });

  it('includes the tenant font pair as --font-heading/--font-body', () => {
    const vars = buildThemeVars({
      colors: { primary: '#4f46e5', background: '#ffffff', foreground: '#111827' },
      fontPair: 'raleway-open',
      radius: 'md',
    });
    expect(vars['--font-heading']).toBe('var(--font-raleway)');
    expect(vars['--font-body']).toBe('var(--font-open-sans)');
  });
});

describe('fontPairVars', () => {
  it.each([
    ['inter-lora', 'var(--font-inter)', 'var(--font-lora)'],
    ['poppins-source', 'var(--font-poppins)', 'var(--font-source-serif-4)'],
    ['montserrat-merriweather', 'var(--font-montserrat)', 'var(--font-merriweather)'],
    ['raleway-open', 'var(--font-raleway)', 'var(--font-open-sans)'],
    ['worksans-bitter', 'var(--font-work-sans)', 'var(--font-bitter)'],
  ] as const)('maps %s to its heading/body vars', (fontPair, heading, body) => {
    expect(fontPairVars(fontPair)).toEqual({ heading, body });
  });

  it('falls back to the default pair (inter-lora) for a missing/invalid value', () => {
    expect(fontPairVars('')).toEqual({ heading: 'var(--font-inter)', body: 'var(--font-lora)' });
    expect(fontPairVars('not-a-real-pair')).toEqual({ heading: 'var(--font-inter)', body: 'var(--font-lora)' });
  });
});
