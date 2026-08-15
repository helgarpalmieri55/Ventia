'use client';

import { useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, Spinner, Table, Tbody, Td, Th, Thead, Tr } from '@ventia/ui';
import { ApiError } from '../../../lib/api';
import { errorMessage } from '../../../lib/errors';
import { formatCOP, formatDateCO } from '../../../lib/format';
import { STATUS_BADGE_VARIANT, STATUS_LABEL, vnt } from '../../../lib/orders-api';
import {
  alertsCountLabel,
  listPaymentAlerts,
  providerLabel,
  type PaymentAlertListResponse,
} from '../../../lib/payment-alerts-api';

const PAGE_SIZE = 20;

/**
 * "Pagos por revisar" — the detail surface for the one payment outcome that
 * needs a human: a gateway confirmed a payment, the money left the shopper's
 * account, and the order it was for had already been cancelled (almost always
 * by the 15-minute stock-reservation expiry) so it could not be settled.
 *
 * Structure follows `/pedidos`'s page exactly — a `Card`, a client-side
 * `apiFetch` in a `useCallback` + `useEffect`, an `ApiError` -> `errorMessage`
 * failure state with a "Reintentar" button, a dashed empty state, a `Table`,
 * and the same pagination footer — so this reads as part of the same app
 * rather than a bolted-on admin tool.
 *
 * Two things it does NOT do, both deliberate:
 *
 *  - **No status filter.** Every row here is the same single condition. A
 *    filter would imply there are variants worth separating; there are not.
 *  - **No "marcar como revisado" button.** Argued at length on the API
 *    controller: hiding a real financial discrepancy behind a one-click
 *    dismiss, with no record of who dismissed it or what they did about it,
 *    is a worse outcome than the nag. The resolution path is out of band
 *    (refund in the gateway, or recreate the order) and the page says so
 *    explicitly instead of pretending the button resolves anything.
 */
export default function PagosPorRevisarPage() {
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<PaymentAlertListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const response = await listPaymentAlerts({ page, pageSize: PAGE_SIZE });
      setResult(response);
    } catch (e) {
      setLoadError(e instanceof ApiError ? errorMessage(e) : 'Ocurrió un error inesperado. Intenta de nuevo.');
    } finally {
      setLoading(false);
    }
  }, [page]);

  useEffect(() => {
    void load();
  }, [load]);

  const totalPages = result ? Math.max(1, Math.ceil(result.total / result.pageSize)) : 1;
  const hasAlerts = result !== null && result.items.length > 0;

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle>Pagos por revisar</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <div className="flex flex-col gap-2 text-sm text-muted-foreground">
          <p>
            Aquí aparecen los pagos que tu pasarela confirmó, pero que no se pudieron aplicar a su pedido: cuando
            llegó la confirmación, el pedido ya estaba cancelado. Esto pasa, sobre todo, cuando el cliente demora
            más de 15 minutos en pagar y la reserva de inventario del pedido vence.
          </p>
          {/* Only when there is something to act on: on an empty page this
              same sentence would tell a merchant with nothing wrong that a
              customer of theirs was charged for nothing. */}
          {hasAlerts ? (
            <p className="font-medium text-foreground">
              En estos casos al cliente sí le cobraron, pero no tiene un pedido. Necesitas revisarlos uno por uno.
            </p>
          ) : null}
        </div>

        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> Cargando pagos…
          </div>
        ) : loadError ? (
          <div className="flex flex-col gap-3">
            <Alert variant="error">{loadError}</Alert>
            <Button variant="secondary" size="sm" className="self-start" onClick={() => void load()}>
              Reintentar
            </Button>
          </div>
        ) : !hasAlerts ? (
          <div className="flex flex-col items-start gap-2 rounded-md border border-dashed border-border p-8">
            <p className="text-sm font-medium text-foreground">No tienes pagos por revisar.</p>
            <p className="text-sm text-muted-foreground">
              Si alguna vez una pasarela confirma un pago que no se pudo aplicar a su pedido, lo verás aquí y te
              avisaremos en todas las pantallas del panel.
            </p>
          </div>
        ) : (
          <>
            <Alert variant="error">
              <p className="font-semibold">Qué hacer con cada pago</p>
              <ol className="mt-2 list-decimal space-y-1 pl-5">
                <li>
                  Busca la referencia en el panel de tu pasarela y confirma que el pago se recibió de verdad.
                </li>
                <li>
                  Si todavía tienes el inventario, comunícate con el cliente y toma el pedido de nuevo. Recuerda
                  que el pago ya está hecho: no le cobres dos veces.
                </li>
                <li>Si no puedes cumplir el pedido, devuélvele el dinero desde el panel de tu pasarela y avísale.</li>
              </ol>
            </Alert>

            <Table>
              <Thead>
                <Tr>
                  <Th>Pedido</Th>
                  <Th>Monto cobrado</Th>
                  <Th>Pasarela</Th>
                  <Th>Referencia de la pasarela</Th>
                  <Th>Fecha del pago</Th>
                  <Th>Estado del pedido</Th>
                </Tr>
              </Thead>
              <Tbody>
                {result.items.map((alert) => (
                  <Tr key={alert.id}>
                    <Td>
                      {alert.order ? (
                        <a href={`/pedidos/${alert.order.id}`} className="font-medium text-foreground hover:underline">
                          {vnt(alert.order.number)}
                        </a>
                      ) : (
                        <span className="text-muted-foreground">
                          {alert.orderNumber !== null ? vnt(alert.orderNumber) : 'No identificado'}
                        </span>
                      )}
                      {alert.order ? (
                        <span className="block text-xs text-muted-foreground">{alert.order.email}</span>
                      ) : null}
                    </Td>
                    <Td>
                      {alert.amountCents !== null ? (
                        formatCOP(alert.amountCents)
                      ) : (
                        <span className="text-muted-foreground">Consúltalo en tu pasarela</span>
                      )}
                    </Td>
                    <Td>{providerLabel(alert.provider)}</Td>
                    <Td>
                      <span className="break-all font-mono text-xs">{alert.eventId}</span>
                    </Td>
                    <Td>{formatDateCO(alert.occurredAt)}</Td>
                    <Td>
                      {alert.order ? (
                        <Badge variant={STATUS_BADGE_VARIANT[alert.order.status]}>
                          {STATUS_LABEL[alert.order.status]}
                        </Badge>
                      ) : (
                        <span className="text-sm text-muted-foreground">
                          No pudimos identificar el pedido. Busca la referencia en tu pasarela.
                        </span>
                      )}
                    </Td>
                  </Tr>
                ))}
              </Tbody>
            </Table>

            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                Página {result.page} de {totalPages} · {alertsCountLabel(result.total)}
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
