'use client';

import { useState, type FormEvent } from 'react';
import { Alert, Button, Card, CardContent, CardHeader, CardTitle, FormField, Input, Select } from '@ventia/ui';
import {
  PLAN_IDS,
  PLAN_LABELS,
  assignPlan,
  planChangeSummary,
  platformErrorText,
  type PlanId,
  type PlatformTenantDetail,
} from '../../../../../lib/platform-api';

export interface PlanPanelProps {
  tenant: PlatformTenantDetail;
  /** Re-reads the tenant from the API. The response of `PATCH .../plan`
   * carries the new plan and limits, but not the recomputed `limitsMatchPlan`
   * flag or anything else on the page, and patching half the view from a
   * mutation response is how a screen starts disagreeing with the database. */
  onChanged: () => void | Promise<void>;
}

/**
 * Asignar plan. Writing the plan also rewrites `TenantLimits` in the same
 * transaction server-side, which is why the confirmation copy says so: an
 * operator re-assigning the SAME plan is performing a repair (fixing drifted
 * limits), not a no-op, and the button has to read as one.
 */
export function PlanPanel({ tenant, onChanged }: PlanPanelProps) {
  const [plan, setPlan] = useState<PlanId>(tenant.plan);
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSuccess(null);
    setSubmitting(true);
    try {
      const result = await assignPlan(tenant.id, plan, note);
      setSuccess(planChangeSummary(result));
      setNote('');
      await onChanged();
    } catch (e) {
      setError(platformErrorText(e));
    } finally {
      setSubmitting(false);
    }
  }

  const isRepair = plan === tenant.plan;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Plan</CardTitle>
      </CardHeader>
      <CardContent>
        <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
          {error ? <Alert variant="error">{error}</Alert> : null}
          {success ? <Alert variant="success">{success}</Alert> : null}

          <FormField label="Plan asignado" htmlFor="plan-select">
            <Select
              id="plan-select"
              value={plan}
              onChange={(event) => setPlan(event.target.value as PlanId)}
              className="w-56"
            >
              {PLAN_IDS.map((value) => (
                <option key={value} value={value}>
                  {PLAN_LABELS[value]}
                </option>
              ))}
            </Select>
          </FormField>

          <FormField label="Nota para la auditoría (opcional)" htmlFor="plan-nota">
            <Input
              id="plan-nota"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Ej.: acuerdo comercial del 12/08"
              maxLength={500}
            />
          </FormField>

          <p className="text-xs text-muted-foreground">
            Guardar reescribe los límites del comercio (productos, mensajes de IA, usuarios, dominio propio,
            handoff humano y WhatsApp) para que coincidan con el plan. Queda registrado en la auditoría con tu
            correo de operador.
          </p>

          <div>
            <Button type="submit" disabled={submitting}>
              {submitting ? 'Guardando…' : isRepair ? 'Reaplicar límites del plan' : 'Cambiar plan'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
