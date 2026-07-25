'use client';

import { useState, type FormEvent } from 'react';
import { Alert, Button, Card, CardContent, CardHeader, CardTitle, FormField, Input, Select } from '@ventia/ui';
import { FONT_PAIRS, RADIUS_OPTIONS, type FontPair, type Radius } from '@ventia/core';
import { ApiError, apiFetch } from '../../../../lib/api';
import { errorMessage } from '../../../../lib/errors';
import { themeToFormState } from '../../../../lib/theme-form';

/** Display labels for `@ventia/core`'s fixed 5-pair font catalog and radius
 * scale — the values themselves (`FONT_PAIRS`, `RADIUS_OPTIONS`) come from
 * `@ventia/core` so this step can never drift from what `themeSchema`
 * actually accepts; only the es-CO copy for each option lives here. */
const FONT_PAIR_LABELS: Record<FontPair, string> = {
  'inter-lora': 'Inter + Lora',
  'poppins-source': 'Poppins + Source Serif',
  'montserrat-merriweather': 'Montserrat + Merriweather',
  'raleway-open': 'Raleway + Open Sans',
  'worksans-bitter': 'Work Sans + Bitter',
};

const RADIUS_LABELS: Record<Radius, string> = {
  none: 'Sin bordes redondeados',
  sm: 'Pequeño',
  md: 'Mediano',
  lg: 'Grande',
  full: 'Circular',
};

interface ThemeResponse {
  theme: Record<string, unknown>;
}

export interface BrandingStepProps {
  onDone: () => void;
  /** The tenant's current `theme` (from `GET /v1/admin/settings`), fetched
   * once by the wizard and shared with `PaymentsStep` (see wizard.tsx) so
   * this step doesn't need its own round-trip. `undefined` means "not
   * fetched yet" — the wizard only renders this step once its settings load
   * has resolved, but {@link themeToFormState} tolerates `undefined` too
   * (falls back to defaults) so this component works standalone as well. */
  theme?: Record<string, unknown>;
}

/** `branding` step: `PUT /v1/admin/settings/theme` (owner-only, replaces the
 * whole theme) followed by `PATCH /v1/admin/onboarding { step: 'branding' }`
 * to mark the wizard step done — two separate calls because the theme itself
 * has no onboarding-step concept (see settings-schemas.ts's doc comment on
 * `themeSchema` being a PUT, not a PATCH).
 *
 * Because that PUT is a full replace, the form must start from whatever
 * theme is already saved — not hardcoded defaults — or revisiting this
 * (already-completed) step and clicking "Continuar" would silently overwrite
 * the merchant's real theme with placeholder colors. `theme` is passed down
 * pre-fetched; {@link themeToFormState} does the saved-vs-default mapping. */
export function BrandingStep({ onDone, theme }: BrandingStepProps) {
  const initial = themeToFormState(theme);
  const [primary, setPrimary] = useState(initial.primary);
  const [background, setBackground] = useState(initial.background);
  const [foreground, setForeground] = useState(initial.foreground);
  const [fontPair, setFontPair] = useState<FontPair>(initial.fontPair);
  const [radius, setRadius] = useState<Radius>(initial.radius);
  const [logoUrl, setLogoUrl] = useState(initial.logoUrl);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await apiFetch<ThemeResponse>('/v1/admin/settings/theme', {
        method: 'PUT',
        body: JSON.stringify({
          colors: { primary, background, foreground },
          fontPair,
          radius,
          ...(logoUrl ? { logoUrl } : {}),
        }),
      });
      await apiFetch('/v1/admin/onboarding', {
        method: 'PATCH',
        body: JSON.stringify({ step: 'branding' }),
      });
      onDone();
    } catch (e) {
      setError(e instanceof ApiError ? errorMessage(e) : 'Ocurrió un error inesperado. Intenta de nuevo.');
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>La marca de tu tienda</CardTitle>
      </CardHeader>
      <CardContent>
        <form className="flex flex-col gap-4" onSubmit={handleSubmit} noValidate>
          {error ? <Alert variant="error">{error}</Alert> : null}
          <div className="grid grid-cols-3 gap-4">
            <FormField label="Color primario" htmlFor="primary">
              <Input type="color" value={primary} onChange={(event) => setPrimary(event.target.value)} />
            </FormField>
            <FormField label="Fondo" htmlFor="background">
              <Input type="color" value={background} onChange={(event) => setBackground(event.target.value)} />
            </FormField>
            <FormField label="Texto" htmlFor="foreground">
              <Input type="color" value={foreground} onChange={(event) => setForeground(event.target.value)} />
            </FormField>
          </div>
          <FormField label="Combinación de fuentes" htmlFor="fontPair">
            <Select value={fontPair} onChange={(event) => setFontPair(event.target.value as FontPair)}>
              {FONT_PAIRS.map((pair) => (
                <option key={pair} value={pair}>
                  {FONT_PAIR_LABELS[pair]}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="Bordes" htmlFor="radius">
            <Select value={radius} onChange={(event) => setRadius(event.target.value as Radius)}>
              {RADIUS_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {RADIUS_LABELS[option]}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="URL del logo (opcional)" htmlFor="logoUrl">
            <Input
              type="url"
              value={logoUrl}
              onChange={(event) => setLogoUrl(event.target.value)}
              placeholder="https://…"
            />
          </FormField>
          <Button type="submit" disabled={submitting}>
            {submitting ? 'Guardando…' : 'Continuar'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
