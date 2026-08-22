'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { AGENT_TONES, type AgentTone } from '@ventia/core';
import { Alert, Button, FormField, Input, Select, Spinner } from '@ventia/ui';
import { ApiError, apiFetch } from '../lib/api';
import { errorMessage, fieldErrors } from '../lib/errors';
import { formatCOP } from '../lib/format';
import { CONSUMO_PATH, fetchAgentUsage, type AgentUsageResponse } from '../lib/agent-usage-api';
import { ConsumoPanel } from './consumo-panel';
import type { SettingsResponse, TabProps } from '../app/(app)/configuracion/page';

/**
 * Asistente IA tab: the merchant's configuration of the AI sales agent
 * (docs/SPEC.md §7), plus this month's usage and what the agent has sold.
 *
 * The two halves sit together deliberately. A merchant tuning the tone is
 * exactly the person who needs to see whether the thing is earning its
 * allowance.
 *
 * This is no longer the ONLY place those numbers appear — `/consumo` is, and
 * it is in the sidebar for both roles. That page exists because reaching the
 * allowance stopped being an event the merchant notices: credits past it are
 * billed rather than refused, so nothing prompts anyone to come looking here.
 * What stays is the summary, rendered by the same shared component so the two
 * screens cannot disagree, with a link to the detail.
 */

const TONE_LABELS: Record<AgentTone, string> = {
  cercano: 'Cercano — tutea al cliente, cálido',
  profesional: 'Profesional — claro y sobrio',
  juvenil: 'Juvenil — relajado, sin perder el respeto',
};


export function AgenteTab({ settings, onSaved }: TabProps) {
  const agent = settings.agent ?? {};
  const [agentName, setAgentName] = useState(agent.agentName ?? '');
  const [tone, setTone] = useState<AgentTone>(agent.tone ?? 'cercano');
  const [storeSummary, setStoreSummary] = useState(agent.storeSummary ?? '');
  const [policiesSummary, setPoliciesSummary] = useState(agent.policiesSummary ?? '');
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
      const updated = await apiFetch<SettingsResponse>('/v1/admin/settings/agent', {
        method: 'PATCH',
        // Sent even when blank so clearing a summary actually clears it —
        // the server merges field-by-field, so an omitted key means "leave
        // it alone", which is not what an emptied textarea means.
        body: JSON.stringify({ agentName: agentName.trim() || undefined, tone, storeSummary, policiesSummary }),
      });
      onSaved(updated);
      setSaved(true);
    } catch (e) {
      if (e instanceof ApiError) {
        setError(errorMessage(e));
        setErrors(fieldErrors(e));
      } else {
        setError('Ocurrió un error inesperado. Intenta de nuevo.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <UsagePanel />

      <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
        {error ? <Alert variant="error">{error}</Alert> : null}
        {saved ? <Alert variant="success">Guardamos la configuración de tu asistente.</Alert> : null}

        <FormField label="Nombre del asistente" htmlFor="agentName" error={errors.agentName}>
          <Input
            id="agentName"
            value={agentName}
            onChange={(e) => setAgentName(e.target.value)}
            placeholder="Asesor"
            maxLength={40}
          />
        </FormField>

        <FormField label="Tono" htmlFor="tone" error={errors.tone}>
          <Select id="tone" value={tone} onChange={(e) => setTone(e.target.value as AgentTone)}>
            {AGENT_TONES.map((value) => (
              <option key={value} value={value}>
                {TONE_LABELS[value]}
              </option>
            ))}
          </Select>
        </FormField>

        <FormField label="Sobre tu tienda" htmlFor="storeSummary" error={errors.storeSummary}>
          <textarea
            id="storeSummary"
            value={storeSummary}
            onChange={(e) => setStoreSummary(e.target.value)}
            maxLength={600}
            rows={4}
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
          />
        </FormField>
        <p className="-mt-3 text-xs text-muted-foreground">
          Qué vendes y qué te hace distinto. El asistente lo usa para presentarte.
        </p>

        <FormField label="Políticas clave" htmlFor="policiesSummary" error={errors.policiesSummary}>
          <textarea
            id="policiesSummary"
            value={policiesSummary}
            onChange={(e) => setPoliciesSummary(e.target.value)}
            maxLength={600}
            rows={4}
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
          />
        </FormField>
        <p className="-mt-3 text-xs text-muted-foreground">
          Cambios, garantías, tiempos de envío. El asistente nunca inventa una política que no esté aquí ni publicada
          en tu tienda.
        </p>

        <Button type="submit" className="self-start" disabled={submitting}>
          {submitting ? 'Guardando…' : 'Guardar'}
        </Button>
      </form>
    </div>
  );
}

/**
 * This month's credit usage and AI-assisted sales.
 *
 * Fetched here rather than threaded down from the page: it is not part of
 * `GET /v1/admin/settings` (it is a different question with a different
 * cache lifetime), and nothing else on the page needs it.
 *
 * The bar, the thresholds and every sentence come from `ConsumoPanel`, shared
 * with `/consumo`. This panel used to own its own copy of all three, and after
 * the switch to credits with billed overage that copy was actively wrong: it
 * told a merchant at 100% that "tu asistente dejó de responder por chat hasta
 * el próximo mes" while the agent was in fact still answering every shopper
 * and quietly billing the difference. Two renderings of one month's usage is
 * one rendering too many.
 *
 * The merchant-assistant reserve notice is suppressed here (`mostrarAsistente`
 * false): on a settings tab about the SHOPPER agent's tone, a paragraph about
 * why the owner's own questions are paused is a digression. `/consumo` carries
 * it, and the link below leads there.
 */
function UsagePanel() {
  const [usage, setUsage] = useState<AgentUsageResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      setUsage(await fetchAgentUsage());
    } catch (e) {
      setLoadError(e instanceof ApiError ? errorMessage(e) : 'No pudimos cargar el consumo.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loadError) return <Alert variant="error">{loadError}</Alert>;
  if (!usage) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner /> Cargando consumo…
      </p>
    );
  }

  const { orders, revenueCents, totalOrders } = usage.assistedSales;

  return (
    <div className="flex flex-col gap-4 rounded-md border border-border p-4">
      <h3 className="text-sm font-medium">Créditos de IA este mes</h3>

      <ConsumoPanel credits={usage.credits} mostrarAsistente={false} />

      <div className="flex flex-col gap-1 border-t border-border pt-3">
        <h3 className="text-sm font-medium">Ventas asistidas por IA</h3>
        <p className="text-2xl font-semibold">{formatCOP(revenueCents)}</p>
        <p className="text-sm text-muted-foreground">
          {orders} de {totalOrders} {totalOrders === 1 ? 'pedido' : 'pedidos'} este mes
        </p>
      </div>

      <p className="text-xs text-muted-foreground">
        <Link href={CONSUMO_PATH} className="underline">
          Ver el detalle de tu consumo
        </Link>
      </p>
    </div>
  );
}
