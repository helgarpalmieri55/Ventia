'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { FONT_PAIRS, RADIUS_OPTIONS, type FontPair, type Radius } from '@ventia/core';
import { Alert, Button, Card, CardContent, CardHeader, CardTitle, FormField, Input, Label, Select, Spinner } from '@ventia/ui';
import { ApiError, apiFetch } from '../../../lib/api';
import { errorMessage, fieldErrors } from '../../../lib/errors';
import { FONT_PAIR_LABELS, RADIUS_LABELS, themeToFormState } from '../../../lib/theme-form';

interface StoreInfo {
  category?: string;
  contactEmail?: string;
  contactPhone?: string;
  description?: string;
}

/** `GET /v1/admin/settings`'s full response shape (see
 * services/api/src/settings/settings.controller.ts's `toResponse`) — every
 * tab below reads its slice from this and, on a successful save, replaces
 * it wholesale with the fresh response the PATCH/PUT itself returns, so
 * switching tabs (or re-saving the same tab) always starts from the latest
 * server state rather than a stale initial fetch. */
interface SettingsResponse {
  name: string;
  slug: string;
  status: string;
  storeInfo: StoreInfo;
  theme: Record<string, unknown>;
  payments: { codEnabled: boolean };
}

type Tab = 'tienda' | 'marca' | 'pagos';

const TABS: { key: Tab; label: string }[] = [
  { key: 'tienda', label: 'Tienda' },
  { key: 'marca', label: 'Marca' },
  { key: 'pagos', label: 'Pagos' },
];

/** Owner-only route (hidden from staff in the nav, enforced server-side by
 * `@Roles('owner')` on SettingsController — a staff session hitting
 * `/configuracion` directly gets 403 FORBIDDEN_ROLE from `GET
 * /v1/admin/settings`, surfaced by `load`'s catch below via `errorMessage`).
 *
 * Three client-side tabs (no routing — just local `tab` state, per the
 * binding contract), each owning its own form state independently so
 * switching tabs never clobbers unsaved edits in another tab. */
export default function ConfiguracionPage() {
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('tienda');

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const result = await apiFetch<SettingsResponse>('/v1/admin/settings');
      setSettings(result);
    } catch (e) {
      setLoadError(e instanceof ApiError ? errorMessage(e) : 'Ocurrió un error inesperado. Intenta de nuevo.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner /> Cargando configuración…
      </div>
    );
  }

  if (loadError || !settings) {
    return (
      <div className="flex flex-col gap-3">
        <Alert variant="error">{loadError ?? 'Ocurrió un error inesperado. Intenta de nuevo.'}</Alert>
        <Button variant="secondary" size="sm" className="self-start" onClick={() => void load()}>
          Reintentar
        </Button>
      </div>
    );
  }

  return (
    <Card className="w-full max-w-2xl">
      <CardHeader>
        <CardTitle>Configuración</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <div className="flex gap-2 border-b border-border pb-3" role="tablist">
          {TABS.map((t) => (
            <Button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              variant={tab === t.key ? 'default' : 'ghost'}
              size="sm"
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </Button>
          ))}
        </div>

        {tab === 'tienda' ? <TiendaTab settings={settings} onSaved={setSettings} /> : null}
        {tab === 'marca' ? <MarcaTab settings={settings} onSaved={setSettings} /> : null}
        {tab === 'pagos' ? <PagosTab settings={settings} onSaved={setSettings} /> : null}
      </CardContent>
    </Card>
  );
}

interface TabProps {
  settings: SettingsResponse;
  onSaved: (settings: SettingsResponse) => void;
}

/** Tienda tab: `PATCH /v1/admin/settings/store` (name + storeInfo fields).
 * `storeInfo` is merged server-side (not replaced), so this only ever sends
 * the fields the form actually has — same optional-field-per-key shape as
 * the onboarding wizard's store_info step. VALIDATION_FAILED's fieldErrors
 * only ever has `name` and/or `storeInfo` keys (zod's `.flatten()` keys a
 * nested-object field by its first path segment, not e.g. `storeInfo.category`
 * — see lib/validation.ts's doc comment on the same limitation), so a
 * storeInfo-nested error surfaces as one alert above that field group rather
 * than pinpointing the exact subfield. */
function TiendaTab({ settings, onSaved }: TabProps) {
  const [name, setName] = useState(settings.name);
  const [category, setCategory] = useState(settings.storeInfo.category ?? '');
  const [contactEmail, setContactEmail] = useState(settings.storeInfo.contactEmail ?? '');
  const [contactPhone, setContactPhone] = useState(settings.storeInfo.contactPhone ?? '');
  const [description, setDescription] = useState(settings.storeInfo.description ?? '');
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [saved, setSaved] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setErrors({});
    setSaved(false);
    setSubmitting(true);
    try {
      const updated = await apiFetch<SettingsResponse>('/v1/admin/settings/store', {
        method: 'PATCH',
        body: JSON.stringify({
          name,
          storeInfo: {
            ...(category ? { category } : {}),
            ...(contactEmail ? { contactEmail } : {}),
            ...(contactPhone ? { contactPhone } : {}),
            ...(description ? { description } : {}),
          },
        }),
      });
      onSaved(updated);
      setSaved(true);
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.code === 'VALIDATION_FAILED') setErrors(fieldErrors(e));
        else setError(errorMessage(e));
      } else {
        setError('Ocurrió un error inesperado. Intenta de nuevo.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={handleSubmit} noValidate>
      {error ? <Alert variant="error">{error}</Alert> : null}
      {saved ? <Alert variant="success">Los cambios se guardaron correctamente.</Alert> : null}
      <FormField label="Nombre de la tienda" htmlFor="tienda-name" error={errors.name}>
        <Input
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            setSaved(false);
          }}
          required
        />
      </FormField>
      {errors.storeInfo ? <Alert variant="error">{errors.storeInfo}</Alert> : null}
      <FormField label="Categoría" htmlFor="tienda-category">
        <Input
          value={category}
          onChange={(event) => {
            setCategory(event.target.value);
            setSaved(false);
          }}
          maxLength={60}
          placeholder="Ej. Moda, Hogar, Belleza"
        />
      </FormField>
      <FormField label="Correo de contacto" htmlFor="tienda-contact-email">
        <Input
          type="email"
          value={contactEmail}
          onChange={(event) => {
            setContactEmail(event.target.value);
            setSaved(false);
          }}
          placeholder="contacto@tutienda.com"
        />
      </FormField>
      <FormField label="Teléfono de contacto" htmlFor="tienda-contact-phone">
        <Input
          type="tel"
          value={contactPhone}
          onChange={(event) => {
            setContactPhone(event.target.value);
            setSaved(false);
          }}
          maxLength={20}
          placeholder="Ej. +57 300 000 0000"
        />
      </FormField>
      <FormField label="Descripción" htmlFor="tienda-description">
        <Input
          value={description}
          onChange={(event) => {
            setDescription(event.target.value);
            setSaved(false);
          }}
          maxLength={500}
          placeholder="Cuéntales a tus clientes de qué se trata tu tienda"
        />
      </FormField>
      <Button type="submit" disabled={submitting} className="self-start">
        {submitting ? 'Guardando…' : 'Guardar'}
      </Button>
    </form>
  );
}

/** Marca tab: `PUT /v1/admin/settings/theme` — a full replace, so this
 * always sends the complete theme object, never a partial one. Pre-filled
 * from `settings.theme` via `themeToFormState` (lib/theme-form.ts), the same
 * helper the onboarding wizard's BrandingStep uses for the identical
 * "don't clobber a saved theme with defaults on revisit" reasoning; the
 * font-pair/radius label maps are also shared from that module rather than
 * duplicated here. */
function MarcaTab({ settings, onSaved }: TabProps) {
  const initial = themeToFormState(settings.theme);
  const [primary, setPrimary] = useState(initial.primary);
  const [background, setBackground] = useState(initial.background);
  const [foreground, setForeground] = useState(initial.foreground);
  const [fontPair, setFontPair] = useState<FontPair>(initial.fontPair);
  const [radius, setRadius] = useState<Radius>(initial.radius);
  const [logoUrl, setLogoUrl] = useState(initial.logoUrl);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [saved, setSaved] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSaved(false);
    setSubmitting(true);
    try {
      const themePayload = {
        colors: { primary, background, foreground },
        fontPair,
        radius,
        ...(logoUrl ? { logoUrl } : {}),
      };
      const updated = await apiFetch<SettingsResponse>('/v1/admin/settings/theme', {
        method: 'PUT',
        body: JSON.stringify(themePayload),
      });
      onSaved(updated);
      setSaved(true);
    } catch (e) {
      setError(e instanceof ApiError ? errorMessage(e) : 'Ocurrió un error inesperado. Intenta de nuevo.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={handleSubmit} noValidate>
      {error ? <Alert variant="error">{error}</Alert> : null}
      {saved ? <Alert variant="success">Los cambios se guardaron correctamente.</Alert> : null}
      <div className="grid grid-cols-3 gap-4">
        <FormField label="Color primario" htmlFor="marca-primary">
          <Input
            type="color"
            value={primary}
            onChange={(event) => {
              setPrimary(event.target.value);
              setSaved(false);
            }}
          />
        </FormField>
        <FormField label="Fondo" htmlFor="marca-background">
          <Input
            type="color"
            value={background}
            onChange={(event) => {
              setBackground(event.target.value);
              setSaved(false);
            }}
          />
        </FormField>
        <FormField label="Texto" htmlFor="marca-foreground">
          <Input
            type="color"
            value={foreground}
            onChange={(event) => {
              setForeground(event.target.value);
              setSaved(false);
            }}
          />
        </FormField>
      </div>
      <FormField label="Combinación de fuentes" htmlFor="marca-fontPair">
        <Select
          value={fontPair}
          onChange={(event) => {
            setFontPair(event.target.value as FontPair);
            setSaved(false);
          }}
        >
          {FONT_PAIRS.map((pair) => (
            <option key={pair} value={pair}>
              {FONT_PAIR_LABELS[pair]}
            </option>
          ))}
        </Select>
      </FormField>
      <FormField label="Bordes" htmlFor="marca-radius">
        <Select
          value={radius}
          onChange={(event) => {
            setRadius(event.target.value as Radius);
            setSaved(false);
          }}
        >
          {RADIUS_OPTIONS.map((option) => (
            <option key={option} value={option}>
              {RADIUS_LABELS[option]}
            </option>
          ))}
        </Select>
      </FormField>
      <FormField label="URL del logo (opcional)" htmlFor="marca-logoUrl">
        <Input
          type="url"
          value={logoUrl}
          onChange={(event) => {
            setLogoUrl(event.target.value);
            setSaved(false);
          }}
          placeholder="https://…"
        />
      </FormField>
      <Button type="submit" disabled={submitting} className="self-start">
        {submitting ? 'Guardando…' : 'Guardar'}
      </Button>
    </form>
  );
}

/** Pagos tab: `PATCH /v1/admin/settings/payments` — the P1 launch only
 * supports cash-on-delivery, same single-toggle shape as the onboarding
 * wizard's PaymentsStep. */
function PagosTab({ settings, onSaved }: TabProps) {
  const [codEnabled, setCodEnabled] = useState(settings.payments.codEnabled);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [saved, setSaved] = useState(false);

  async function handleSave() {
    setError(null);
    setSaved(false);
    setSubmitting(true);
    try {
      const updated = await apiFetch<SettingsResponse>('/v1/admin/settings/payments', {
        method: 'PATCH',
        body: JSON.stringify({ codEnabled }),
      });
      onSaved(updated);
      setSaved(true);
    } catch (e) {
      setError(e instanceof ApiError ? errorMessage(e) : 'Ocurrió un error inesperado. Intenta de nuevo.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {error ? <Alert variant="error">{error}</Alert> : null}
      {saved ? <Alert variant="success">Los cambios se guardaron correctamente.</Alert> : null}
      <div className="flex items-center gap-3 rounded-md border border-border p-3">
        <input
          id="pagos-cod-enabled"
          type="checkbox"
          className="h-4 w-4"
          checked={codEnabled}
          onChange={(event) => {
            setCodEnabled(event.target.checked);
            setSaved(false);
          }}
        />
        <Label htmlFor="pagos-cod-enabled">Aceptar pago contraentrega</Label>
      </div>
      <Button onClick={() => void handleSave()} disabled={submitting} className="self-start">
        {submitting ? 'Guardando…' : 'Guardar'}
      </Button>
    </div>
  );
}
