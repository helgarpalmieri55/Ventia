'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  FormField,
  Input,
  Select,
  Spinner,
  Table,
  Tbody,
  Td,
  Th,
  Thead,
  Tr,
} from '@ventia/ui';
import { formatCOP, formatDateCO } from '../../../lib/format';
import {
  PLAN_IDS,
  PLAN_LABELS,
  TENANT_STATUSES,
  TENANT_STATUS_BADGE,
  TENANT_STATUS_LABELS,
  aiUsageLabel,
  aiUsageLevel,
  formatMonthCO,
  listPlatformTenants,
  platformErrorText,
  platformTenantPath,
  type PlanId,
  type PlatformTenantList,
  type TenantStatus,
} from '../../../lib/platform-api';

const PER_PAGE = 25;

/**
 * Listado de comercios — the operator's first screen (SPEC §6 M9).
 *
 * Structurally the same as `pedidos/page.tsx` and `clientes/page.tsx`: search
 * form, filters, table, pagination, es-CO empty state. Deliberately so — an
 * operator is also a person who knows this admin, and making the *mechanics*
 * familiar is what frees the visual treatment to shout about whose data this
 * is. Novelty is spent on the one thing that matters here (you are not
 * looking at your own store), not on rearranging a table.
 *
 * Every row names the tenant's slug in monospace next to its name. That is
 * not decoration: the slug is what the suspend confirmation asks the operator
 * to type, so it has to be legible from the list they are working through.
 */
export default function PlataformaPage() {
  const [query, setQuery] = useState('');
  const [submittedQuery, setSubmittedQuery] = useState('');
  const [status, setStatus] = useState<TenantStatus | ''>('');
  const [plan, setPlan] = useState<PlanId | ''>('');
  const [page, setPage] = useState(1);

  const [result, setResult] = useState<PlatformTenantList | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setResult(await listPlatformTenants({ q: submittedQuery, status, plan, page, perPage: PER_PAGE }));
    } catch (e) {
      setLoadError(platformErrorText(e));
    } finally {
      setLoading(false);
    }
  }, [submittedQuery, status, plan, page]);

  useEffect(() => {
    void load();
  }, [load]);

  function handleSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmittedQuery(query);
    setPage(1);
  }

  function clearFilters() {
    setQuery('');
    setSubmittedQuery('');
    setStatus('');
    setPlan('');
    setPage(1);
  }

  const isFiltered = submittedQuery !== '' || status !== '' || plan !== '';

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle>Comercios</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <p className="text-sm text-muted-foreground">
          Todas las cuentas de la plataforma. El GMV suma los pedidos no cancelados de cada comercio; el uso de IA
          es del mes en curso
          {result ? <> ({formatMonthCO(result.month)})</> : null}.
        </p>

        <form className="flex flex-wrap items-end gap-3" onSubmit={handleSearch}>
          <FormField label="Buscar" htmlFor="plataforma-buscar">
            <Input
              id="plataforma-buscar"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Nombre o URL de la tienda"
              className="w-72"
            />
          </FormField>
          <FormField label="Estado" htmlFor="plataforma-estado">
            <Select
              id="plataforma-estado"
              value={status}
              onChange={(event) => {
                setStatus(event.target.value as TenantStatus | '');
                setPage(1);
              }}
              className="w-48"
            >
              <option value="">Todos</option>
              {TENANT_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {TENANT_STATUS_LABELS[value]}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="Plan" htmlFor="plataforma-plan">
            <Select
              id="plataforma-plan"
              value={plan}
              onChange={(event) => {
                setPlan(event.target.value as PlanId | '');
                setPage(1);
              }}
              className="w-40"
            >
              <option value="">Todos</option>
              {PLAN_IDS.map((value) => (
                <option key={value} value={value}>
                  {PLAN_LABELS[value]}
                </option>
              ))}
            </Select>
          </FormField>
          <Button type="submit" variant="secondary">
            Buscar
          </Button>
          {isFiltered ? (
            <Button type="button" variant="secondary" onClick={clearFilters}>
              Limpiar
            </Button>
          ) : null}
        </form>

        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> Cargando comercios…
          </div>
        ) : loadError ? (
          <div className="flex flex-col gap-3">
            <Alert variant="error">{loadError}</Alert>
            <Button variant="secondary" size="sm" className="self-start" onClick={() => void load()}>
              Reintentar
            </Button>
          </div>
        ) : !result || result.tenants.length === 0 ? (
          <div className="flex flex-col items-start gap-3 rounded-md border border-dashed border-border p-8">
            <p className="text-sm text-muted-foreground">
              {isFiltered ? 'No encontramos comercios con esos filtros.' : 'Todavía no hay comercios registrados.'}
            </p>
          </div>
        ) : (
          <>
            <Table>
              <Thead>
                <Tr>
                  <Th>Comercio</Th>
                  <Th>Plan</Th>
                  <Th>Estado</Th>
                  <Th>GMV</Th>
                  <Th>Pedidos</Th>
                  <Th>IA del mes</Th>
                  <Th>Registro</Th>
                </Tr>
              </Thead>
              <Tbody>
                {result.tenants.map((tenant) => {
                  const level = aiUsageLevel(tenant.ai);
                  return (
                    <Tr key={tenant.id}>
                      <Td>
                        <a
                          href={platformTenantPath(tenant.id)}
                          className="font-medium text-foreground hover:underline"
                        >
                          {tenant.name}
                        </a>
                        <div className="font-mono text-xs text-muted-foreground">{tenant.slug}</div>
                      </Td>
                      <Td>{PLAN_LABELS[tenant.plan]}</Td>
                      <Td>
                        <Badge variant={TENANT_STATUS_BADGE[tenant.status]}>
                          {TENANT_STATUS_LABELS[tenant.status]}
                        </Badge>
                      </Td>
                      <Td>{formatCOP(tenant.gmv.totalCents)}</Td>
                      <Td>{tenant.gmv.orders}</Td>
                      <Td>
                        <span
                          className={
                            level === 'excedido' || level === 'sin-cupo'
                              ? 'text-destructive'
                              : level === 'alerta'
                                ? 'text-amber-700'
                                : 'text-foreground'
                          }
                        >
                          {aiUsageLabel(tenant.ai)}
                        </span>
                        <div className="text-xs text-muted-foreground">
                          {tenant.ai.messages} / {tenant.ai.messagesLimit} mensajes ·{' '}
                          {formatCOP(tenant.ai.costCents)}
                        </div>
                      </Td>
                      <Td>{formatDateCO(tenant.createdAt)}</Td>
                    </Tr>
                  );
                })}
              </Tbody>
            </Table>

            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                Página {result.page} de {result.totalPages} · {result.total} comercio
                {result.total === 1 ? '' : 's'}
              </p>
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  Anterior
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={page >= result.totalPages}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Siguiente
                </Button>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
