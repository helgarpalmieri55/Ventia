'use client';

import { useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, Select, Spinner, Table, Tbody, Td, Th, Thead, Tr } from '@ventia/ui';
import { ApiError } from '../../../lib/api';
import { errorMessage } from '../../../lib/errors';
import { formatCOP, formatDateCO } from '../../../lib/format';
import {
  STATUS_BADGE_VARIANT,
  STATUS_LABEL,
  listOrders,
  vnt,
  type OrderListResponse,
  type OrderStatus,
  type OrderStatusFilter,
} from '../../../lib/orders-api';

const PAGE_SIZE = 20;

const STATUS_OPTIONS: OrderStatus[] = ['PENDING', 'CONFIRMED', 'PREPARING', 'SHIPPED', 'DELIVERED', 'CANCELLED'];

/** Orders list: a status filter, a paginated table, and an es-CO empty
 * state — same shape as `productos/page.tsx`, minus the free-text search
 * (the brief doesn't ask for order search by number/customer). The customer
 * column shows `email` rather than a name: `OrderDTO` carries `customerId`/
 * `email`/`phone` but no `customerName` field, and this list endpoint
 * doesn't join to any name source — inventing an extra per-row API call
 * just for a display name isn't warranted here. */
export default function PedidosPage() {
  const [status, setStatus] = useState<OrderStatusFilter>('');
  const [page, setPage] = useState(1);

  const [result, setResult] = useState<OrderListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const response = await listOrders({ status, page, pageSize: PAGE_SIZE });
      setResult(response);
    } catch (e) {
      setLoadError(e instanceof ApiError ? errorMessage(e) : 'Ocurrió un error inesperado. Intenta de nuevo.');
    } finally {
      setLoading(false);
    }
  }, [status, page]);

  useEffect(() => {
    void load();
  }, [load]);

  function handleStatusChange(value: OrderStatusFilter) {
    setStatus(value);
    setPage(1);
  }

  const totalPages = result ? Math.max(1, Math.ceil(result.total / result.pageSize)) : 1;
  const isFiltered = status !== '';

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle>Pedidos</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <div className="flex flex-wrap items-center gap-3">
          <Select
            value={status}
            onChange={(event) => handleStatusChange(event.target.value as OrderStatusFilter)}
            className="max-w-48"
            aria-label="Filtrar por estado"
          >
            <option value="">Todos</option>
            {STATUS_OPTIONS.map((value) => (
              <option key={value} value={value}>
                {STATUS_LABEL[value]}
              </option>
            ))}
          </Select>
        </div>

        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> Cargando pedidos…
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
              {isFiltered ? 'No encontramos pedidos con ese filtro.' : 'Aún no tienes pedidos.'}
            </p>
          </div>
        ) : (
          <>
            <Table>
              <Thead>
                <Tr>
                  <Th>Pedido</Th>
                  <Th>Cliente</Th>
                  <Th>Total</Th>
                  <Th>Estado</Th>
                  <Th>Fecha</Th>
                </Tr>
              </Thead>
              <Tbody>
                {result.items.map((order) => (
                  <Tr key={order.id}>
                    <Td>
                      <a href={`/pedidos/${order.id}`} className="font-medium text-foreground hover:underline">
                        {vnt(order.number)}
                      </a>
                    </Td>
                    <Td>{order.email}</Td>
                    <Td>{formatCOP(order.totalCents)}</Td>
                    <Td>
                      <Badge variant={STATUS_BADGE_VARIANT[order.status]}>{STATUS_LABEL[order.status]}</Badge>
                    </Td>
                    <Td>{formatDateCO(order.createdAt)}</Td>
                  </Tr>
                ))}
              </Tbody>
            </Table>

            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                Página {result.page} de {totalPages} · {result.total} pedido{result.total === 1 ? '' : 's'}
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
  );
}
