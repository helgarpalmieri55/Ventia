import { describe, expect, it } from 'vitest';
import { THEME_PRESETS } from '@ventia/core';
import {
  DEFAULT_THEME_FORM,
  applyPresetToFormState,
  formStateToThemePayload,
  presetIdFromSelectValue,
  themeToFormState,
} from '../lib/theme-form';

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
      // A flat theme is a custom one — see `ThemeFormState.presetId`. It is
      // never adopted into whichever preset happens to look closest.
      presetId: null,
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

describe('themeToFormState — presets', () => {
  it('maps a bare preset choice to that preset look, with the preset still selected', () => {
    const state = themeToFormState({ presetId: 'vitrina' });

    expect(state.presetId).toBe('vitrina');
    expect(state.primary).toBe(THEME_PRESETS.vitrina.tokens.colors.primary);
    expect(state.fontPair).toBe(THEME_PRESETS.vitrina.tokens.fontPair);
    expect(state.radius).toBe(THEME_PRESETS.vitrina.tokens.radius);
  });

  it('shows an override where there is one and the preset value everywhere else', () => {
    const state = themeToFormState({ presetId: 'mercado', overrides: { colors: { primary: '#ff0000' } } });

    expect(state.presetId).toBe('mercado');
    expect(state.primary).toBe('#ff0000');
    expect(state.background).toBe(THEME_PRESETS.mercado.tokens.colors.background);
    expect(state.radius).toBe(THEME_PRESETS.mercado.tokens.radius);
  });

  it('reads a pre-preset flat theme back as custom, never adopted into a preset', () => {
    const state = themeToFormState({
      colors: { primary: '#123456', background: '#654321', foreground: '#abcdef' },
      fontPair: 'worksans-bitter',
      radius: 'none',
    });

    expect(state.presetId).toBeNull();
  });

  it('keeps the merchant assets on a preset theme (no preset supplies a logo)', () => {
    const state = themeToFormState({ presetId: 'taller', logoUrl: 'https://cdn.example.co/l.png' });

    expect(state.logoUrl).toBe('https://cdn.example.co/l.png');
    expect(state.faviconUrl).toBe('');
  });
});

describe('presetIdFromSelectValue', () => {
  it('maps a real preset id through and everything else to custom', () => {
    expect(presetIdFromSelectValue('boutique')).toBe('boutique');
    expect(presetIdFromSelectValue('')).toBeNull();
    expect(presetIdFromSelectValue('ferreteria')).toBeNull();
  });
});

describe('applyPresetToFormState', () => {
  it('snaps every token to the chosen preset so the form previews it immediately', () => {
    const next = applyPresetToFormState({ ...DEFAULT_THEME_FORM, logoUrl: 'https://cdn.example.co/l.png' }, 'catalogo');

    expect(next.presetId).toBe('catalogo');
    expect(next.primary).toBe(THEME_PRESETS.catalogo.tokens.colors.primary);
    expect(next.background).toBe(THEME_PRESETS.catalogo.tokens.colors.background);
    expect(next.foreground).toBe(THEME_PRESETS.catalogo.tokens.colors.foreground);
    expect(next.fontPair).toBe(THEME_PRESETS.catalogo.tokens.fontPair);
    expect(next.radius).toBe(THEME_PRESETS.catalogo.tokens.radius);
    // The merchant's own asset is not a token any preset can supply.
    expect(next.logoUrl).toBe('https://cdn.example.co/l.png');
  });

  it('switching to Personalizado keeps the tokens on screen rather than resetting them', () => {
    const onPreset = applyPresetToFormState(DEFAULT_THEME_FORM, 'boutique');
    const custom = applyPresetToFormState(onPreset, null);

    expect(custom.presetId).toBeNull();
    expect(custom.primary).toBe(THEME_PRESETS.boutique.tokens.colors.primary);
    expect(custom.fontPair).toBe(THEME_PRESETS.boutique.tokens.fontPair);
  });
});

describe('formStateToThemePayload', () => {
  it('sends the pre-preset flat body for a custom theme, unchanged', () => {
    // This is the shape the wizard and the Marca tab have always PUT; a
    // tenant on "Personalizado" must keep saving exactly as before.
    expect(
      formStateToThemePayload({
        presetId: null,
        primary: '#123456',
        background: '#654321',
        foreground: '#abcdef',
        fontPair: 'worksans-bitter',
        radius: 'none',
        logoUrl: 'https://cdn.example.co/l.png',
        faviconUrl: '',
      }),
    ).toEqual({
      colors: { primary: '#123456', background: '#654321', foreground: '#abcdef' },
      fontPair: 'worksans-bitter',
      radius: 'none',
      logoUrl: 'https://cdn.example.co/l.png',
    });
  });

  it('sends only the preset id when the merchant tweaked nothing', () => {
    // No `overrides` key at all — "chose Vitrina and left it alone" must read
    // that way in the stored JSON, and every token must keep tracking the
    // preset so a later improvement to it reaches this store.
    expect(formStateToThemePayload(applyPresetToFormState(DEFAULT_THEME_FORM, 'vitrina'))).toEqual({
      presetId: 'vitrina',
    });
  });

  it('sends only the one token the merchant actually changed', () => {
    const state = { ...applyPresetToFormState(DEFAULT_THEME_FORM, 'vitrina'), primary: '#ff0000' };

    expect(formStateToThemePayload(state)).toEqual({
      presetId: 'vitrina',
      overrides: { colors: { primary: '#ff0000' } },
    });
  });

  it('sends fontPair/radius overrides without dragging the untouched colours along', () => {
    const state = { ...applyPresetToFormState(DEFAULT_THEME_FORM, 'catalogo'), fontPair: 'poppins-source' as const, radius: 'full' as const };

    expect(formStateToThemePayload(state)).toEqual({
      presetId: 'catalogo',
      overrides: { fontPair: 'poppins-source', radius: 'full' },
    });
  });

  it('keeps the assets alongside a preset and omits an empty one', () => {
    const state = {
      ...applyPresetToFormState(DEFAULT_THEME_FORM, 'mercado'),
      logoUrl: 'https://cdn.example.co/l.png',
      faviconUrl: '',
    };

    expect(formStateToThemePayload(state)).toEqual({ presetId: 'mercado', logoUrl: 'https://cdn.example.co/l.png' });
  });

  it('round-trips: save a tweaked preset, read it back, and nothing has moved', () => {
    // The regression that matters for presets: the sparse payload the form
    // sends must resolve back to the same form state, or a merchant who saves
    // twice in a row drifts away from their preset one token at a time.
    const saved = { ...applyPresetToFormState(DEFAULT_THEME_FORM, 'taller'), foreground: '#010203' };
    const payload = formStateToThemePayload(saved);

    expect(themeToFormState(payload as Record<string, unknown>)).toEqual(saved);
    expect(formStateToThemePayload(themeToFormState(payload as Record<string, unknown>))).toEqual(payload);
  });
});
