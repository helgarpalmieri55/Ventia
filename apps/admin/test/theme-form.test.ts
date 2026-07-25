import { describe, expect, it } from 'vitest';
import { DEFAULT_THEME_FORM, themeToFormState } from '../lib/theme-form';

describe('themeToFormState', () => {
  it('falls back to defaults for an undefined theme (brand-new tenant, wizard never fetched)', () => {
    expect(themeToFormState(undefined)).toEqual(DEFAULT_THEME_FORM);
  });

  it('falls back to defaults for an empty theme ({} — tenant has never PUT a theme)', () => {
    expect(themeToFormState({})).toEqual(DEFAULT_THEME_FORM);
  });

  it('falls back to defaults for a null theme', () => {
    expect(themeToFormState(null)).toEqual(DEFAULT_THEME_FORM);
  });

  it('maps a fully-populated saved theme to form state, preserving every field', () => {
    const saved = themeToFormState({
      colors: { primary: '#ff0000', background: '#000000', foreground: '#eeeeee' },
      fontPair: 'poppins-source',
      radius: 'full',
      logoUrl: 'https://example.com/logo.png',
      faviconUrl: 'https://example.com/favicon.png',
    });

    expect(saved).toEqual({
      primary: '#ff0000',
      background: '#000000',
      foreground: '#eeeeee',
      fontPair: 'poppins-source',
      radius: 'full',
      logoUrl: 'https://example.com/logo.png',
      faviconUrl: 'https://example.com/favicon.png',
    });
  });

  it('this is exactly the regression case: a saved non-default theme must not be overwritten by defaults', () => {
    const saved = themeToFormState({
      colors: { primary: '#123456', background: '#654321', foreground: '#abcdef' },
      fontPair: 'worksans-bitter',
      radius: 'none',
    });

    expect(saved.primary).not.toBe(DEFAULT_THEME_FORM.primary);
    expect(saved.fontPair).not.toBe(DEFAULT_THEME_FORM.fontPair);
    expect(saved.radius).not.toBe(DEFAULT_THEME_FORM.radius);
  });

  it('omits logoUrl in the saved theme -> falls back to the empty-string default', () => {
    const saved = themeToFormState({
      colors: { primary: '#ff0000', background: '#000000', foreground: '#eeeeee' },
      fontPair: 'poppins-source',
      radius: 'full',
    });

    expect(saved.logoUrl).toBe('');
  });

  it('preserves faviconUrl when set in the saved theme', () => {
    const saved = themeToFormState({
      colors: { primary: '#ff0000', background: '#000000', foreground: '#eeeeee' },
      fontPair: 'poppins-source',
      radius: 'full',
      faviconUrl: 'https://example.com/favicon.ico',
    });

    expect(saved.faviconUrl).toBe('https://example.com/favicon.ico');
  });

  it('omits faviconUrl in the saved theme -> falls back to the empty-string default', () => {
    const saved = themeToFormState({
      colors: { primary: '#ff0000', background: '#000000', foreground: '#eeeeee' },
      fontPair: 'poppins-source',
      radius: 'full',
    });

    expect(saved.faviconUrl).toBe('');
  });

  it('degrades field-by-field for an invalid color, unknown fontPair, or unknown radius', () => {
    const saved = themeToFormState({
      colors: { primary: 'not-a-hex-color', background: '#000000', foreground: '#eeeeee' },
      fontPair: 'not-a-real-pair',
      radius: 'gigantic',
    });

    expect(saved.primary).toBe(DEFAULT_THEME_FORM.primary);
    expect(saved.background).toBe('#000000');
    expect(saved.foreground).toBe('#eeeeee');
    expect(saved.fontPair).toBe(DEFAULT_THEME_FORM.fontPair);
    expect(saved.radius).toBe(DEFAULT_THEME_FORM.radius);
  });

  it('degrades to defaults when colors is missing entirely from an otherwise-valid theme', () => {
    const saved = themeToFormState({ fontPair: 'raleway-open', radius: 'lg' });

    expect(saved.primary).toBe(DEFAULT_THEME_FORM.primary);
    expect(saved.background).toBe(DEFAULT_THEME_FORM.background);
    expect(saved.foreground).toBe(DEFAULT_THEME_FORM.foreground);
    expect(saved.fontPair).toBe('raleway-open');
    expect(saved.radius).toBe('lg');
  });
});
