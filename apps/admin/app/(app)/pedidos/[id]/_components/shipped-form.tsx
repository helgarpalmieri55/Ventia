'use client';

import { useState, type FormEvent } from 'react';
import { Alert, Button, FormField, Input } from '@ventia/ui';
import { ApiError } from '../../../../../lib/api';
import { errorMessage, fieldErrors } from '../../../../../lib/errors';
import { markShipped, type OrderDetail } from '../../../../../lib/orders-api';

export interface ShippedFormProps {
  orderId: string;
  onShipped: (order: OrderDetail) => void;
  onCancel: () => void;
}

/** Revealed only after clicking "Marcar enviado" — carrier + tracking
 * number, both required non-empty strings server-side (see
 * `orders.controller.ts`'s `parseShippedBody`), so a 400 `VALIDATION_FAILED`
 * response is handled with the same `ApiError`/`fieldErrors` pattern as
 * every other admin form rather than firing the PATCH immediately on
 * button click. */
export function ShippedForm({ orderId, onShipped, onCancel }: ShippedFormProps) {
  const [carrier, setCarrier] = useState('');
  const [trackingNumber, setTrackingNumber] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    setErrors({});

    const carrierTrim = carrier.trim();
    const trackingTrim = trackingNumber.trim();
    const nextErrors: Record<string, string> = {};
    if (!carrierTrim) nextErrors.carrier = 'La transportadora es requerida.';
    if (!trackingTrim) nextErrors.trackingNumber = 'El número de guía es requerido.';
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      return;
    }

    setSubmitting(true);
    try {
      const updated = await markShipped(orderId, { carrier: carrierTrim, trackingNumber: trackingTrim });
      onShipped(updated);
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.code === 'VALIDATION_FAILED') setErrors(fieldErrors(e));
        else setFormError(errorMessage(e));
      } else {
        setFormError('Ocurrió un error inesperado. Intenta de nuevo.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="flex flex-col gap-4 rounded-md border border-border p-4" onSubmit={handleSubmit} noValidate>
      {formError ? <Alert variant="error">{formError}</Alert> : null}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <FormField label="Transportadora" htmlFor="carrier" error={errors.carrier}>
          <Input value={carrier} onChange={(event) => setCarrier(event.target.value)} />
        </FormField>
        <FormField label="Número de guía" htmlFor="trackingNumber" error={errors.trackingNumber}>
          <Input value={trackingNumber} onChange={(event) => setTrackingNumber(event.target.value)} />
        </FormField>
      </div>
      <div className="flex gap-2">
        <Button type="submit" disabled={submitting}>
          {submitting ? 'Guardando…' : 'Confirmar envío'}
        </Button>
        <Button type="button" variant="secondary" disabled={submitting} onClick={onCancel}>
          Cancelar
        </Button>
      </div>
    </form>
  );
}
