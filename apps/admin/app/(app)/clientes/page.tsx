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
  Dialog,
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
import { ApiError, apiFetch } from '../../../lib/api';
import { errorMessage } from '../../../lib/errors';
import { formatCOP, formatDateCO } from '../../../lib/format';
import {
  CONFIRM_WORD,
  REQUEST_CHANNELS,
  REQUEST_CHANNEL_LABELS,
  anonymizeCustomer,
  anonymizeSummary,
  customerLabel,
  getCustomer,
  listCustomers,
  type AnonymizeResponse,
  type Customer,
  type CustomerDetail,
  type CustomerListResponse,
  type RequestChannel,
} from '../../../lib/customers-api';

const PAGE_SIZE = 20;

/**
 * Clientes (SPEC §6 M8) plus the Ley 1581 de 2012 *derecho de supresión*
 * (SPEC §9) — the screen where a merchant actually honours a "borren mis
 * datos" request.
 *
 * Three pieces, the same shape as `equipo/page.tsx`: a searchable table, a
 * detail dialog, and a confirm dialog for the destructive action. The confirm
 * dialog is deliberately heavier than the rest of this admin: it states in
 * plain es-CO what survives (los montos, las fechas, los pedidos — because
 * Colombian accounting law requires it) and what does not, asks HOW the
 * request arrived, and requires the merchant to type the word. Nothing here
 * is recoverable afterwards.
 *
 * The action is hidden for `staff`. That is an affordance, not the boundary:
 * `@Roles('owner')` on the API handler is what enforces it, and a staff
 * session that reaches the endpoint another way still gets 403.
 */
export default function ClientesPage() {
  const [query, setQuery] = useState('');
  const [submittedQuery, setSubmittedQuery] = useState('');
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<CustomerListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [role, setRole] = useState<'owner' | 'staff' | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setResult(await listCustomers(submittedQuery, page, PAGE_SIZE));
    } catch (e) {
      setLoadError(e instanceof ApiError ? errorMessage(e) : 'Ocurrió un error inesperado. Intenta de nuevo.');
    } finally {
      setLoading(false);
    }
  }, [submittedQuery, page]);

  useEffect(() => {
    void load();
  }, [load]);

  // The role decides whether the supresión button renders at all. Fetched
  // here rather than threaded through the layout because every page in this
  // app is a client component; a failure just leaves the button hidden, which
  // is the safe direction.
  useEffect(() => {
    void (async () => {
      try {
        const me = await apiFetch<{ role: 'owner' | 'staff' }>('/v1/admin/me');
        setRole(me.role);
      } catch {
        setRole(null);
      }
    })();
  }, []);

  function handleSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmittedQuery(query);
    setPage(1);
  }

  // --- detail dialog ---
  const [detail, setDetail] = useState<CustomerDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  async function openDetail(customer: Customer) {
    setDetailOpen(true);
    setDetail(null);
    setDetailError(null);
    setDetailLoading(true);
    try {
      setDetail(await getCustomer(customer.id));
    } catch (e) {
      setDetailError(e instanceof ApiError ? errorMessage(e) : 'Ocurrió un error inesperado. Intenta de nuevo.');
    } finally {
      setDetailLoading(false);
    }
  }

  // --- anonymize dialog ---
  const [target, setTarget] = useState<Customer | null>(null);
  const [channel, setChannel] = useState<RequestChannel>('correo');
  const [typed, setTyped] = useState('');
  const [anonError, setAnonError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState<AnonymizeResponse | null>(null);

  function openAnonymize(customer: Customer) {
    setTarget(customer);
    setChannel('correo');
    setTyped('');
    setAnonError(null);
    setSuccess(null);
  }

  function closeAnonymize() {
    setTarget(null);
    setSuccess(null);
  }

  async function handleAnonymize(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!target || typed.trim().toUpperCase() !== CONFIRM_WORD) return;
    setAnonError(null);
    setSubmitting(true);
    try {
      const response = await anonymizeCustomer(target.id, channel);
      setSuccess(response);
      // Reload rather than patching the row: the server rewrote name, email
      // and phone, and re-reading is the only way this table shows exactly
      // what is now stored.
      await load();
    } catch (e) {
      setAnonError(e instanceof ApiError ? errorMessage(e) : 'Ocurrió un error inesperado. Intenta de nuevo.');
    } finally {
      setSubmitting(false);
    }
  }

  const totalPages = result ? Math.max(1, Math.ceil(result.total / result.pageSize)) : 1;

  return (
    <div className="flex flex-col gap-6">
      <Card className="w-full">
        <CardHeader>
          <CardTitle>Clientes</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          <p className="text-sm text-muted-foreground">
            Los clientes se crean solos con cada pedido. Desde aquí puedes atender una solicitud de eliminación de
            datos personales (Ley 1581 de 2012, Habeas Data).
          </p>

          <form className="flex flex-wrap items-end gap-3" onSubmit={handleSearch}>
            <FormField label="Buscar" htmlFor="clientes-buscar">
              <Input
                id="clientes-buscar"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Nombre, correo o celular"
                className="w-72"
              />
            </FormField>
            <Button type="submit" variant="secondary">
              Buscar
            </Button>
            {submittedQuery ? (
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setQuery('');
                  setSubmittedQuery('');
                  setPage(1);
                }}
              >
                Limpiar
              </Button>
            ) : null}
          </form>

          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner /> Cargando clientes…
            </div>
          ) : loadError ? (
            <div className="flex flex-col gap-3">
              <Alert variant="error">{loadError}</Alert>
              <Button variant="secondary" size="sm" className="self-start" onClick={() => void load()}>
                Reintentar
              </Button>
            </div>
          ) : !result || result.items.length === 0 ? (
            <div className="flex flex-col items-start gap-3 rounded-md border border-dashed border-border p-8">
              <p className="text-sm text-muted-foreground">
                {submittedQuery ? 'No encontramos clientes con esa búsqueda.' : 'Aún no tienes clientes.'}
              </p>
            </div>
          ) : (
            <>
              <Table>
                <Thead>
                  <Tr>
                    <Th>Cliente</Th>
                    <Th>Correo</Th>
                    <Th>Celular</Th>
                    <Th>Pedidos</Th>
                    <Th>Total comprado</Th>
                    <Th>
                      <span className="sr-only">Acciones</span>
                    </Th>
                  </Tr>
                </Thead>
                <Tbody>
                  {result.items.map((customer) => (
                    <Tr key={customer.id}>
                      <Td>
                        <button
                          type="button"
                          className="font-medium text-foreground hover:underline"
                          onClick={() => void openDetail(customer)}
                        >
                          {customerLabel(customer)}
                        </button>
                        {customer.anonymized ? (
                          <Badge variant="secondary" className="ml-2">
                            Anonimizado
                          </Badge>
                        ) : null}
                      </Td>
                      <Td>{customer.anonymized ? '—' : (customer.email ?? '—')}</Td>
                      <Td>{customer.anonymized ? '—' : (customer.phone ?? '—')}</Td>
                      <Td>{customer.ordersCount}</Td>
                      <Td>{formatCOP(customer.totalSpentCents)}</Td>
                      <Td className="flex justify-end">
                        {role === 'owner' && !customer.anonymized ? (
                          <Button variant="destructive" size="sm" onClick={() => openAnonymize(customer)}>
                            Eliminar datos
                          </Button>
                        ) : null}
                      </Td>
                    </Tr>
                  ))}
                </Tbody>
              </Table>

              <div className="flex items-center justify-between">
                <p className="text-sm text-muted-foreground">
                  Página {result.page} de {totalPages} · {result.total} cliente{result.total === 1 ? '' : 's'}
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
                    disabled={page >= totalPages}
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  >
                    Siguiente
                  </Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Dialog open={detailOpen} onClose={() => setDetailOpen(false)}>
        <div className="flex flex-col gap-4">
          <h2 className="text-lg font-semibold text-foreground">Detalle del cliente</h2>
          {detailLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner /> Cargando…
            </div>
          ) : detailError ? (
            <Alert variant="error">{detailError}</Alert>
          ) : detail ? (
            <>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                <dt className="text-muted-foreground">Nombre</dt>
                <dd className="text-foreground">{detail.name ?? '—'}</dd>
                <dt className="text-muted-foreground">Correo</dt>
                <dd className="text-foreground">{detail.email ?? '—'}</dd>
                <dt className="text-muted-foreground">Celular</dt>
                <dd className="text-foreground">{detail.phone ?? '—'}</dd>
                <dt className="text-muted-foreground">Total comprado</dt>
                <dd className="text-foreground">{formatCOP(detail.totalSpentCents)}</dd>
              </dl>
              {detail.anonymized ? (
                <Alert variant="success">
                  Los datos personales de este cliente ya fueron eliminados. Los pedidos y sus montos se conservan
                  por obligación contable.
                </Alert>
              ) : null}
              <h3 className="text-sm font-semibold text-foreground">Pedidos</h3>
              {detail.orders.length === 0 ? (
                <p className="text-sm text-muted-foreground">Este cliente no tiene pedidos.</p>
              ) : (
                <Table>
                  <Thead>
                    <Tr>
                      <Th>Pedido</Th>
                      <Th>Estado</Th>
                      <Th>Total</Th>
                      <Th>Fecha</Th>
                    </Tr>
                  </Thead>
                  <Tbody>
                    {detail.orders.map((order) => (
                      <Tr key={order.id}>
                        <Td>
                          <a href={`/pedidos/${order.id}`} className="font-medium text-foreground hover:underline">
                            VNT-{order.number}
                          </a>
                        </Td>
                        <Td>{order.status}</Td>
                        <Td>{formatCOP(order.totalCents)}</Td>
                        <Td>{formatDateCO(order.createdAt)}</Td>
                      </Tr>
                    ))}
                  </Tbody>
                </Table>
              )}
            </>
          ) : null}
          <div className="flex justify-end">
            <Button variant="secondary" onClick={() => setDetailOpen(false)}>
              Cerrar
            </Button>
          </div>
        </div>
      </Dialog>

      <Dialog open={target !== null} onClose={closeAnonymize}>
        {success ? (
          <div className="flex flex-col gap-4">
            <h2 className="text-lg font-semibold text-foreground">Datos eliminados</h2>
            <Alert variant="success">{anonymizeSummary(success)}</Alert>
            <p className="text-xs text-muted-foreground">
              Quedó registrado en el historial de auditoría de tu tienda quién realizó la eliminación y cuándo. El
              registro no contiene los datos personales eliminados.
            </p>
            <div className="flex justify-end">
              <Button onClick={closeAnonymize}>Cerrar</Button>
            </div>
          </div>
        ) : (
          <form className="flex flex-col gap-4" onSubmit={handleAnonymize}>
            <h2 className="text-lg font-semibold text-foreground">Eliminar datos personales</h2>
            <Alert variant="error">
              Esta acción no se puede deshacer. Al confirmar, eliminamos para siempre el nombre, el correo, el
              celular y la dirección de <span className="font-medium">{target ? customerLabel(target) : ''}</span>,
              en sus pedidos, en sus conversaciones con el agente y en los registros internos.
            </Alert>
            <p className="text-sm text-foreground">
              <span className="font-medium">Lo que se conserva:</span> los pedidos, sus montos, impuestos, fechas y
              estados, y el departamento y municipio de envío. La ley colombiana exige guardar esa información
              contable, así que los pedidos no se borran: se quedan sin ninguna referencia a la persona.
            </p>
            {anonError ? <Alert variant="error">{anonError}</Alert> : null}
            <FormField label="¿Cómo llegó la solicitud?" htmlFor="anon-canal">
              <Select
                id="anon-canal"
                value={channel}
                onChange={(event) => setChannel(event.target.value as RequestChannel)}
              >
                {REQUEST_CHANNELS.map((value) => (
                  <option key={value} value={value}>
                    {REQUEST_CHANNEL_LABELS[value]}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField label={`Escribe ${CONFIRM_WORD} para confirmar`} htmlFor="anon-confirmar">
              <Input
                id="anon-confirmar"
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
                autoComplete="off"
                autoFocus
              />
            </FormField>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={closeAnonymize}>
                Cancelar
              </Button>
              <Button
                type="submit"
                variant="destructive"
                disabled={submitting || typed.trim().toUpperCase() !== CONFIRM_WORD}
              >
                {submitting ? 'Eliminando…' : 'Eliminar datos'}
              </Button>
            </div>
          </form>
        )}
      </Dialog>
    </div>
  );
}
