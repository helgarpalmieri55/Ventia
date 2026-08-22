'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, Spinner } from '@ventia/ui';
import { formatCOP, formatDateCO } from '../../../../lib/format';
import {
  PLAN_LABELS,
  PLATFORM_PATH,
  TENANT_STATUS_BADGE,
  TENANT_STATUS_LABELS,
  aiUsageLabel,
  aiUsageLevel,
  formatMonthCO,
  getPlatformTenant,
  platformErrorText,
  type PlatformTenantDetail,
} from '../../../../lib/platform-api';
import { PlanPanel } from './_components/plan-panel';
import { ImpersonationPanel } from './_components/impersonation-panel';
import { StatusPanel } from './_components/status-panel';
import { SubscriptionPanel } from './_components/subscription-panel';

/** One metric, one number. Used for the row of headline figures. */
function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-md border border-border p-4">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-xl font-semibold text-foreground">{value}</p>
      {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function YesNo({ value }: { value: boolean }) {
  return <>{value ? 'Sí' : 'No'}</>;
}

/**
 * Detalle de un comercio (SPEC §6 M9): plan, estado, GMV, uso y costo de IA
 * del mes, más los límites provisionados y las acciones de operador.
 *
 * The page opens with an identity block rather than with metrics, and that
 * ordering is the point: before an operator reads a single number about
 * another company, they read whose company it is. The name is the largest
 * thing on the page, the slug sits under it in monospace (it is what the
 * suspend dialog will ask them to type), and the whole block is bounded so it
 * reads as a header for someone else's account rather than as this app's own
 * page title.
 */
export default function PlataformaTenantPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;

  const [tenant, setTenant] = useState<PlatformTenantDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setTenant(await getPlatformTenant(id));
    } catch (e) {
      setLoadError(platformErrorText(e));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  // Reload without the full-page spinner: the mutation panels stay mounted so
  // their own success alerts survive the refresh.
  const reload = useCallback(async () => {
    try {
      setTenant(await getPlatformTenant(id));
    } catch {
      /* the panel that triggered this already reported its own failure */
    }
  }, [id]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner /> Cargando comercio…
      </div>
    );
  }

  if (loadError || !tenant) {
    return (
      <div className="flex flex-col items-start gap-3">
        <Alert variant="error">{loadError ?? 'No encontramos este comercio.'}</Alert>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={() => void load()}>
            Reintentar
          </Button>
          <a href={PLATFORM_PATH} className="text-sm font-medium text-primary hover:underline">
            Volver al listado
          </a>
        </div>
      </div>
    );
  }

  const level = aiUsageLevel(tenant.ai);

  return (
    <div className="flex flex-col gap-6">
      <a href={PLATFORM_PATH} className="text-sm text-muted-foreground hover:underline">
        ← Volver a comercios
      </a>

      {/* --- identity: whose account this is, before anything else --- */}
      <div className="rounded-md border-2 border-primary/60 bg-background p-5">
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-primary">Cuenta de comercio</p>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold text-foreground">{tenant.name}</h1>
          <Badge variant={TENANT_STATUS_BADGE[tenant.status]}>{TENANT_STATUS_LABELS[tenant.status]}</Badge>
          <span className="text-sm text-muted-foreground">Plan {PLAN_LABELS[tenant.plan]}</span>
        </div>
        <p className="mt-1 font-mono text-sm text-muted-foreground">{tenant.slug}</p>
        <p className="mt-3 text-xs text-muted-foreground">
          Registrada el {formatDateCO(tenant.createdAt)} · {tenant.counts.staff} usuario
          {tenant.counts.staff === 1 ? '' : 's'} · {tenant.counts.products} producto
          {tenant.counts.products === 1 ? '' : 's'}
        </p>
        {tenant.domains.length > 0 ? (
          <ul className="mt-3 flex flex-wrap gap-2">
            {tenant.domains.map((domain) => (
              <li
                key={domain.domain}
                className="rounded-md border border-border px-2 py-1 font-mono text-xs text-foreground"
              >
                {domain.domain}
                {domain.isPrimary ? <span className="ml-2 text-primary">principal</span> : null}
                {domain.verifiedAt ? null : <span className="ml-2 text-muted-foreground">sin verificar</span>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-xs text-muted-foreground">Sin dominios registrados.</p>
        )}
      </div>

      {/* --- headline metrics --- */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Metric
          label="GMV histórico"
          value={formatCOP(tenant.gmv.totalCents)}
          hint={`${tenant.gmv.orders} pedido${tenant.gmv.orders === 1 ? '' : 's'} sin cancelar`}
        />
        <Metric
          label={`Mensajes de IA · ${formatMonthCO(tenant.month)}`}
          value={`${tenant.ai.messages} / ${tenant.ai.messagesLimit}`}
          hint={aiUsageLabel(tenant.ai)}
        />
        <Metric
          label={`Costo de IA · ${formatMonthCO(tenant.month)}`}
          value={formatCOP(tenant.ai.costCents)}
          hint={`${tenant.ai.inputTokens.toLocaleString('es-CO')} tokens de entrada · ${tenant.ai.outputTokens.toLocaleString('es-CO')} de salida`}
        />
        <Metric label="Productos" value={String(tenant.counts.products)} hint={`${tenant.counts.staff} usuarios`} />
      </div>

      {level === 'sin-cupo' ? (
        <Alert variant="error">
          Este comercio tiene cupo de IA cero: su agente rechaza cada mensaje de sus clientes. Suele significar que
          nunca se le provisionaron límites — reaplicar el plan lo corrige.
        </Alert>
      ) : level === 'excedido' ? (
        <Alert variant="warning">
          Este comercio agotó su cupo de mensajes de IA del mes. Su agente ya no responde hasta el próximo mes o
          hasta que cambie de plan.
        </Alert>
      ) : null}

      {/* --- provisioned limits, and whether they match the plan --- */}
      <Card>
        <CardHeader>
          <CardTitle>Límites provisionados</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {tenant.limitsMatchPlan ? null : (
            <Alert variant="warning">
              Los límites guardados no coinciden con el plan {PLAN_LABELS[tenant.plan]}. Lo que se aplica de verdad
              es esta tabla, no el plan: reaplica el plan abajo para volver a sincronizarlos.
            </Alert>
          )}
          {tenant.limits ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr_auto_1fr]">
              <dt className="text-muted-foreground">Productos</dt>
              <dd className="text-foreground">{tenant.limits.productsMax}</dd>
              <dt className="text-muted-foreground">Mensajes de IA / mes</dt>
              <dd className="text-foreground">{tenant.limits.aiCreditsMonth}</dd>
              <dt className="text-muted-foreground">Usuarios</dt>
              <dd className="text-foreground">{tenant.limits.staffSeats}</dd>
              <dt className="text-muted-foreground">Dominio propio</dt>
              <dd className="text-foreground">
                <YesNo value={tenant.limits.customDomain} />
              </dd>
              <dt className="text-muted-foreground">Handoff humano</dt>
              <dd className="text-foreground">
                <YesNo value={tenant.limits.humanHandoff} />
              </dd>
              <dt className="text-muted-foreground">Canal de WhatsApp</dt>
              <dd className="text-foreground">
                <YesNo value={tenant.limits.whatsappChannel} />
              </dd>
            </dl>
          ) : (
            <p className="text-sm text-muted-foreground">
              Este comercio no tiene una fila de límites. En la práctica eso significa cupo de IA cero.
            </p>
          )}
        </CardContent>
      </Card>

      <ImpersonationPanel tenant={tenant} />

      <SubscriptionPanel tenant={tenant} onChanged={reload} />

      <PlanPanel tenant={tenant} onChanged={reload} />

      <StatusPanel tenant={tenant} onChanged={reload} />
    </div>
  );
}
