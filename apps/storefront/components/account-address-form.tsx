'use client';

import * as React from 'react';
import { Alert, Button, FormField, Input, Select, Spinner } from '@ventia/ui';
import { DEPARTAMENTOS } from '@ventia/core';
import { municipioOptionsFor } from '../lib/checkout-form';
import {
  ADDRESS_FIELD_ORDER,
  EMPTY_ADDRESS_FORM,
  validateAddressForm,
  type AddressFormState,
} from '../lib/account-addresses';

/** Scrolls to and focuses the first invalid field, top-to-bottom. Same
 * reasoning as checkout's copy of this: someone who submits while scrolled
 * to the button must see something happen, rather than the form silently
 * doing nothing while the errors render off-screen above. */
function scrollToFirstError(errors: Record<string, string>, idPrefix: string) {
  const firstKey = ADDRESS_FIELD_ORDER.find((key) => key in errors);
  if (!firstKey) return;
  const el = document.getElementById(`${idPrefix}${firstKey}`);
  el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  if (el instanceof HTMLElement) el.focus({ preventScroll: true });
}

export interface AccountAddressFormProps {
  /** Pre-filled state for an edit; omitted for a new address. */
  initial?: AddressFormState;
  /** Whether to offer the "make this my default" checkbox. Hidden when the
   * address being edited ALREADY is the default (there is nothing to ask)
   * and when this is the shopper's first address (the API makes the first one
   * default regardless, so a checkbox that changed nothing would be a lie). */
  showDefaultToggle: boolean;
  /** Copy for the first address, in place of the toggle: the shopper should
   * know it will be the default without being offered a choice they do not
   * have. */
  firstAddressNotice?: boolean;
  submitLabel: string;
  onSubmit: (form: AddressFormState) => Promise<void>;
  onCancel: () => void;
  /** Server-side failure, rendered above the fields. Owned by the parent
   * because only it knows whether the call was a create or an update. */
  error?: string | null;
  /** Distinguishes this form's field ids from any other on the page — two
   * forms with an `id="direccion"` each would break every `<label htmlFor>`
   * on the second one. */
  idPrefix?: string;
}

/**
 * The saved-address form — the same Colombian shape checkout collects
 * (departamento → municipio → dirección, no postal code), because a saved
 * address IS a checkout address: the API validates both with
 * `checkoutAddressSchema`, so anything this form accepts that checkout would
 * not is an address the shopper cannot actually use.
 *
 * The municipio `<select>` is driven by the chosen departamento and cleared
 * whenever it changes, exactly as on checkout. That clearing is the whole
 * cross-field rule made visible: leaving a stale municipio selected would
 * silently reintroduce the mismatched pairing the server rejects.
 */
export function AccountAddressForm({
  initial,
  showDefaultToggle,
  firstAddressNotice = false,
  submitLabel,
  onSubmit,
  onCancel,
  error,
  idPrefix = '',
}: AccountAddressFormProps) {
  const [form, setForm] = React.useState<AddressFormState>(initial ?? EMPTY_ADDRESS_FORM);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [saving, setSaving] = React.useState(false);

  const id = (field: string) => `${idPrefix}${field}`;

  function setField<K extends keyof AddressFormState>(key: K, value: AddressFormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  function handleDepartamentoChange(code: string) {
    // The municipio belonged to the OLD departamento. Clearing it in the same
    // state update as the departamento change means there is never a render
    // holding a pairing the server would reject.
    setForm((prev) => ({ ...prev, departamentoCode: code, municipioName: '' }));
    setErrors((prev) => {
      const next = { ...prev };
      delete next.departamentoCode;
      delete next.municipioName;
      return next;
    });
  }

  const municipioOptions = React.useMemo(
    () => (form.departamentoCode ? municipioOptionsFor(form.departamentoCode) : []),
    [form.departamentoCode],
  );

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const found = validateAddressForm(form);
    if (Object.keys(found).length > 0) {
      setErrors(found);
      scrollToFirstError(found, idPrefix);
      return;
    }
    setSaving(true);
    try {
      await onSubmit(form);
    } finally {
      // Runs even when `onSubmit` rejects: the parent renders the failure as
      // `error` and the shopper must be able to press the button again. A
      // button left spinning after a failed save is indistinguishable from
      // one still working.
      setSaving(false);
    }
  }

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-4">
      {error ? <Alert variant="error">{error}</Alert> : null}

      <FormField label="Nombre para esta dirección (opcional)" htmlFor={id('label')} error={errors.label}>
        <Input
          value={form.label}
          onChange={(e) => setField('label', e.target.value)}
          placeholder="Casa, Oficina…"
        />
      </FormField>

      <FormField label="Nombre de quien recibe" htmlFor={id('nombreCompleto')} error={errors.nombreCompleto}>
        <Input
          value={form.nombreCompleto}
          onChange={(e) => setField('nombreCompleto', e.target.value)}
          autoComplete="name"
        />
      </FormField>

      <FormField label="Teléfono" htmlFor={id('telefono')} error={errors.telefono}>
        <Input
          type="tel"
          value={form.telefono}
          onChange={(e) => setField('telefono', e.target.value)}
          autoComplete="tel"
        />
      </FormField>

      <FormField label="Departamento" htmlFor={id('departamentoCode')} error={errors.departamentoCode}>
        <Select value={form.departamentoCode} onChange={(e) => handleDepartamentoChange(e.target.value)}>
          <option value="" disabled>
            Selecciona un departamento
          </option>
          {DEPARTAMENTOS.map((d) => (
            <option key={d.code} value={d.code}>
              {d.name}
            </option>
          ))}
        </Select>
      </FormField>

      <FormField label="Municipio" htmlFor={id('municipioName')} error={errors.municipioName}>
        <Select
          value={form.municipioName}
          onChange={(e) => setField('municipioName', e.target.value)}
          disabled={!form.departamentoCode}
        >
          <option value="" disabled>
            {form.departamentoCode ? 'Selecciona un municipio' : 'Elige primero un departamento'}
          </option>
          {municipioOptions.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </Select>
      </FormField>

      <FormField label="Dirección" htmlFor={id('direccion')} error={errors.direccion}>
        <Input
          value={form.direccion}
          onChange={(e) => setField('direccion', e.target.value)}
          placeholder="Calle 10 # 20-30"
        />
      </FormField>

      <FormField label="Complemento (opcional)" htmlFor={id('complemento')} error={errors.complemento}>
        <Input
          value={form.complemento}
          onChange={(e) => setField('complemento', e.target.value)}
          placeholder="Apto 301, Torre 2…"
        />
      </FormField>

      <FormField label="Barrio (opcional)" htmlFor={id('barrio')} error={errors.barrio}>
        <Input value={form.barrio} onChange={(e) => setField('barrio', e.target.value)} />
      </FormField>

      <FormField label="Notas para la entrega (opcional)" htmlFor={id('notas')} error={errors.notas}>
        <Input value={form.notas} onChange={(e) => setField('notas', e.target.value)} />
      </FormField>

      {showDefaultToggle ? (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.isDefault}
            onChange={(e) => setField('isDefault', e.target.checked)}
          />
          Usar esta dirección por defecto al pagar
        </label>
      ) : null}

      {firstAddressNotice ? (
        <p className="text-sm text-muted-foreground">
          Como es tu primera dirección, la usaremos por defecto al pagar. Puedes cambiarla cuando
          guardes otra.
        </p>
      ) : null}

      <div className="flex items-center gap-2">
        <Button type="submit" disabled={saving}>
          {saving ? (
            <>
              <Spinner /> Guardando…
            </>
          ) : (
            submitLabel
          )}
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel} disabled={saving}>
          Cancelar
        </Button>
      </div>
    </form>
  );
}
