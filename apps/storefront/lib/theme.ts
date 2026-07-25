/** A tenant's saved storefront theme (spec §5.4), as stored on `Tenant.theme`
 * (a nullable JSON column — see `packages/db/prisma/schema.prisma`) and
 * exposed by `GET /v1/tenant`'s `theme` field. Draft tenants that haven't
 * saved any branding yet have `theme: null`. */
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
// still renders with the shared design system's stock look.
const DEFAULT_THEME: TenantTheme = {
  colors: { primary: '#4f46e5', background: '#ffffff', foreground: '#111827' },
  fontPair: 'inter-lora',
  radius: 'md',
};

/** Maps a tenant's saved theme (or the neutral defaults, when `null`) to the
 * CSS custom-property names `@ventia/ui/styles.css` already declares at
 * `:root` (`--color-primary`/`--color-background`/`--color-foreground`/
 * `--radius`) — the caller applies the result as an inline `style` on
 * `<html>`, which overrides those `:root` defaults for this one tenant's
 * render without needing a per-tenant stylesheet. */
export function buildThemeVars(theme: TenantTheme | null): Record<string, string> {
  const t = theme ?? DEFAULT_THEME;
  return {
    '--color-primary': t.colors.primary,
    '--color-background': t.colors.background,
    '--color-foreground': t.colors.foreground,
    '--radius': RADIUS_REM[t.radius],
  };
}
