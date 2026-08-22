import {
  FALLBACK_THEME_TOKENS,
  THEME_PRESETS,
  THEME_PRESET_IDS,
  resolveTheme,
  type FontPair,
  type Radius,
  type ThemeInput,
  type ThemePresetId,
} from '@ventia/core';

/** The branding step's form fields — a flattened, always-fully-populated
 * shape derived from `@ventia/core`'s `ThemeInput` (whose `colors` is nested,
 * whose tokens may live under `overrides`, and whose `logoUrl`/`faviconUrl`
 * are optional), so the step's `useState` calls never deal with partial or
 * nested data.
 *
 * The colour/font/radius fields always hold the RESOLVED values — what a
 * shopper would actually see — even when the merchant is on a preset and has
 * overridden none of them. That is what makes this form the preset preview:
 * pick *Vitrina* and the colour swatches change to Vitrina's, because they
 * come from the same `resolveTheme` `GET /v1/tenant` serves the storefront
 * with. {@link formStateToThemePayload} is what turns them back into the
 * sparse stored shape. */
export interface ThemeFormState {
  /** Which finished look (product.md §4) the merchant picked, or `null` for
   * "Personalizado" — tokens they set by hand, with no preset behind them.
   * `null` is also what every tenant themed before presets existed reads back
   * as, so the two are the same case by design: an old flat theme IS a custom
   * one, and neither gets silently adopted into a preset. */
  presetId: ThemePresetId | null;
  primary: string;
  background: string;
  foreground: string;
  fontPair: FontPair;
  radius: Radius;
  logoUrl: string;
  faviconUrl: string;
}

/** The neutral look a brand-new tenant (whose `theme` column is still `{}`)
 * starts from — the platform default, not a preset, so a merchant who never
 * answers "¿qué vendes?" is not silently filed under one. The token values
 * are `@ventia/core`'s `FALLBACK_THEME_TOKENS`, the single copy the
 * storefront's un-themed render uses too; they used to be hand-duplicated
 * here and in `apps/storefront/lib/theme.ts`, each with a comment asking the
 * next person to keep the other in sync. */
export const DEFAULT_THEME_FORM: ThemeFormState = {
  presetId: null,
  primary: FALLBACK_THEME_TOKENS.colors.primary,
  background: FALLBACK_THEME_TOKENS.colors.background,
  foreground: FALLBACK_THEME_TOKENS.colors.foreground,
  fontPair: FALLBACK_THEME_TOKENS.fontPair,
  radius: FALLBACK_THEME_TOKENS.radius,
  logoUrl: '',
  faviconUrl: '',
};

/** The `<Select>` value that means "no preset". `''` rather than a sentinel
 * id, so it can never collide with a real `ThemePresetId` — and so adding a
 * preset called `custom` later would not silently become the escape hatch. */
export const CUSTOM_PRESET_VALUE = '';

/** es-CO label for the no-preset option. Deliberately says what it costs: a
 * merchant on "Personalizado" stops receiving preset improvements, which is
 * invisible unless the option says so. */
export const CUSTOM_PRESET_LABEL = 'Personalizado (sin preset)';

/** The presets in picker order, resolved from `@ventia/core` rather than
 * re-listed here — a preset that exists in core but not in this array would
 * be unreachable from the panel, and one listed here but not in core would
 * be a 400 on save. */
export const THEME_PRESET_OPTIONS = THEME_PRESET_IDS.map((id) => THEME_PRESETS[id]);

/** Display labels for `@ventia/core`'s fixed 5-pair font catalog — shared by
 * the onboarding wizard's branding step and the configuración page's Marca
 * tab (Task 7), so both theme forms show identical es-CO copy for the same
 * fixed set of options rather than maintaining two copies. The option
 * values themselves come from `@ventia/core` so neither form can drift from
 * what `themeSchema` actually accepts. */
export const FONT_PAIR_LABELS: Record<FontPair, string> = {
  'inter-lora': 'Inter + Lora',
  'poppins-source': 'Poppins + Source Serif',
  'montserrat-merriweather': 'Montserrat + Merriweather',
  'raleway-open': 'Raleway + Open Sans',
  'worksans-bitter': 'Work Sans + Bitter',
};

/** Display labels for `@ventia/core`'s fixed radius scale — same sharing
 * rationale as {@link FONT_PAIR_LABELS}. */
export const RADIUS_LABELS: Record<Radius, string> = {
  none: 'Sin bordes redondeados',
  sm: 'Pequeño',
  md: 'Mediano',
  lg: 'Grande',
  full: 'Circular',
};

function isThemePresetId(value: string): value is ThemePresetId {
  return (THEME_PRESET_IDS as readonly string[]).includes(value);
}

/** Maps a `<Select>` value back to the form's `presetId`. `''` (and anything
 * else unrecognised — a stale option from an older deploy) means custom. */
export function presetIdFromSelectValue(value: string): ThemePresetId | null {
  return isThemePresetId(value) ? value : null;
}

/** Maps `GET /v1/admin/settings`'s `theme` (a `Record<string, unknown>` —
 * `{}` for a tenant that has never called `PUT /settings/theme`, otherwise
 * whatever that PUT last stored, in either the preset or the flat shape) to
 * the branding step's form state.
 *
 * This is the fix for the "revisit destroys the saved theme" bug: the step
 * used to always start from {@link DEFAULT_THEME_FORM} regardless of what
 * was already saved, so clicking "Continuar" on a revisit re-PUT the
 * defaults over the merchant's real theme (`PUT /settings/theme` is a full
 * replace, not a merge). Called once, on mount, with the fetched theme.
 *
 * The token fields come from `@ventia/core`'s `resolveTheme` — the same
 * single resolver `GET /v1/tenant` runs for the storefront — so the swatches
 * in the panel are what shoppers see, and an unrecognisable or half-written
 * blob degrades field-by-field (to the preset's value, or to the neutral
 * default) instead of blanking the form or getting the merchant stuck holding
 * a value the PUT would reject. */
export function themeToFormState(theme?: Record<string, unknown> | null): ThemeFormState {
  const { presetId, tokens } = resolveTheme(theme);
  return {
    presetId,
    primary: tokens.colors.primary,
    background: tokens.colors.background,
    foreground: tokens.colors.foreground,
    fontPair: tokens.fontPair,
    radius: tokens.radius,
    logoUrl: tokens.logoUrl ?? '',
    faviconUrl: tokens.faviconUrl ?? '',
  };
}

/** Switches the form to `presetId`, snapping every token to that preset's
 * look — this IS the preview: the merchant picks "Ropa, calzado y accesorios"
 * and immediately sees Vitrina's colours, font and corners in the same form.
 *
 * Deliberately discards the previous tokens rather than keeping them as
 * overrides on the new preset. Carrying them across would mean picking a
 * preset changed nothing visible (every token overridden on arrival), which
 * is the opposite of choosing a finished look — and would quietly pin the
 * merchant outside future improvements to it. `logoUrl`/`faviconUrl` DO
 * survive: they are the merchant's own assets, which no preset supplies.
 *
 * Passing `null` switches to "Personalizado" and keeps the tokens exactly as
 * they are on screen, so the merchant's starting point for hand-editing is
 * the look they were just on, not a jarring reset. */
export function applyPresetToFormState(state: ThemeFormState, presetId: ThemePresetId | null): ThemeFormState {
  if (presetId === null) return { ...state, presetId: null };
  const { colors, fontPair, radius } = THEME_PRESETS[presetId].tokens;
  return {
    ...state,
    presetId,
    primary: colors.primary,
    background: colors.background,
    foreground: colors.foreground,
    fontPair,
    radius,
  };
}

/** Builds the `PUT /v1/admin/settings/theme` body from the form.
 *
 * Two shapes, matching `themeSchema`:
 *
 * - **No preset** — the flat token bag, byte-for-byte what this form has
 *   always sent. A merchant on "Personalizado" keeps working exactly as
 *   before presets existed.
 * - **A preset** — `{presetId}` plus ONLY the tokens whose on-screen value
 *   differs from that preset's. Sending the full token bag instead would be
 *   the bug this whole split exists to prevent: the tenant would be frozen at
 *   a copy of the preset as it looked the day they saved, and improving the
 *   preset later could never reach them without also overwriting the one
 *   colour they deliberately changed.
 *
 * `logoUrl`/`faviconUrl` are omitted when empty rather than sent as `''`:
 * `themeSchema` validates them as absolute URLs, so an empty string is a 400,
 * and "not set" is exactly what an absent key means. */
export function formStateToThemePayload(state: ThemeFormState): ThemeInput {
  const assets = {
    ...(state.logoUrl ? { logoUrl: state.logoUrl } : {}),
    ...(state.faviconUrl ? { faviconUrl: state.faviconUrl } : {}),
  };

  if (state.presetId === null) {
    return {
      colors: { primary: state.primary, background: state.background, foreground: state.foreground },
      fontPair: state.fontPair,
      radius: state.radius,
      ...assets,
    };
  }

  const preset = THEME_PRESETS[state.presetId].tokens;
  const colors = {
    ...(state.primary !== preset.colors.primary ? { primary: state.primary } : {}),
    ...(state.background !== preset.colors.background ? { background: state.background } : {}),
    ...(state.foreground !== preset.colors.foreground ? { foreground: state.foreground } : {}),
  };
  const overrides = {
    ...(Object.keys(colors).length > 0 ? { colors } : {}),
    ...(state.fontPair !== preset.fontPair ? { fontPair: state.fontPair } : {}),
    ...(state.radius !== preset.radius ? { radius: state.radius } : {}),
  };

  return {
    presetId: state.presetId,
    // Omitted entirely, not sent as `{}`, when the merchant tweaked nothing:
    // "chose the preset and left it alone" should read that way in the stored
    // JSON, not as an empty tweak bag someone later has to interpret.
    ...(Object.keys(overrides).length > 0 ? { overrides } : {}),
    ...assets,
  };
}
