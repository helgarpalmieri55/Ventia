import { z } from 'zod';

/** Fixed catalog of 5 font pairings (spec §5.4) — storefront theming does not
 * allow arbitrary font selection, only one of these curated pairs. Moved here
 * from settings-schemas.ts (with `RADIUS_OPTIONS`, the hex-colour rule and
 * `themeSchema`) when presets arrived: every one of them is now read by
 * {@link THEME_PRESETS} and {@link resolveTheme} as well as by the schema, and
 * splitting "what a theme is" across two modules is how the resolver and the
 * catalog drift apart. Nothing outside this package imported them by path —
 * everyone goes through the `@ventia/core` barrel — so the move is invisible
 * to consumers. */
export const FONT_PAIRS = [
  'inter-lora',
  'poppins-source',
  'montserrat-merriweather',
  'raleway-open',
  'worksans-bitter',
] as const;
export type FontPair = (typeof FONT_PAIRS)[number];

export const RADIUS_OPTIONS = ['none', 'sm', 'md', 'lg', 'full'] as const;
export type Radius = (typeof RADIUS_OPTIONS)[number];

const hexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export interface ThemeColors {
  primary: string;
  background: string;
  foreground: string;
}

/** The token set the storefront actually renders from — every CSS custom
 * property `apps/storefront/lib/theme.ts`'s `buildThemeVars` emits comes from
 * exactly these three fields. A preset is nothing more than a named, complete
 * instance of this. */
export interface ThemeTokens {
  colors: ThemeColors;
  fontPair: FontPair;
  radius: Radius;
}

/** {@link ThemeTokens} plus the two per-tenant assets that are NOT part of any
 * preset (a preset can't ship somebody else's logo). Deliberately identical in
 * shape to the flat JSON blob `Tenant.theme` has always held, because that is
 * what `GET /v1/tenant` returns and what the storefront has always consumed —
 * see {@link resolveTheme}. */
export interface ResolvedThemeTokens extends ThemeTokens {
  logoUrl?: string;
  faviconUrl?: string;
}

/**
 * The token set a tenant renders with when nothing usable is stored — a draft
 * tenant, or a `theme` blob whose fields are missing/corrupt.
 *
 * These exact values were already written out by hand in two places —
 * `apps/storefront/lib/theme.ts` (`DEFAULT_THEME`) and
 * `apps/admin/lib/theme-form.ts` (`DEFAULT_THEME_FORM`) — each carrying a
 * comment telling the next person to keep the other copy in sync. Now that a
 * resolver exists, the fallback belongs next to it: an un-themed storefront
 * and the admin form that edits it must agree on what "no theme" looks like,
 * or the merchant sees one thing in the panel and shoppers see another. The
 * admin now derives its copy from this one; the storefront's `DEFAULT_THEME`
 * is still its own literal, because that module is only reached with `null`
 * (`GET /v1/tenant` resolves everything else) and rewiring it was outside
 * this change — it is the remaining copy to fold in, and it must keep
 * matching these values until someone does.
 *
 * NOT one of the presets, on purpose: it is the neutral stock look of
 * `@ventia/ui/styles.css`'s own `:root`, which is what a tenant who never
 * answered "¿qué vendes?" should get. Changing it re-skins every tenant that
 * has never saved a theme, so treat it as the platform's default look rather
 * than a spare slot.
 */
export const FALLBACK_THEME_TOKENS: ThemeTokens = {
  colors: { primary: '#4f46e5', background: '#ffffff', foreground: '#111827' },
  fontPair: 'inter-lora',
  radius: 'md',
};

export const THEME_PRESET_IDS = ['vitrina', 'catalogo', 'taller', 'mercado', 'boutique'] as const;
export type ThemePresetId = (typeof THEME_PRESET_IDS)[number];

/**
 * One of the finished looks a merchant picks from (product.md §4, "Dirección
 * 2 — Presets completos").
 *
 * `sells` is the load-bearing field for the product decision, not `label`:
 * the preset is chosen during onboarding by answering "¿qué vendes?", which a
 * merchant can answer, instead of "¿qué color te gusta?", which they cannot.
 * The look is a consequence of the answer.
 */
export interface ThemePreset {
  id: ThemePresetId;
  /** es-CO name of the look, shown as the option label. */
  label: string;
  /** es-CO answer to "¿qué vendes?" this preset is the house pick for. */
  sells: string;
  /** es-CO one-liner describing the look, for the picker's helper text. */
  description: string;
  /** The complete token set. Every field required — a preset that leaves a
   * token unset would silently inherit whatever the merchant had before,
   * which is the opposite of "picking a finished look". */
  tokens: ThemeTokens;
}

/**
 * The five presets, aimed at what small Colombian retail actually sells.
 *
 * ## Why these five, and why only tokens
 *
 * product.md §4 describes presets that also choose home layout, image
 * treatment and scale. This module deliberately stops at tokens: everything
 * here must be expressible through the CSS custom properties the storefront
 * *already* emits (`--color-primary` / `--color-background` /
 * `--color-foreground` / `--radius` / `--font-heading` / `--font-body`). A
 * preset that promised a layout the renderer cannot produce would be a
 * setting the merchant can change with no visible effect — worse than not
 * offering it. The structural half of Dirección 2 lands when the storefront
 * grows the layouts to back it; the stored shape here (`presetId` +
 * overrides) is already the shape that will carry it.
 *
 * Each preset uses a different font pair and a different corner radius, so
 * two stores on different presets never read as siblings — which is the
 * complaint (§4: "Dos comercios del mismo rubro se ven como hermanos") the
 * whole direction exists to answer. That one-of-each property is asserted in
 * the tests: it is a design constraint, not a coincidence to be quietly
 * broken by the sixth preset.
 */
export const THEME_PRESETS: Record<ThemePresetId, ThemePreset> = {
  vitrina: {
    id: 'vitrina',
    label: 'Vitrina',
    sells: 'Ropa, calzado y accesorios',
    description: 'Blanco, negro y esquinas rectas. La foto manda y el texto se aparta.',
    tokens: {
      colors: { primary: '#111111', background: '#ffffff', foreground: '#1a1a1a' },
      fontPair: 'raleway-open',
      radius: 'none',
    },
  },
  catalogo: {
    id: 'catalogo',
    label: 'Catálogo',
    sells: 'Tecnología, repuestos y ferretería',
    description: 'Azul de confianza sobre gris claro. Muchas referencias por pantalla sin cansar la vista.',
    tokens: {
      colors: { primary: '#1d4ed8', background: '#f8fafc', foreground: '#0f172a' },
      fontPair: 'inter-lora',
      radius: 'sm',
    },
  },
  taller: {
    id: 'taller',
    label: 'Taller',
    sells: 'Hogar, decoración y artesanía',
    description: 'Terracota sobre fondo cálido y bordes suaves, para producto hecho a mano con historia.',
    tokens: {
      colors: { primary: '#b45309', background: '#fffaf3', foreground: '#3f2d20' },
      fontPair: 'montserrat-merriweather',
      radius: 'lg',
    },
  },
  mercado: {
    id: 'mercado',
    label: 'Mercado',
    sells: 'Alimentos, mercado y domicilios',
    description: 'Verde fresco y botones redondos: se lee rápido en el celular y se pide sin pensarlo.',
    tokens: {
      colors: { primary: '#15803d', background: '#ffffff', foreground: '#14261a' },
      fontPair: 'worksans-bitter',
      radius: 'full',
    },
  },
  boutique: {
    id: 'boutique',
    label: 'Boutique',
    sells: 'Belleza y cuidado personal',
    description: 'Rosa profundo sobre crema, con aire alrededor de cada producto.',
    tokens: {
      colors: { primary: '#be185d', background: '#fdf6f8', foreground: '#3b2430' },
      fontPair: 'poppins-source',
      radius: 'md',
    },
  },
};

/** The merchant's tweaks on top of a preset. Every field optional and
 * SPARSE-BY-CONTRACT: only tokens the merchant actually changed may appear.
 *
 * This is the whole point of the preset/override split. If a merchant who
 * picked *Vitrina* and darkened one colour stored a full token bag, they
 * would be indistinguishable from a merchant who hand-set all five values,
 * and improving *Vitrina* later (a better font pairing, a warmer white) would
 * either skip everyone who ever touched a colour or overwrite choices they
 * made deliberately. Storing only the delta means a preset change reaches
 * every tenant on that preset, in exactly the tokens they never touched. */
export const themeOverridesSchema = z.object({
  colors: z
    .object({
      primary: hexColorSchema.optional(),
      background: hexColorSchema.optional(),
      foreground: hexColorSchema.optional(),
    })
    .optional(),
  fontPair: z.enum(FONT_PAIRS).optional(),
  radius: z.enum(RADIUS_OPTIONS).optional(),
});

export type ThemeOverridesInput = z.infer<typeof themeOverridesSchema>;

/**
 * `PUT /v1/admin/settings/theme` body, and therefore the shape of
 * `Tenant.theme`. Still a PUT, not a PATCH: the caller replaces the column
 * wholesale, so a preset-based body must carry every override it wants kept.
 *
 * ## The two accepted shapes
 *
 * 1. **Preset** — `{ presetId, overrides?, logoUrl?, faviconUrl? }`. The look
 *    is {@link THEME_PRESETS}`[presetId]`, with `overrides` applied on top.
 * 2. **Custom** — `{ colors, fontPair, radius, logoUrl?, faviconUrl? }`. The
 *    flat token bag, byte-for-byte the only shape this endpoint accepted
 *    before presets existed. Every tenant created so far has one of these
 *    stored, and every one of them must keep parsing, keep saving and keep
 *    rendering identically — see {@link resolveTheme}.
 *
 * ## Why one object with a refinement, not a `z.union`
 *
 * A union reports failures as a root-level `invalid_union` issue, so
 * `ZodError.flatten().fieldErrors` comes back empty — and `parseOr400`
 * (services/api) hands exactly that flattened object to the admin, whose Marca
 * tab keys its per-field messages off `fieldErrors.logoUrl` / `fieldErrors.
 * colors`. Going union would have silently downgraded every theme validation
 * error to the generic "Revisa los campos marcados." alert. Keeping one object
 * and enforcing the shape in `superRefine` preserves the per-field paths.
 *
 * ## Why mixing the two shapes is rejected rather than merged
 *
 * A body carrying both `presetId` and flat `colors` has two answers to "where
 * does primary come from", and any silent winner is a footgun: pick the flat
 * value and the merchant is stuck on a frozen copy of the preset (the exact
 * failure the split exists to prevent); pick the preset and their explicit
 * colour vanishes. It is a caller bug, so it gets a 400 naming the field.
 */
export const themeSchema = z
  .object({
    presetId: z.enum(THEME_PRESET_IDS).optional(),
    overrides: themeOverridesSchema.optional(),
    colors: z
      .object({
        primary: hexColorSchema,
        background: hexColorSchema,
        foreground: hexColorSchema,
      })
      .optional(),
    fontPair: z.enum(FONT_PAIRS).optional(),
    radius: z.enum(RADIUS_OPTIONS).optional(),
    logoUrl: z.string().url().optional(),
    faviconUrl: z.string().url().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.presetId === undefined) {
      // Custom theme: the pre-preset contract, unchanged. The three token
      // fields stay REQUIRED (with their own paths, so the admin still gets
      // `fieldErrors.colors`) — the storefront has no partial-theme concept.
      for (const field of ['colors', 'fontPair', 'radius'] as const) {
        if (value[field] === undefined) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: 'Required' });
        }
      }
      if (value.overrides !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['overrides'],
          message: 'overrides requires presetId',
        });
      }
      return;
    }
    for (const field of ['colors', 'fontPair', 'radius'] as const) {
      if (value[field] !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `${field} cannot be sent with presetId — use overrides.${field}`,
        });
      }
    }
  });

export type ThemeInput = z.infer<typeof themeSchema>;

/** What {@link resolveTheme} produces: the tokens to render with, plus which
 * preset (if any) they came from. Kept as two fields rather than one merged
 * bag so callers that only render (`GET /v1/tenant`) can hand out `tokens`
 * alone — a payload deep-equal to what a pre-preset tenant has always
 * received — while callers that also *edit* (the admin's Marca tab) can still
 * tell "chose Vitrina and darkened one colour" from "hand-set five values". */
export interface ResolvedTheme {
  /** `null` means the tokens were hand-set (a custom theme, or a legacy blob
   * saved before presets existed) — NOT that resolution failed. */
  presetId: ThemePresetId | null;
  tokens: ResolvedThemeTokens;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value);
}

function isFontPair(value: unknown): value is FontPair {
  return typeof value === 'string' && (FONT_PAIRS as readonly string[]).includes(value);
}

function isRadius(value: unknown): value is Radius {
  return typeof value === 'string' && (RADIUS_OPTIONS as readonly string[]).includes(value);
}

function isThemePresetId(value: unknown): value is ThemePresetId {
  return typeof value === 'string' && (THEME_PRESET_IDS as readonly string[]).includes(value);
}

/**
 * THE resolver: `Tenant.theme` (whatever JSON is actually in the column) to
 * the final token set. Every reader goes through this — `GET /v1/tenant`, so
 * the storefront never has to know presets exist, and the admin's Marca tab,
 * so the values a merchant sees in the panel are the values shoppers get. Two
 * resolvers would drift the moment one of them learned about a new token.
 *
 * ## Why it never throws and never rejects
 *
 * The column is a free-form JSON blob written by more than the validated PUT
 * (seeds, fixtures, and four years of whatever future migrations do). A theme
 * is decoration: the correct response to a corrupt one is a plain-looking
 * store, not a 500 on the storefront's own bootstrap request. So every field
 * degrades independently to the preset's value, or to
 * {@link FALLBACK_THEME_TOKENS} when there is no preset.
 *
 * ## The backwards-compatibility contract
 *
 * For a blob in the pre-preset flat shape — which is what EVERY tenant
 * currently has — `resolveTheme(blob).tokens` deep-equals `blob`. No preset
 * is applied, no value is substituted, nothing is added. That is asserted
 * directly in the tests; it is the reason `/v1/tenant` could start returning
 * resolved tokens without the storefront changing a line, and the reason
 * existing tenants keep rendering exactly as they do today.
 *
 * `logoUrl`/`faviconUrl` are read from the top level in BOTH shapes and never
 * from a preset or from `overrides`: they are the merchant's own assets, not
 * a token any look can supply. Empty strings are dropped rather than passed
 * through, because the admin form uses `''` for "not set" and a round trip
 * through it must not persist a `logoUrl: ""` the URL validation would then
 * reject on the next save.
 */
export function resolveTheme(stored: unknown): ResolvedTheme {
  const theme = asRecord(stored);
  const presetId = isThemePresetId(theme.presetId) ? theme.presetId : null;
  const base = presetId ? THEME_PRESETS[presetId].tokens : FALLBACK_THEME_TOKENS;
  // The layer that wins over `base`. For a preset theme that is `overrides`
  // (sparse by contract); for a custom/legacy one it is the blob itself,
  // whose flat token fields sit at the top level. Same merge either way, so
  // there is exactly one set of degradation rules to reason about.
  const layer = asRecord(presetId ? theme.overrides : theme);
  const layerColors = asRecord(layer.colors);

  return {
    presetId,
    tokens: {
      colors: {
        primary: isHexColor(layerColors.primary) ? layerColors.primary : base.colors.primary,
        background: isHexColor(layerColors.background) ? layerColors.background : base.colors.background,
        foreground: isHexColor(layerColors.foreground) ? layerColors.foreground : base.colors.foreground,
      },
      fontPair: isFontPair(layer.fontPair) ? layer.fontPair : base.fontPair,
      radius: isRadius(layer.radius) ? layer.radius : base.radius,
      ...(typeof theme.logoUrl === 'string' && theme.logoUrl !== '' ? { logoUrl: theme.logoUrl } : {}),
      ...(typeof theme.faviconUrl === 'string' && theme.faviconUrl !== '' ? { faviconUrl: theme.faviconUrl } : {}),
    },
  };
}
