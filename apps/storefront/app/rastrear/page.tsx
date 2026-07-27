'use client';

/** Public order-tracking page: a small form (order number + email-or-phone)
 * that calls `trackOrder` and renders the result. Fully client-driven, same
 * "genuinely needs browser interactivity" reasoning as `app/checkout/page.tsx`
 * (a form with client-side validation and fetch-on-submit) — there's no
 * server-renderable initial state here (unlike the confirmation page, which
 * already has the order number from its own route param).
 */

import * as React from 'react';
import Link from 'next/link';
import { Alert, Button, Card, CardContent, CardHeader, CardTitle, FormField, Input, Spinner } from '@ventia/ui';
import { formatCOP } from '../../lib/format';
import { trackOrder, type OrderStatus, type OrderTracking } from '../../lib/tracking-api';

/** es-CO label map for `OrderStatus`, exactly per the task brief — keyed
 * against `packages/db/prisma/schema.prisma`'s `OrderStatus` enum members. */
const STATUS_LABEL: Record<OrderStatus, string> = {
  PENDING: 'Pendiente',
  CONFIRMED: 'Confirmado',
  PREPARING: 'Preparando',
  SHIPPED: 'Enviado',
  DELIVERED: 'Entregado',
  CANCELLED: 'Cancelado',
};

/** es-CO labels for the event `type` strings this app's backend actually
 * writes. Checked directly against the two write sites rather than guessed:
 * `checkout.service.ts` writes `'created'` once, at order creation, and
 * EVERY status transition (confirm/preparing/shipped/delivered/cancel alike)
 * in `orders.service.ts`'s `transition()` writes the SAME `'status_changed'`
 * type — the specific from/to statuses live only in that event's `data`
 * field, which `OrderTrackingDto` deliberately does NOT expose (see
 * order-tracking.controller.ts's doc comment: `events` only surfaces
 * `type`/`createdAt`, not `data`/`actor`). So, unlike the brief's illustrative
 * `'created'/'confirmed'/'shipped'` list, there is no distinct per-status
 * event type to label — every transition after creation renders as the one
 * generic "Estado actualizado" entry. Any other/future `type` string falls
 * back to itself (raw), never invented. */
const EVENT_LABEL: Record<string, string> = {
  created: 'Pedido creado',
  status_changed: 'Estado actualizado',
};

// Deliberately the ONE error message for every non-2xx case (see the
// `catch` block below for why) — no separate generic-5xx message, since the
// brief calls for a single "no encontramos ese pedido" outcome regardless of
// cause.
const NOT_FOUND_MESSAGE = 'No encontramos ese pedido. Verifica el número de pedido y el correo o teléfono.';

/** Same `VNT-####` customer-facing prefix convention as the confirmation
 * page's own `vnt()` (`app/checkout/confirmacion/[orderNumber]/page.tsx`) and
 * `services/api/src/mailer/order-emails.ts`'s — kept as its own local copy
 * per this codebase's established no-shared-package-between-pages
 * convention, not shared from either of those. */
function vnt(orderNumber: number): string {
  return `VNT-${orderNumber}`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('es-CO', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

export default function TrackOrderPage() {
  const [orderNumber, setOrderNumber] = React.useState('');
  const [contact, setContact] = React.useState('');
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [submitting, setSubmitting] = React.useState(false);
  const [bannerError, setBannerError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<OrderTracking | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBannerError(null);

    const nextErrors: Record<string, string> = {};
    if (orderNumber.trim().length === 0) {
      nextErrors.orderNumber = 'Ingresa el número de pedido.';
    }
    if (contact.trim().length === 0) {
      nextErrors.contact = 'Ingresa tu correo o teléfono.';
    }
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      return;
    }
    setErrors({});

    setSubmitting(true);
    setResult(null);
    try {
      // `orderNumber` is submitted as typed (the API accepts the raw
      // `VNT-####` display convention's bare number as a query param, not the
      // `VNT-` prefix) — a leading/trailing space is trimmed defensively,
      // but no other reformatting: the API's own parseInt/ORDER_NOT_FOUND
      // handling is the single source of truth for what counts as valid.
      const tracking = await trackOrder(orderNumber.trim(), contact.trim());
      setResult(tracking);
    } catch {
      // Deliberately ONE message for every non-2xx response (400
      // VALIDATION_FAILED, 404 ORDER_NOT_FOUND for either a nonexistent
      // order OR a real order with the wrong contact, or a genuine 5xx) —
      // matching the backend's own anti-enumeration posture (see
      // order-tracking.controller.ts's doc comment). A distinct
      // "wrong contact" message here would defeat that even though the
      // backend itself is already safe.
      setBannerError(NOT_FOUND_MESSAGE);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="mx-auto max-w-2xl px-4 py-8">
      <h1 className="mb-6 text-2xl font-semibold">Rastrear mi pedido</h1>

      <Card className="mb-6">
        <CardContent className="flex flex-col gap-4 pt-6">
          <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-4">
            <FormField label="Número de pedido" htmlFor="orderNumber" error={errors.orderNumber}>
              <Input
                id="orderNumber"
                value={orderNumber}
                onChange={(e) => setOrderNumber(e.target.value)}
                placeholder="1042"
                disabled={submitting}
              />
            </FormField>
            <FormField label="Correo o teléfono" htmlFor="contact" error={errors.contact}>
              <Input
                id="contact"
                value={contact}
                onChange={(e) => setContact(e.target.value)}
                placeholder="correo@ejemplo.com"
                disabled={submitting}
              />
            </FormField>
            <Button type="submit" disabled={submitting} className="self-end">
              {submitting ? (
                <>
                  <Spinner /> Buscando…
                </>
              ) : (
                'Buscar pedido'
              )}
            </Button>
          </form>
        </CardContent>
      </Card>

      {bannerError ? (
        <Alert variant="error" className="mb-6">
          {bannerError}
        </Alert>
      ) : null}

      {result ? (
        <Card>
          <CardHeader>
            <CardTitle>Pedido #{vnt(result.orderNumber)}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <p className="text-sm">
              Estado: <span className="font-semibold">{STATUS_LABEL[result.status]}</span>
            </p>

            <ul className="flex flex-col gap-2 text-sm">
              {result.items.map((item, i) => (
                <li key={i} className="flex justify-between">
                  <span>
                    {item.nameSnapshot} × {item.qty}
                  </span>
                  <span>{formatCOP(item.priceCentsSnapshot * item.qty)}</span>
                </li>
              ))}
            </ul>
            <div className="flex justify-between border-t border-border pt-3 text-base font-semibold">
              <span>Total</span>
              <span>{formatCOP(result.totalCents)}</span>
            </div>

            {/* Only city + departamento, never a street address — same
                posture as the confirmation page's own restricted DTO. */}
            <p className="text-sm text-muted-foreground">
              Se envía a {result.shippingCiudad}, {result.shippingDepartamento}.
            </p>

            {result.shipment ? (
              <p className="text-sm">
                Transportadora: {result.shipment.carrier} — Guía: {result.shipment.trackingNumber}
              </p>
            ) : null}

            {result.events.length > 0 ? (
              <div className="border-t border-border pt-3">
                <h2 className="mb-2 text-sm font-semibold">Historial</h2>
                <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
                  {result.events.map((event, i) => (
                    <li key={i} className="flex justify-between">
                      <span>{EVENT_LABEL[event.type] ?? event.type}</span>
                      <span>{formatDate(event.createdAt)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <p className="mt-6 text-sm text-muted-foreground">
        <Link href="/" className="underline">
          Volver al inicio
        </Link>
      </p>
    </main>
  );
}
