'use client';

import { useState } from 'react';
import { Alert, Button, Card, CardContent, CardHeader, CardTitle, Label } from '@ventia/ui';
import { ApiError, apiFetch } from '../../../../lib/api';
import { errorMessage } from '../../../../lib/errors';

export interface PaymentsStepProps {
  onDone: () => void;
  /** `payments.codEnabled` from the same `GET /v1/admin/settings` fetch
   * `BrandingStep` uses (see wizard.tsx) — pre-fills the toggle so
   * revisiting this already-completed step doesn't reset it back to the
   * hardcoded default and silently flip a merchant's real setting off (or
   * on) the next time they click "Continuar". `undefined` (not fetched yet,
   * or this component used standalone) falls back to the previous default. */
  initialCodEnabled?: boolean;
}

/** `payments` step: the P1 launch only supports cash-on-delivery ("pago
 * contraentrega"), so this step is a single toggle — `PATCH
 * /v1/admin/onboarding { step: 'payments', data: { codEnabled } }`. */
export function PaymentsStep({ onDone, initialCodEnabled }: PaymentsStepProps) {
  const [codEnabled, setCodEnabled] = useState(initialCodEnabled ?? true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleContinue() {
    setError(null);
    setSubmitting(true);
    try {
      await apiFetch('/v1/admin/onboarding', {
        method: 'PATCH',
        body: JSON.stringify({ step: 'payments', data: { codEnabled } }),
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
        <CardTitle>Formas de pago</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error ? <Alert variant="error">{error}</Alert> : null}
        <div className="flex items-center gap-3 rounded-md border border-border p-3">
          <input
            id="codEnabled"
            type="checkbox"
            className="h-4 w-4"
            checked={codEnabled}
            onChange={(event) => setCodEnabled(event.target.checked)}
          />
          <Label htmlFor="codEnabled">Aceptar pago contraentrega</Label>
        </div>
        <Button onClick={() => void handleContinue()} disabled={submitting} className="self-start">
          {submitting ? 'Guardando…' : 'Continuar'}
        </Button>
      </CardContent>
    </Card>
  );
}
