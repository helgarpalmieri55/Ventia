import { describe, expect, it } from 'vitest';
import { buildThemeVars } from '../lib/theme';

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
});
