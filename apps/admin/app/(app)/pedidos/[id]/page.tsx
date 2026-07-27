'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { DEPARTAMENTOS } from '@ventia/core';
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, Spinner, Table, Tbody, Td, Th, Thead, Tr } from '@ventia/ui';
import { ApiError, apiFetch } from '../../../../lib/api';
import { errorMessage } from '../../../../lib/errors';
import { formatCOP, formatDateCO } from '../../../../lib/format';
import {
  ACTION_LABEL,
  ALLOWED_ACTIONS,
  STATUS_BADGE_VARIANT,
  STATUS_LABEL,
  confirmOrder,
  markDelivered,
  markPreparing,
  parseShippingAddress,
  vnt,
  type OrderAction,
  type OrderDetail,
} from '../../../../lib/orders-api';
import { CancelSection } from './_components/cancel-section';
import { ShippedForm } from './_components/shipped-form';

const EVENT_TYPE_LABEL: Record<string, string> = {
  created: 'Pedido creado',
  status_changed: 'Cambio de estado',
};

function eventLabel(type: string): string {
  return EVENT_TYPE_LABEL[type] ?? type;
}

/** `departamentoCode` is the DIVIPOLA code stored on `shippingAddress`
 * (e.g. "11"), not a display name — resolved through `@ventia/core`'s
 * `DEPARTAMENTOS` table, same convention as
 * `checkout.controller.ts`'s `confirmation()` DTO. Falls back to the raw
 * code (rather than hiding it) if it's ever not one of the known codes. */
function departamentoName(code: string): string {
  return DEPARTAMENTOS.find((d) => d.code === code)?.name ?? code;
}

/** `OrderEvent.data` is `Prisma.JsonValue | null` server-side — for
 * `status_changed` events it's written as `{ from, to, ...payload }` (see
 * `orders.service.ts`'s `transition()`), but nothing on this side guarantees
 * that shape, so this reads it defensively rather than assuming it. */
function eventFromTo(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null;
  const record = data as Record<string, unknown>;
  if (typeof record.from === 'string' && typeof record.to === 'string') {
    return `${STATUS_LABEL[record.from as keyof typeof STATUS_LABEL] ?? record.from} → ${
      STATUS_LABEL[record.to as keyof typeof STATUS_LABEL] ?? record.to
    }`;
  }
  return null;
}

/** The `shipped` transition's event carries `{from, to, carrier,
 * trackingNumber}` (see `orders.service.ts`'s `transition()`, which spreads
 * the shipped payload into the event's `data`) — this is currently the ONLY
 * place the carrier/tracking number is visible again after being entered
 * once in `ShippedForm`, since `OrderDetail` itself has no `shipment` field
 * (a Task 1 schema decision, not something this page can add). Read
 * defensively, same posture as `eventFromTo`. */
function eventShipment(data: unknown): { carrier: string; trackingNumber: string } | null {
  if (typeof data !== 'object' || data === null) return null;
  const record = data as Record<string, unknown>;
  if (typeof record.carrier === 'string' && typeof record.trackingNumber === 'string') {
    return { carrier: record.carrier, trackingNumber: record.trackingNumber };
  }
  return null;
}

/** Order detail page: loads `GET /v1/admin/orders/:id` once, then renders
 * customer contact, full shipping address, line items, the totals
 * breakdown, the full event timeline, and action buttons gated by the
 * client-side `ALLOWED_ACTIONS` mirror. Every action PATCH returns the full
 * updated `OrderDetail`, which is re-set directly into local state (same
 * "re-set from the mutation's own response" pattern as
 * `productos/[id]/page.tsx`'s section callbacks) rather than triggering a
 * separate re-fetch. */
export default function PedidoDetailPage() {
  const params = useParams<{ id: string }>();
  const id = typeof params.id === 'string' ? params.id : '';

  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [showShippedForm, setShowShippedForm] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSubmitting, setActionSubmitting] = useState<OrderAction | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const result = await apiFetch<OrderDetail>(`/v1/admin/orders/${id}`);
      setOrder(result);
    } catch (e) {
      setLoadError(e instanceof ApiError ? errorMessage(e) : 'Ocurrió un error inesperado. Intenta de nuevo.');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    if (id) void load();
  }, [id, load]);

  function handleUpdated(updated: OrderDetail) {
    setOrder(updated);
    setShowShippedForm(false);
    setActionError(null);
  }

  async function handleSimpleAction(action: 'confirm' | 'preparing' | 'delivered') {
    if (!order) return;
    setActionError(null);
    setActionSubmitting(action);
    try {
      const updated =
        action === 'confirm' ? await confirmOrder(order.id) : action === 'preparing' ? await markPreparing(order.id) : await markDelivered(order.id);
      handleUpdated(updated);
    } catch (e) {
      setActionError(e instanceof ApiError ? errorMessage(e) : 'Ocurrió un error inesperado. Intenta de nuevo.');
    } finally {
      setActionSubmitting(null);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner /> Cargando pedido…
      </div>
    );
  }

  if (loadError || !order) {
    return <Alert variant="error">{loadError ?? 'No encontramos este pedido.'}</Alert>;
  }

  const address = parseShippingAddress(order.shippingAddress);
  const allowedActions = ALLOWED_ACTIONS[order.status];

  return (
    <div className="flex w-full max-w-3xl flex-col gap-6">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-4">
          <CardTitle>{vnt(order.number)}</CardTitle>
          <Badge variant={STATUS_BADGE_VARIANT[order.status]}>{STATUS_LABEL[order.status]}</Badge>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm text-foreground">
          <p>Creado: {formatDateCO(order.createdAt)}</p>
          <p>Correo: {order.email}</p>
          <p>Teléfono: {order.phone}</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Dirección de envío</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-1 text-sm text-foreground">
          {address.nombreCompleto ? <p>{address.nombreCompleto}</p> : null}
          {address.telefono ? <p>Teléfono: {address.telefono}</p> : null}
          {address.direccion ? <p>{address.direccion}</p> : null}
          {address.complemento ? <p>{address.complemento}</p> : null}
          {address.barrio ? <p>Barrio: {address.barrio}</p> : null}
          {address.municipioName || address.departamentoCode ? (
            <p>
              {address.municipioName ?? ''}
              {address.municipioName && address.departamentoCode ? ', ' : ''}
              {address.departamentoCode ? departamentoName(address.departamentoCode) : ''}
            </p>
          ) : null}
          {address.notas ? <p>Notas: {address.notas}</p> : null}
          {order.shippingMethod ? (
            <p>
              Método de envío:{' '}
              {order.shippingMethodLabel ?? 'Método de envío eliminado'}
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Artículos</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Table>
            <Thead>
              <Tr>
                <Th>Producto</Th>
                <Th>Cantidad</Th>
                <Th>Precio unitario</Th>
                <Th>Subtotal</Th>
              </Tr>
            </Thead>
            <Tbody>
              {order.items.map((item) => (
                <Tr key={item.id}>
                  <Td>{item.nameSnapshot}</Td>
                  <Td>{item.qty}</Td>
                  <Td>{formatCOP(item.priceCentsSnapshot)}</Td>
                  <Td>{formatCOP(item.priceCentsSnapshot * item.qty)}</Td>
                </Tr>
              ))}
            </Tbody>
          </Table>

          <div className="flex flex-col gap-1 self-end text-sm text-foreground">
            <div className="flex justify-between gap-8">
              <span className="text-muted-foreground">Subtotal</span>
              <span>{formatCOP(order.subtotalCents)}</span>
            </div>
            <div className="flex justify-between gap-8">
              <span className="text-muted-foreground">IVA</span>
              <span>{formatCOP(order.taxCents)}</span>
            </div>
            <div className="flex justify-between gap-8">
              <span className="text-muted-foreground">Envío</span>
              <span>{formatCOP(order.shippingCents)}</span>
            </div>
            <div className="flex justify-between gap-8 font-semibold">
              <span>Total</span>
              <span>{formatCOP(order.totalCents)}</span>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Acciones</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {actionError ? <Alert variant="error">{actionError}</Alert> : null}

          {allowedActions.length === 0 ? (
            <p className="text-sm text-muted-foreground">Este pedido no tiene acciones disponibles.</p>
          ) : (
            <div className="flex flex-wrap items-start gap-3">
              {allowedActions.map((action) => {
                if (action === 'cancel') {
                  return <CancelSection key={action} orderId={order.id} onCancelled={handleUpdated} />;
                }
                if (action === 'shipped') {
                  return showShippedForm ? (
                    <div key={action} className="w-full">
                      <ShippedForm
                        orderId={order.id}
                        onShipped={handleUpdated}
                        onCancel={() => setShowShippedForm(false)}
                      />
                    </div>
                  ) : (
                    <Button key={action} onClick={() => setShowShippedForm(true)}>
                      {ACTION_LABEL[action]}
                    </Button>
                  );
                }
                return (
                  <Button
                    key={action}
                    disabled={actionSubmitting !== null}
                    onClick={() => void handleSimpleAction(action)}
                  >
                    {actionSubmitting === action ? 'Guardando…' : ACTION_LABEL[action]}
                  </Button>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Historial</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="flex flex-col gap-2 text-sm text-foreground">
            {order.events.map((event) => {
              const shipment = eventShipment(event.data);
              return (
                <li key={event.id} className="flex flex-col gap-0.5 border-b border-border pb-2 last:border-0">
                  <span className="font-medium">{eventLabel(event.type)}</span>
                  {eventFromTo(event.data) ? (
                    <span className="text-muted-foreground">{eventFromTo(event.data)}</span>
                  ) : null}
                  {shipment ? (
                    <span className="text-muted-foreground">
                      Transportadora: {shipment.carrier} · Guía: {shipment.trackingNumber}
                    </span>
                  ) : null}
                  <span className="text-xs text-muted-foreground">{formatDateCO(event.createdAt)}</span>
                </li>
              );
            })}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
