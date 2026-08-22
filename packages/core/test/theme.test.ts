import { describe, expect, it } from 'vitest';
import {
  FALLBACK_THEME_TOKENS,
  FONT_PAIRS,
  RADIUS_OPTIONS,
  THEME_PRESETS,
  THEME_PRESET_IDS,
  resolveTheme,
  themeSchema,
} from '../src/theme.js';

/** The flat token bag every tenant created before presets existed has stored
 * in `Tenant.theme`. Used as the backwards-compatibility fixture throughout. */
const LEGACY_THEME = {
  colors: { primary: '#123456', background: '#fefefe', foreground: '#222222' },
  fontPair: 'worksans-bitter',
  radius: 'none',
} as const;

describe('THEME_PRESETS', () => {
  it('defines one preset per declared id, self-identifying and with es-CO copy', () => {
    expect(Object.keys(THEME_PRESETS).sort()).toEqual([...THEME_PRESET_IDS].sort());
    for (const id of THEME_PRESET_IDS) {
      const preset = THEME_PRESETS[id];
      expect(preset.id).toBe(id);
      // `sells` is the question the merchant actually answers during
      // onboarding ("¿qué vendes?"); a blank one makes the picker unusable.
      expect(preset.sells.length).toBeGreaterThan(0);
      expect(preset.label.length).toBeGreaterThan(0);
      expect(preset.description.length).toBeGreaterThan(0);
    }
  });

  it('every preset is expressible through tokens the storefront already renders', () => {
    for (const id of THEME_PRESET_IDS) {
      const { colors, fontPair, radius } = THEME_PRESETS[id].tokens;
      // A preset that named a font pair `apps/storefront/lib/theme.ts`'s
      // FONT_PAIR_VARS has no entry for, or a radius with no rem value, would
      // silently render as the default look — a setting with no effect.
      expect(FONT_PAIRS).toContain(fontPair);
      expect(RADIUS_OPTIONS).toContain(radius);
      for (const value of [colors.primary, colors.background, colors.foreground]) {
        expect(value).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });

  it('no two presets share a font pair or a corner radius', () => {
    // The design constraint from THEME_PRESETS' doc comment: two stores on
    // different presets must not read as siblings, which is the complaint
    // (product.md §4) presets exist to answer.
    const fontPairs = THEME_PRESET_IDS.map((id) => THEME_PRESETS[id].tokens.fontPair);
    const radii = THEME_PRESET_IDS.map((id) => THEME_PRESETS[id].tokens.radius);
    expect(new Set(fontPairs).size).toBe(THEME_PRESET_IDS.length);
    expect(new Set(radii).size).toBe(THEME_PRESET_IDS.length);
  });

  it('pins the neutral fallback, which apps/storefront/lib/theme.ts still duplicates by hand', () => {
    // `DEFAULT_THEME` over there is still its own literal — that module is
    // only reached with `null`, since `GET /v1/tenant` resolves everything
    // else — so the two copies can only stay in step if this one is pinned.
    // A tenant that never saved a theme renders from one copy and is edited
    // through the other; silent divergence means the panel and the shop show
    // different "defaults" and nobody can tell which is right.
    //
    // The presets themselves are deliberately NOT pinned this way: they exist
    // to be improved, and a test that had to be edited for every colour tweak
    // would only teach people to edit it without reading it. The structural
    // assertions above (renderable font pair / radius, valid hex, distinct
    // looks) are what guard those.
    expect(FALLBACK_THEME_TOKENS).toEqual({
      colors: { primary: '#4f46e5', background: '#ffffff', foreground: '#111827' },
      fontPair: 'inter-lora',
      radius: 'md',
    });
  });

  it('no preset is merely the neutral fallback under a name', () => {
    for (const id of THEME_PRESET_IDS) {
      expect(THEME_PRESETS[id].tokens).not.toEqual(FALLBACK_THEME_TOKENS);
    }
  });
});

describe('themeSchema', () => {
  it('still accepts the pre-preset flat body, unchanged', () => {
    const parsed = themeSchema.safeParse(LEGACY_THEME);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toEqual(LEGACY_THEME);
  });

  it('accepts a flat body with logoUrl/faviconUrl', () => {
    const body = { ...LEGACY_THEME, logoUrl: 'https://cdn.example.co/l.png', faviconUrl: 'https://cdn.example.co/f.png' };
    expect(themeSchema.safeParse(body).success).toBe(true);
  });

  it('accepts a bare preset choice with no overrides', () => {
    const parsed = themeSchema.safeParse({ presetId: 'vitrina' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toEqual({ presetId: 'vitrina' });
  });

  it('accepts a preset plus a single sparse override', () => {
    const parsed = themeSchema.safeParse({ presetId: 'mercado', overrides: { colors: { primary: '#ff0000' } } });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toEqual({ presetId: 'mercado', overrides: { colors: { primary: '#ff0000' } } });
  });

  it('rejects an unknown presetId', () => {
    expect(themeSchema.safeParse({ presetId: 'ferreteria' }).success).toBe(false);
  });

  it('rejects a flat body missing a token, keyed by field so the admin can show it inline', () => {
    const parsed = themeSchema.safeParse({ colors: LEGACY_THEME.colors, fontPair: 'inter-lora' });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      // parseOr400 hands `.flatten()` straight to the admin, whose Marca tab
      // keys per-field messages off fieldErrors — a root-level-only error
      // (what a z.union would produce here) would collapse every theme
      // validation failure into the generic alert.
      const { fieldErrors } = parsed.error.flatten();
      expect(fieldErrors.radius?.length).toBeGreaterThan(0);
      expect(fieldErrors.colors).toBeUndefined();
    }
  });

  it('rejects a flat body with an invalid hex colour, keyed by `colors`', () => {
    const parsed = themeSchema.safeParse({ ...LEGACY_THEME, colors: { ...LEGACY_THEME.colors, primary: 'rojo' } });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.flatten().fieldErrors.colors?.length).toBeGreaterThan(0);
  });

  it('rejects overrides sent without a presetId', () => {
    const parsed = themeSchema.safeParse({ ...LEGACY_THEME, overrides: { radius: 'lg' } });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.flatten().fieldErrors.overrides?.length).toBeGreaterThan(0);
  });

  it('rejects a body that mixes a presetId with flat tokens rather than silently picking a winner', () => {
    const parsed = themeSchema.safeParse({ presetId: 'vitrina', ...LEGACY_THEME });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const { fieldErrors } = parsed.error.flatten();
      expect(fieldErrors.colors?.length).toBeGreaterThan(0);
      expect(fieldErrors.fontPair?.length).toBeGreaterThan(0);
      expect(fieldErrors.radius?.length).toBeGreaterThan(0);
    }
  });

  it('rejects a non-sparse-shaped override value (a bad hex inside overrides)', () => {
    expect(themeSchema.safeParse({ presetId: 'vitrina', overrides: { colors: { primary: '#fff' } } }).success).toBe(false);
  });
});

describe('resolveTheme — backwards compatibility', () => {
  // THE backwards-compatibility proof. Every tenant that exists today has a
  // blob in this shape and no presetId; `GET /v1/tenant` now returns
  // `resolveTheme(blob).tokens` instead of the blob, so if these two ever
  // stopped being equal, every existing storefront would re-skin itself.
  it('returns a pre-preset flat blob completely unchanged, with no preset attached', () => {
    const resolved = resolveTheme(LEGACY_THEME);
    expect(resolved.presetId).toBeNull();
    expect(resolved.tokens).toEqual(LEGACY_THEME);
  });

  it('preserves logoUrl and faviconUrl on a pre-preset blob', () => {
    const stored = { ...LEGACY_THEME, logoUrl: 'https://cdn.example.co/l.png', faviconUrl: 'https://cdn.example.co/f.png' };
    expect(resolveTheme(stored).tokens).toEqual(stored);
  });

  it('resolves every font pair and radius a legacy tenant could have saved, untouched', () => {
    for (const fontPair of FONT_PAIRS) {
      for (const radius of RADIUS_OPTIONS) {
        const stored = { ...LEGACY_THEME, fontPair, radius };
        expect(resolveTheme(stored).tokens).toEqual(stored);
      }
    }
  });

  it('falls back to the neutral tokens for a tenant with no theme at all', () => {
    for (const stored of [null, undefined, {}, 'not-an-object', []]) {
      const resolved = resolveTheme(stored);
      expect(resolved.presetId).toBeNull();
      expect(resolved.tokens).toEqual(FALLBACK_THEME_TOKENS);
    }
  });

  it('degrades field-by-field on a corrupt blob instead of throwing', () => {
    const resolved = resolveTheme({
      colors: { primary: 'not-a-colour', background: '#000000' },
      fontPair: 'comic-sans',
      radius: 'gigantic',
    });
    expect(resolved.tokens.colors.primary).toBe(FALLBACK_THEME_TOKENS.colors.primary);
    expect(resolved.tokens.colors.background).toBe('#000000');
    expect(resolved.tokens.colors.foreground).toBe(FALLBACK_THEME_TOKENS.colors.foreground);
    expect(resolved.tokens.fontPair).toBe(FALLBACK_THEME_TOKENS.fontPair);
    expect(resolved.tokens.radius).toBe(FALLBACK_THEME_TOKENS.radius);
  });

  it('drops an empty logoUrl/faviconUrl rather than persisting a value the PUT would reject', () => {
    const resolved = resolveTheme({ ...LEGACY_THEME, logoUrl: '', faviconUrl: '' });
    expect(resolved.tokens).not.toHaveProperty('logoUrl');
    expect(resolved.tokens).not.toHaveProperty('faviconUrl');
  });
});

describe('resolveTheme — presets and overrides', () => {
  it('resolves a bare preset to exactly that preset tokens', () => {
    for (const id of THEME_PRESET_IDS) {
      const resolved = resolveTheme({ presetId: id });
      expect(resolved.presetId).toBe(id);
      expect(resolved.tokens).toEqual(THEME_PRESETS[id].tokens);
    }
  });

  it('applies only the overridden token and keeps tracking the preset for the rest', () => {
    // The whole reason overrides are stored sparsely: this merchant chose
    // Vitrina and darkened one colour. Every OTHER token must still read
    // through to THEME_PRESETS, so improving Vitrina later reaches them.
    const resolved = resolveTheme({ presetId: 'vitrina', overrides: { colors: { primary: '#ff0000' } } });
    expect(resolved.presetId).toBe('vitrina');
    expect(resolved.tokens.colors.primary).toBe('#ff0000');
    expect(resolved.tokens.colors.background).toBe(THEME_PRESETS.vitrina.tokens.colors.background);
    expect(resolved.tokens.colors.foreground).toBe(THEME_PRESETS.vitrina.tokens.colors.foreground);
    expect(resolved.tokens.fontPair).toBe(THEME_PRESETS.vitrina.tokens.fontPair);
    expect(resolved.tokens.radius).toBe(THEME_PRESETS.vitrina.tokens.radius);
  });

  it('applies fontPair and radius overrides', () => {
    const resolved = resolveTheme({ presetId: 'catalogo', overrides: { fontPair: 'poppins-source', radius: 'full' } });
    expect(resolved.tokens.fontPair).toBe('poppins-source');
    expect(resolved.tokens.radius).toBe('full');
    expect(resolved.tokens.colors).toEqual(THEME_PRESETS.catalogo.tokens.colors);
  });

  it('keeps the merchant assets, which no preset supplies', () => {
    const resolved = resolveTheme({ presetId: 'boutique', logoUrl: 'https://cdn.example.co/l.png' });
    expect(resolved.tokens.logoUrl).toBe('https://cdn.example.co/l.png');
    expect(resolved.tokens.colors).toEqual(THEME_PRESETS.boutique.tokens.colors);
  });

  it('ignores flat tokens sitting alongside a presetId — only overrides win', () => {
    // Such a blob cannot be written through `themeSchema` (it is a 400), but
    // the column is free-form JSON. The preset must win over the stray flat
    // keys, otherwise a hand-edited row would pin the tenant to a frozen copy
    // of the preset without anyone noticing.
    const resolved = resolveTheme({ presetId: 'mercado', ...LEGACY_THEME });
    expect(resolved.tokens.colors).toEqual(THEME_PRESETS.mercado.tokens.colors);
    expect(resolved.tokens.fontPair).toBe(THEME_PRESETS.mercado.tokens.fontPair);
  });

  it('treats an unknown presetId as a custom theme rather than guessing a preset', () => {
    const resolved = resolveTheme({ presetId: 'ferreteria', ...LEGACY_THEME });
    expect(resolved.presetId).toBeNull();
    expect(resolved.tokens).toEqual(LEGACY_THEME);
  });

  it('ignores a corrupt override value and falls back to the preset, not to the neutral tokens', () => {
    const resolved = resolveTheme({ presetId: 'taller', overrides: { fontPair: 'comic-sans', radius: 'gigantic' } });
    expect(resolved.tokens.fontPair).toBe(THEME_PRESETS.taller.tokens.fontPair);
    expect(resolved.tokens.radius).toBe(THEME_PRESETS.taller.tokens.radius);
  });
});
