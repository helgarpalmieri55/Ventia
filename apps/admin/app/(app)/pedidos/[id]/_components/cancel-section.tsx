'use client';

import { useState } from 'react';
import { Alert, Button, FormField, Input } from '@ventia/ui';
import { ApiError } from '../../../../../lib/api';
import { errorMessage } from '../../../../../lib/errors';
import { cancelOrder, type OrderDetail } from '../../../../../lib/orders-api';

export interface CancelSectionProps {
  orderId: string;
  onCancelled: (order: OrderDetail) => void;
}

/** Plain two-step confirm for cancelling an order — per the brief, no
 * `Dialog`-based modal is needed for this: a first click reveals a reason
 * input plus a "¿Confirmar cancelación?" button, and that second click
 * fires the PATCH. Simplest correct UI, matching this app's minimal-chrome
 * style (contrast with `archive-section.tsx`'s `Dialog`, which fits that
 * page's one-click no-extra-field action better than it would fit here). */
export function CancelSection({ orderId, onCancelled }: CancelSectionProps) {
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (!confirming) {
    return (
      <Button variant="destructive" size="sm" onClick={() => setConfirming(true)}>
        Cancelar pedido
      </Button>
    );
  }

  async function handleConfirm() {
    setError(null);
    const reasonTrim = reason.trim();
    if (!reasonTrim) {
      setError('El motivo es requerido.');
      return;
    }
    setSubmitting(true);
    try {
      const updated = await cancelOrder(orderId, { reason: reasonTrim });
      onCancelled(updated);
    } catch (e) {
      setError(e instanceof ApiError ? errorMessage(e) : 'Ocurrió un error inesperado. Intenta de nuevo.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-md border border-destructive/50 p-4">
      {error ? <Alert variant="error">{error}</Alert> : null}
      <FormField label="Motivo de cancelación" htmlFor="cancelReason">
        <Input value={reason} onChange={(event) => setReason(event.target.value)} />
      </FormField>
      <div className="flex gap-2">
        <Button variant="destructive" disabled={submitting} onClick={() => void handleConfirm()}>
          {submitting ? 'Cancelando…' : '¿Confirmar cancelación?'}
        </Button>
        <Button
          variant="secondary"
          disabled={submitting}
          onClick={() => {
            setConfirming(false);
            setReason('');
            setError(null);
          }}
        >
          Volver
        </Button>
      </div>
    </div>
  );
}
