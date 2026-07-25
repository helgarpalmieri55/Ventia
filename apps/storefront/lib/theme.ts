import type { FontPair } from '@ventia/core';

/** A tenant's saved storefront theme (spec §5.4), as stored on `Tenant.theme`
 * (a nullable JSON column — see `packages/db/prisma/schema.prisma`) and
 * exposed by `GET /v1/tenant`'s `theme` field. Draft tenants that haven't
 * saved any branding yet have `theme: null`. `fontPair` stays `string` (not
 * `FontPair`) here — like the rest of this interface, it describes whatever
 * shape the admin-controlled JSON blob happens to have, unvalidated at this
 * layer (see `layout.tsx`'s cast comment); `fontPairVars` below is what
 * actually validates it against the fixed catalog. */
export interface TenantTheme {
  colors: { primary: string; background: string; foreground: string };
  fontPair: string;
  radius: 'none' | 'sm' | 'md' | 'lg' | 'full';
  logoUrl?: string;
  faviconUrl?: string;
}

const RADIUS_REM: Record<TenantTheme['radius'], string> = {
  none: '0px',
  sm: '0.25rem',
  md: '0.5rem',
  lg: '1rem',
  full: '9999px',
};

// Neutral defaults for a draft tenant with no branding saved yet — matches
// `@ventia/ui/styles.css`'s own `:root` fallbacks so an un-themed storefront
// still renders with the shared design system's stock look. `fontPair` here
// must stay in sync with `DEFAULT_FONT_PAIR` below (both `'inter-lora'`,
// `@ventia/core`/`apps/admin/lib/theme-form.ts`'s shared default).
const DEFAULT_THEME: TenantTheme = {
  colors: { primary: '#4f46e5', background: '#ffffff', foreground: '#111827' },
  fontPair: 'inter-lora',
  radius: 'md',
};

/** Maps each of the fixed 5-pair font catalog (spec §5.4, `@ventia/core`'s
 * `FONT_PAIRS`) to the two `next/font/google` `variable` CSS custom-property
 * names (`lib/fonts.ts`) that pair's heading/body fonts were loaded under.
 * All 5 pairs' fonts are loaded at build time regardless of any one tenant's
 * choice (`next/font/google` requires its calls at module scope, not
 * conditionally per-request) — this table is what actually selects the
 * active pair, per request, via `--font-heading`/`--font-body`. */
const FONT_PAIR_VARS: Record<FontPair, { heading: string; body: string }> = {
  'inter-lora': { heading: 'var(--font-inter)', body: 'var(--font-lora)' },
  'poppins-source': { heading: 'var(--font-poppins)', body: 'var(--font-source-serif-4)' },
  'montserrat-merriweather': { heading: 'var(--font-montserrat)', body: 'var(--font-merriweather)' },
  'raleway-open': { heading: 'var(--font-raleway)', body: 'var(--font-open-sans)' },
  'worksans-bitter': { heading: 'var(--font-work-sans)', body: 'var(--font-bitter)' },
};

const DEFAULT_FONT_PAIR: FontPair = 'inter-lora';

function isFontPair(value: string): value is FontPair {
  return Object.prototype.hasOwnProperty.call(FONT_PAIR_VARS, value);
}

/** Maps a tenant's saved `fontPair` (an unvalidated string off the admin
 * JSON blob — see `TenantTheme`'s doc comment) to its heading/body CSS
 * variable references. Falls back to the default pair (`inter-lora`, same
 * default `@ventia/core`/`apps/admin/lib/theme-form.ts` use) whenever the
 * value is missing or isn't one of the 5 valid pairs, rather than throwing —
 * a malformed or since-removed pair value degrades to the default look
 * instead of breaking the whole page. */
export function fontPairVars(fontPair: string): { heading: string; body: string } {
  return FONT_PAIR_VARS[isFontPair(fontPair) ? fontPair : DEFAULT_FONT_PAIR];
}

/** Maps a tenant's saved theme (or the neutral defaults, when `null`) to the
 * CSS custom-property names `@ventia/ui/styles.css` already declares at
 * `:root` (`--color-primary`/`--color-background`/`--color-foreground`/
 * `--radius`), plus `--font-heading`/`--font-body` ({@link fontPairVars}) —
 * the caller applies the result as an inline `style` on `<html>`, which
 * overrides those `:root` defaults for this one tenant's render without
 * needing a per-tenant stylesheet. */
export function buildThemeVars(theme: TenantTheme | null): Record<string, string> {
  const t = theme ?? DEFAULT_THEME;
  const fonts = fontPairVars(t.fontPair);
  return {
    '--color-primary': t.colors.primary,
    '--color-background': t.colors.background,
    '--color-foreground': t.colors.foreground,
    '--radius': RADIUS_REM[t.radius],
    '--font-heading': fonts.heading,
    '--font-body': fonts.body,
  };
}
