'use client';

import { useState, type FormEvent } from 'react';
import { DEPARTAMENTOS, type ShippingMethodInput } from '@ventia/core';
import { Alert, Button, FormField, Input, Label } from '@ventia/ui';
import { ApiError, apiFetch } from '../lib/api';
import { errorMessage, fieldErrors } from '../lib/errors';
import { centsToPesos, pesosToCents } from '../lib/format';
import {
  etaFromDraft,
  etaToDraft,
  newFlatMethod,
  newFreeOverMethod,
  newPickupMethod,
  newZoneMethod,
  shippingToFormState,
  type EtaDraft,
} from '../lib/shipping-form';
import type { SettingsResponse, TabProps } from '../app/(app)/configuracion/page';

// --- Draft representation ---------------------------------------------
//
// Every price-bearing field on this tab follows the SAME pesos-facing
// input / cents-on-the-wire convention as the product form
// (app/(app)/productos/[id]/_components/base-fields-form.tsx's
// `priceCentsPesos` + `lib/format.ts`'s `pesosToCents`/`centsToPesos`):
// the merchant always types and sees whole pesos, and the conversion to/
// from integer cents (the shape `shippingMethodSchema` and the DB column
// actually store) happens only at the two boundaries — populating the
// draft from a saved method, and converting the draft back before the
// PATCH. Keeping raw pesos strings (rather than numbers) in between lets
// the merchant clear a field or type multi-digit numbers without fighting
// premature rounding/parsing on every keystroke, same reason
// BaseFieldsForm keeps its price fields as strings.
//
// A method's draft is a variant of its `ShippingMethodInput` counterpart
// with every `*Cents` field replaced by a `*Pesos` string field. This is
// UI-only scaffolding, not part of the `@ventia/core` schema, so it lives
// here rather than in `lib/shipping-form.ts`. The one exception is the
// delivery-estimate pair (`EtaDraft` and its two converters): it is identical
// across all four method types and is pure string↔number logic, so it sits in
// `lib/` where it can be tested directly — the same split `lib/format.ts`'s
// `pesosToCents`/`centsToPesos` already have from the price fields that use
// them.

interface FlatDraft extends EtaDraft {
  id: string;
  type: 'flat';
  label: string;
  priceCentsPesos: string;
  enabled: boolean;
}

interface ZoneDraft extends EtaDraft {
  id: string;
  type: 'zone';
  label: string;
  /** One entry per `DEPARTAMENTOS` code, always present (so every row has a
   * controlled input) — an empty string means "not set for this
   * departamento", NOT "$0"; only non-empty entries are sent as
   * `ratesByDepartamento` on save. */
  ratesByDepartamentoPesos: Record<string, string>;
  defaultPriceCentsPesos: string;
  enabled: boolean;
}

interface FreeOverDraft extends EtaDraft {
  id: string;
  type: 'free_over';
  label: string;
  thresholdCentsPesos: string;
  fallbackPriceCentsPesos: string;
  enabled: boolean;
}

interface PickupDraft extends EtaDraft {
  id: string;
  type: 'pickup';
  label: string;
  instructions: string;
  enabled: boolean;
}

type MethodDraft = FlatDraft | ZoneDraft | FreeOverDraft | PickupDraft;

function methodToDraft(method: ShippingMethodInput): MethodDraft {
  switch (method.type) {
    case 'flat':
      return {
        id: method.id,
        type: 'flat',
        label: method.label,
        priceCentsPesos: String(centsToPesos(method.priceCents)),
        ...etaToDraft(method),
        enabled: method.enabled,
      };
    case 'zone': {
      const ratesByDepartamentoPesos: Record<string, string> = {};
      for (const d of DEPARTAMENTOS) {
        const cents = method.ratesByDepartamento[d.code];
        ratesByDepartamentoPesos[d.code] = cents !== undefined ? String(centsToPesos(cents)) : '';
      }
      return {
        id: method.id,
        type: 'zone',
        label: method.label,
        ratesByDepartamentoPesos,
        defaultPriceCentsPesos: method.defaultPriceCents !== undefined ? String(centsToPesos(method.defaultPriceCents)) : '',
        ...etaToDraft(method),
        enabled: method.enabled,
      };
    }
    case 'free_over':
      return {
        id: method.id,
        type: 'free_over',
        label: method.label,
        thresholdCentsPesos: String(centsToPesos(method.thresholdCents)),
        fallbackPriceCentsPesos: String(centsToPesos(method.fallbackPriceCents)),
        ...etaToDraft(method),
        enabled: method.enabled,
      };
    case 'pickup':
      return {
        id: method.id,
        type: 'pickup',
        label: method.label,
        instructions: method.instructions ?? '',
        ...etaToDraft(method),
        enabled: method.enabled,
      };
  }
}

/** Converts a draft back to the wire shape. Mirrors BaseFieldsForm's
 * `pesosToCents(...) ?? Number.NaN`: an invalid/unparseable pesos string
 * becomes `NaN`, which `shippingMethodSchema`'s `z.number()` rejects,
 * surfacing as a normal VALIDATION_FAILED rather than silently coercing to
 * `0` or crashing. */
function draftToMethod(draft: MethodDraft): ShippingMethodInput {
  switch (draft.type) {
    case 'flat':
      return {
        id: draft.id,
        type: 'flat',
        label: draft.label,
        priceCents: pesosToCents(draft.priceCentsPesos) ?? Number.NaN,
        ...etaFromDraft(draft),
        enabled: draft.enabled,
      };
    case 'zone': {
      const ratesByDepartamento: Record<string, number> = {};
      for (const [code, pesos] of Object.entries(draft.ratesByDepartamentoPesos)) {
        const trimmed = pesos.trim();
        if (trimmed === '') continue; // not set for this departamento — omitted, not $0
        ratesByDepartamento[code] = pesosToCents(trimmed) ?? Number.NaN;
      }
      const defaultTrimmed = draft.defaultPriceCentsPesos.trim();
      return {
        id: draft.id,
        type: 'zone',
        label: draft.label,
        ratesByDepartamento,
        ...(defaultTrimmed === '' ? {} : { defaultPriceCents: pesosToCents(defaultTrimmed) ?? Number.NaN }),
        ...etaFromDraft(draft),
        enabled: draft.enabled,
      };
    }
    case 'free_over':
      return {
        id: draft.id,
        type: 'free_over',
        label: draft.label,
        thresholdCents: pesosToCents(draft.thresholdCentsPesos) ?? Number.NaN,
        fallbackPriceCents: pesosToCents(draft.fallbackPriceCentsPesos) ?? Number.NaN,
        ...etaFromDraft(draft),
        enabled: draft.enabled,
      };
    case 'pickup': {
      const instructionsTrimmed = draft.instructions.trim();
      return {
        id: draft.id,
        type: 'pickup',
        label: draft.label,
        ...(instructionsTrimmed ? { instructions: instructionsTrimmed } : {}),
        ...etaFromDraft(draft),
        enabled: draft.enabled,
      };
    }
  }
}

const METHOD_TYPE_LABELS: Record<MethodDraft['type'], string> = {
  flat: 'Tarifa fija',
  zone: 'Por departamento',
  free_over: 'Envío gratis desde',
  pickup: 'Recoger en tienda',
};

/** Envíos tab: `PATCH /v1/admin/settings/shipping` — like Marca's theme
 * PUT (and NOT Tienda's storeInfo/Pagos's payments merge-in-place), the
 * server replaces `settings.shipping` wholesale
 * (settings.controller.ts's `updateShipping`: "a methods array has no
 * meaningful partial-update semantics"), so this always sends the FULL
 * current form state — every configured method and the complete
 * `codRestrictedDepartamentos` list — never a partial patch.
 *
 * Extracted into its own component (rather than inlined in
 * configuracion/page.tsx like Tienda/Marca/Pagos) because this tab is a
 * repeatable list of 4 differently-shaped method types plus a
 * 33-departamento checklist — meaningfully more UI than the other three
 * tabs combined, and page.tsx was already 474 lines before this tab
 * existed. */
export function EnviosTab({ settings, onSaved }: TabProps) {
  // Lazy initializers: `shippingToFormState` + mapping every method to its
  // draft form is real work (schema-validating each element, building a
  // full 33-entry rate record per zone method) that must only run once, on
  // mount — not be recomputed and discarded on every re-render (e.g. every
  // keystroke).
  const [methods, setMethods] = useState<MethodDraft[]>(() =>
    shippingToFormState(settings.shipping).methods.map(methodToDraft),
  );
  const [codRestricted, setCodRestricted] = useState<Set<string>>(
    () => new Set(shippingToFormState(settings.shipping).codRestrictedDepartamentos),
  );
  const [error, setError] = useState<string | null>(null);
  const [methodsError, setMethodsError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [saved, setSaved] = useState(false);

  function addMethod(draft: MethodDraft) {
    setMethods((prev) => [...prev, draft]);
    setSaved(false);
  }

  function removeMethod(id: string) {
    setMethods((prev) => prev.filter((m) => m.id !== id));
    setSaved(false);
  }

  function updateMethod(id: string, patch: Partial<MethodDraft>) {
    setMethods((prev) => prev.map((m) => (m.id === id ? ({ ...m, ...patch } as MethodDraft) : m)));
    setSaved(false);
  }

  function updateZoneRate(id: string, departamentoCode: string, pesos: string) {
    setMethods((prev) =>
      prev.map((m) =>
        m.id === id && m.type === 'zone'
          ? { ...m, ratesByDepartamentoPesos: { ...m.ratesByDepartamentoPesos, [departamentoCode]: pesos } }
          : m,
      ),
    );
    setSaved(false);
  }

  function toggleCodRestricted(code: string) {
    setCodRestricted((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
    setSaved(false);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setMethodsError(null);
    setSaved(false);
    setSubmitting(true);
    try {
      const updated = await apiFetch<SettingsResponse>('/v1/admin/settings/shipping', {
        method: 'PATCH',
        body: JSON.stringify({
          methods: methods.map(draftToMethod),
          codRestrictedDepartamentos: Array.from(codRestricted),
        }),
      });
      onSaved(updated);
      setSaved(true);
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.code === 'VALIDATION_FAILED') {
          // zod's `.flatten()` keys a top-level array field ("methods") by
          // that one key regardless of which method/index/subfield actually
          // failed (same nested-field limitation TiendaTab/MarcaTab note
          // for their own nested objects) — surfaced as one alert above the
          // methods list rather than pinpointing the exact bad input.
          const fe = fieldErrors(e);
          setMethodsError(fe.methods ?? null);
          if (!fe.methods) setError(errorMessage(e));
        } else {
          setError(errorMessage(e));
        }
      } else {
        setError('Ocurrió un error inesperado. Intenta de nuevo.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="flex flex-col gap-6" onSubmit={handleSubmit} noValidate>
      {error ? <Alert variant="error">{error}</Alert> : null}
      {saved ? <Alert variant="success">Los cambios se guardaron correctamente.</Alert> : null}

      <div className="flex flex-col gap-4">
        <h3 className="text-sm font-medium text-foreground">Métodos de envío</h3>
        {methodsError ? <Alert variant="error">{methodsError}</Alert> : null}

        {methods.length === 0 ? (
          <p className="text-sm text-muted-foreground">Aún no has configurado ningún método de envío.</p>
        ) : null}

        {methods.map((method) => (
          <div key={method.id} className="flex flex-col gap-3 rounded-md border border-border p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium uppercase text-muted-foreground">
                {METHOD_TYPE_LABELS[method.type]}
              </span>
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2">
                  <input
                    id={`envios-enabled-${method.id}`}
                    type="checkbox"
                    className="h-4 w-4"
                    checked={method.enabled}
                    onChange={(event) => updateMethod(method.id, { enabled: event.target.checked })}
                  />
                  <Label htmlFor={`envios-enabled-${method.id}`}>Activo</Label>
                </div>
                <Button type="button" variant="ghost" size="sm" onClick={() => removeMethod(method.id)}>
                  Quitar
                </Button>
              </div>
            </div>

            <FormField label="Nombre" htmlFor={`envios-label-${method.id}`}>
              <Input
                value={method.label}
                onChange={(event) => updateMethod(method.id, { label: event.target.value })}
                maxLength={60}
                required
              />
            </FormField>

            {method.type === 'flat' ? (
              <FormField label="Precio (COP)" htmlFor={`envios-price-${method.id}`}>
                <Input
                  type="number"
                  min={0}
                  step="1"
                  inputMode="decimal"
                  value={method.priceCentsPesos}
                  onChange={(event) => updateMethod(method.id, { priceCentsPesos: event.target.value })}
                />
              </FormField>
            ) : null}

            {method.type === 'free_over' ? (
              <div className="grid grid-cols-2 gap-3">
                <FormField label="Envío gratis desde (COP)" htmlFor={`envios-threshold-${method.id}`}>
                  <Input
                    type="number"
                    min={0}
                    step="1"
                    inputMode="decimal"
                    value={method.thresholdCentsPesos}
                    onChange={(event) => updateMethod(method.id, { thresholdCentsPesos: event.target.value })}
                  />
                </FormField>
                <FormField label="Precio si no aplica (COP)" htmlFor={`envios-fallback-${method.id}`}>
                  <Input
                    type="number"
                    min={0}
                    step="1"
                    inputMode="decimal"
                    value={method.fallbackPriceCentsPesos}
                    onChange={(event) => updateMethod(method.id, { fallbackPriceCentsPesos: event.target.value })}
                  />
                </FormField>
              </div>
            ) : null}

            {method.type === 'pickup' ? (
              <FormField label="Instrucciones (opcional)" htmlFor={`envios-instructions-${method.id}`}>
                <Input
                  value={method.instructions}
                  onChange={(event) => updateMethod(method.id, { instructions: event.target.value })}
                  maxLength={500}
                  placeholder="Ej. Dirección y horario de recogida"
                />
              </FormField>
            ) : null}

            {method.type === 'zone' ? (
              <div className="flex flex-col gap-3">
                <FormField label="Precio por defecto (opcional, COP)" htmlFor={`envios-default-${method.id}`}>
                  <Input
                    type="number"
                    min={0}
                    step="1"
                    inputMode="decimal"
                    value={method.defaultPriceCentsPesos}
                    onChange={(event) => updateMethod(method.id, { defaultPriceCentsPesos: event.target.value })}
                    placeholder="Usado si un departamento no tiene precio propio"
                  />
                </FormField>
                <div>
                  <span className="text-xs text-muted-foreground">
                    Precio por departamento (deja en blanco los que no apliquen)
                  </span>
                  <div className="mt-2 grid max-h-64 grid-cols-2 gap-2 overflow-y-auto rounded-md border border-border p-2">
                    {DEPARTAMENTOS.map((d) => (
                      <div key={d.code} className="flex items-center gap-2">
                        <Label htmlFor={`envios-zone-${method.id}-${d.code}`} className="w-1/2 shrink-0 text-xs">
                          {d.name}
                        </Label>
                        <Input
                          id={`envios-zone-${method.id}-${d.code}`}
                          type="number"
                          min={0}
                          step="1"
                          inputMode="decimal"
                          value={method.ratesByDepartamentoPesos[d.code] ?? ''}
                          onChange={(event) => updateZoneRate(method.id, d.code, event.target.value)}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ) : null}

            {/* Common to every method type: how long THIS option takes. Shown
                on the product page and at checkout, and it is what fills the
                "tiempo estimado de entrega" line of the generated términos —
                left blank, that line keeps its [COMPLETAR: ...] marker. */}
            <div className="grid grid-cols-2 gap-3">
              <FormField label="Entrega desde (días hábiles)" htmlFor={`envios-eta-min-${method.id}`}>
                <Input
                  id={`envios-eta-min-${method.id}`}
                  type="number"
                  min={0}
                  max={90}
                  step="1"
                  inputMode="numeric"
                  value={method.etaMinDays}
                  onChange={(event) => updateMethod(method.id, { etaMinDays: event.target.value })}
                  placeholder="Opcional"
                />
              </FormField>
              <FormField label="Entrega hasta (días hábiles)" htmlFor={`envios-eta-max-${method.id}`}>
                <Input
                  id={`envios-eta-max-${method.id}`}
                  type="number"
                  min={0}
                  max={90}
                  step="1"
                  inputMode="numeric"
                  value={method.etaMaxDays}
                  onChange={(event) => updateMethod(method.id, { etaMaxDays: event.target.value })}
                  placeholder="Opcional"
                />
              </FormField>
            </div>
          </div>
        ))}

        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={() => addMethod(methodToDraft(newFlatMethod()))}>
            + Tarifa fija
          </Button>
          <Button type="button" variant="secondary" size="sm" onClick={() => addMethod(methodToDraft(newZoneMethod()))}>
            + Por departamento
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => addMethod(methodToDraft(newFreeOverMethod()))}
          >
            + Envío gratis
          </Button>
          <Button type="button" variant="secondary" size="sm" onClick={() => addMethod(methodToDraft(newPickupMethod()))}>
            + Recoger en tienda
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium text-foreground">Pago contra-entrega</h3>
        {/* `codRestrictedDepartamentos` is a BLOCKLIST: membership means COD
            is DISALLOWED there, not "COD only allowed there" — an empty set
            means unrestricted everywhere. The label/copy below intentionally
            spells that out (a past task review flagged this exact semantic
            as easy to invert by mistake). */}
        <p className="text-sm text-muted-foreground">
          Marca los departamentos donde <strong>NO</strong> se debe ofrecer pago contra-entrega. Los que dejes sin
          marcar permiten contra-entrega con normalidad.
        </p>
        <div className="grid max-h-64 grid-cols-2 gap-2 overflow-y-auto rounded-md border border-border p-3 sm:grid-cols-3">
          {DEPARTAMENTOS.map((d) => (
            <div key={d.code} className="flex items-center gap-2">
              <input
                id={`envios-cod-restricted-${d.code}`}
                type="checkbox"
                className="h-4 w-4"
                checked={codRestricted.has(d.code)}
                onChange={() => toggleCodRestricted(d.code)}
              />
              <Label htmlFor={`envios-cod-restricted-${d.code}`} className="text-xs">
                {d.name}
              </Label>
            </div>
          ))}
        </div>
      </div>

      <Button type="submit" disabled={submitting} className="self-start">
        {submitting ? 'Guardando…' : 'Guardar'}
      </Button>
    </form>
  );
}
