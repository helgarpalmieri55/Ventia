import { FONT_PAIRS, RADIUS_OPTIONS, type FontPair, type Radius } from '@ventia/core';

/** The branding step's form fields — a flattened, always-fully-populated
 * shape derived from `@ventia/core`'s `ThemeInput` (whose `colors` is nested
 * and whose `logoUrl` is optional), so the step's `useState` calls never deal
 * with partial/nested data. */
export interface ThemeFormState {
  primary: string;
  background: string;
  foreground: string;
  fontPair: FontPair;
  radius: Radius;
  logoUrl: string;
}

/** Same defaults the branding step always rendered before this fix — used
 * both as the fallback for a brand-new tenant (whose `theme` column is still
 * `{}`) and for any field a saved theme is missing or has an invalid value
 * for, so a malformed record degrades field-by-field rather than blanking
 * the whole form. */
export const DEFAULT_THEME_FORM: ThemeFormState = {
  primary: '#4f46e5',
  background: '#ffffff',
  foreground: '#111827',
  fontPair: FONT_PAIRS[0],
  radius: 'md',
  logoUrl: '',
};

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX_COLOR.test(value);
}

function isFontPair(value: unknown): value is FontPair {
  return typeof value === 'string' && (FONT_PAIRS as readonly string[]).includes(value);
}

function isRadius(value: unknown): value is Radius {
  return typeof value === 'string' && (RADIUS_OPTIONS as readonly string[]).includes(value);
}

/** Maps `GET /v1/admin/settings`'s `theme` (a `Record<string, unknown>` —
 * `{}` for a tenant that has never called `PUT /settings/theme`, otherwise
 * whatever that PUT last stored) to the branding step's form state.
 *
 * This is the fix for the "revisit destroys the saved theme" bug: the step
 * used to always start from {@link DEFAULT_THEME_FORM} regardless of what
 * was already saved, so clicking "Continuar" on a revisit re-PUT the
 * defaults over the merchant's real theme (`PUT /settings/theme` is a full
 * replace, not a merge). Called once, on mount, with the fetched theme.
 *
 * Falls back to {@link DEFAULT_THEME_FORM} (as a whole, or field-by-field)
 * whenever `theme` is absent, empty, or has a missing/invalid field —
 * matching `themeSchema`'s validation so the form never gets stuck holding a
 * value the PUT would reject. */
export function themeToFormState(theme?: Record<string, unknown> | null): ThemeFormState {
  if (!theme || Object.keys(theme).length === 0) return DEFAULT_THEME_FORM;

  const colors = theme.colors && typeof theme.colors === 'object' ? (theme.colors as Record<string, unknown>) : {};

  return {
    primary: isHexColor(colors.primary) ? colors.primary : DEFAULT_THEME_FORM.primary,
    background: isHexColor(colors.background) ? colors.background : DEFAULT_THEME_FORM.background,
    foreground: isHexColor(colors.foreground) ? colors.foreground : DEFAULT_THEME_FORM.foreground,
    fontPair: isFontPair(theme.fontPair) ? theme.fontPair : DEFAULT_THEME_FORM.fontPair,
    radius: isRadius(theme.radius) ? theme.radius : DEFAULT_THEME_FORM.radius,
    logoUrl: typeof theme.logoUrl === 'string' ? theme.logoUrl : DEFAULT_THEME_FORM.logoUrl,
  };
}
