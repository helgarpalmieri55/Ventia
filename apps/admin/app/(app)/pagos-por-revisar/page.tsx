'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Spinner,
  Table,
  Tbody,
  Td,
  Th,
  Thead,
  Tr,
} from '@ventia/ui';
import { ApiError } from '../../../lib/api';
import { errorMessage } from '../../../lib/errors';
import { formatCOP, formatDateCO } from '../../../lib/format';
import { STATUS_BADGE_VARIANT, STATUS_LABEL, vnt } from '../../../lib/orders-api';
import {
  alertGuidance,
  alertsCountLabel,
  listPaymentAlerts,
  providerLabel,
  reviewPaymentAlert,
  REVIEW_ACTION_LABEL,
  REVIEW_ACTION_OPTIONS,
  type AlertStatusFilter,
  type PaymentAlert,
  type PaymentAlertListResponse,
  type ReviewAction,
} from '../../../lib/payment-alerts-api';

const PAGE_SIZE = 20;

/**
 * "Pagos por revisar" — the detail surface for the payment outcome that needs
 * a human: a gateway confirmed a payment and it could not be applied to an
 * order.
 *
 * Structure follows `/pedidos`'s page — a `Card`, a client-side `apiFetch` in
 * a `useCallback` + `useEffect`, an `ApiError` -> `errorMessage` failure state
 * with a "Reintentar" button, a dashed empty state, a `Table`, and the same
 * pagination footer — so this reads as part of the same app rather than a
 * bolted-on admin tool.
 *
 * ## What this page must NOT do, learned the hard way
 *
 * The first version carried one blanket paragraph asserting, for every row,
 * that the order "ya estaba cancelado" and that the customer "no tiene un
 * pedido", plus a numbered step telling the merchant to "toma el pedido de
 * nuevo". Both were wrong in ways that cost money:
 *
 *  - `paid_order_not_settleable` is recorded whenever `markPaid` returns
 *    false, which happens for ANY order not in `PENDING` + (`PENDING` |
 *    `FAILED`) — including a second PAID event on an ALREADY-SETTLED order,
 *    i.e. a shopper who was genuinely charged twice. Those customers DO have
 *    their order. Under the old copy a row reading "Entregado / PAID"
 *    rendered directly beneath prose telling the merchant that customer had
 *    no order. The guidance is now per-row and derived from the resolved
 *    order's real state (see `alertGuidance`).
 *  - There is no way to create an order in the admin at all:
 *    `orders.controller.ts` exposes only `@Get`, `@Get(':id')` and five
 *    `@Patch` transitions, and there is no order-creation UI. "Toma el pedido
 *    de nuevo" therefore described an action the product cannot perform. The
 *    page now says so plainly: the merchant arranges it with the customer,
 *    and a customer who takes it again places a NEW order in the storefront.
 *
 * ## Reviewing, and why it is not a dismiss
 *
 * The original build shipped no acknowledgement at all, reasoning that these
 * events are rare and that a dismiss button lets someone silently erase a
 * financial discrepancy. The second half still holds; the first does not.
 * ePayco supports PSE, whose `Pendiente` -> `Aceptada` progression is
 * asynchronous by design, and the stock reservation TTL is 15 minutes — a
 * bank transfer outrunning a 15-minute hold is structurally expected. A
 * merchant with steady PSE volume would accumulate a permanently growing list
 * and a permanent banner, training exactly the skip-that-region habit that
 * defeats the alarm.
 *
 * So reviewing records WHO acted and WHAT they did, as an append-only row the
 * database will not let anyone edit or delete, and the alert moves to the
 * "Revisados" section below rather than disappearing. A review filed by
 * mistake is undone by appending a `reopened` row ("Reabrir"), which returns
 * the alert to the alarm and leaves both the mistake and the correction on
 * the record.
 */
export default function PagosPorRevisarPage() {
  const pending = useAlertList('pending');
  const reviewed = useAlertList('reviewed');

  /** Both lists reload after any review: a row always moves from one to the
   * other, and the counts in both footers change. */
  const reloadBoth = useCallback(() => {
    void pending.load();
    void reviewed.load();
  }, [pending.load, reviewed.load]);

  return (
    <div className="flex w-full flex-col gap-6">
      <Card className="w-full">
        <CardHeader>
          <CardTitle>Pagos por revisar</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          <div className="flex flex-col gap-2 text-sm text-muted-foreground">
            <p>
              Aquí aparecen los pagos que tu pasarela confirmó pero que no se pudieron aplicar a ningún pedido. Al
              cliente ya le cobraron, así que cada uno necesita que alguien lo revise.
            </p>
            {/* Deliberately NOT a blanket claim about what happened: the
                cause differs per row and so does the remedy. Each row says
                its own story in the "Qué pasó y qué hacer" column. */}
            <p>
              Lo que hay que hacer no es igual en todos los casos, así que revisa la columna{' '}
              <span className="font-medium text-foreground">«Qué pasó y qué hacer»</span> de cada fila antes de
              actuar.
            </p>
          </div>

          {pending.loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner /> Cargando pagos…
            </div>
          ) : pending.error ? (
            <div className="flex flex-col gap-3">
              <Alert variant="error">{pending.error}</Alert>
              <Button variant="secondary" size="sm" className="self-start" onClick={() => void pending.load()}>
                Reintentar
              </Button>
            </div>
          ) : !pending.hasItems ? (
            <div className="flex flex-col items-start gap-2 rounded-md border border-dashed border-border p-8">
              <p className="text-sm font-medium text-foreground">No tienes pagos por revisar.</p>
              <p className="text-sm text-muted-foreground">
                Si alguna vez una pasarela confirma un pago que no se pudo aplicar a ningún pedido, lo verás aquí y
                te avisaremos en todas las pantallas del panel.
              </p>
            </div>
          ) : (
            <>
              <Alert variant="error">
                <p className="font-semibold">Cómo resolver estos pagos</p>
                <ol className="mt-2 list-decimal space-y-1 pl-5">
                  <li>
                    Busca la referencia de la pasarela en el panel de tu pasarela y confirma que el pago se recibió
                    de verdad.
                  </li>
                  <li>
                    Lee la columna «Qué pasó y qué hacer» de esa fila: si el pedido ya estaba pagado, al cliente le
                    cobraron dos veces y solo hay que devolverle el cobro repetido; si el pedido se había cancelado,
                    el cliente pagó y se quedó sin pedido.
                  </li>
                  <li>
                    Cuando lo resuelvas, márcalo como revisado aquí mismo. Queda guardado quién lo revisó y qué
                    hizo, y el aviso deja de aparecer en el panel.
                  </li>
                </ol>
                <p className="mt-3">
                  Ten en cuenta que los pedidos no se crean ni se reviven desde el panel. Si acuerdas con el cliente
                  que lo tome de nuevo, tiene que hacer un pedido nuevo en tu tienda. Las devoluciones también se
                  hacen desde el panel de tu pasarela, no desde aquí.
                </p>
              </Alert>

              <AlertsTable list={pending} onReviewed={reloadBoth} mode="pending" />
            </>
          )}
        </CardContent>
      </Card>

      {/* The "Revisados" half. Rendered only once there is something in it, so
          a merchant who has never reviewed anything is not shown an empty
          second table. Reviewed alerts leave the alarm but never leave
          existence — this is where they go, with who reviewed them and when. */}
      {reviewed.hasItems ? (
        <Card className="w-full">
          <CardHeader>
            <CardTitle>Revisados</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-6">
            <p className="text-sm text-muted-foreground">
              Estos pagos ya los revisó alguien de tu equipo. Siguen aquí para que quede el registro: no se borran.
              Si marcaste uno por error, puedes reabrirlo y vuelve al aviso.
            </p>
            <AlertsTable list={reviewed} onReviewed={reloadBoth} mode="reviewed" />
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

/** The loading/paging/error state of one of the two lists. Both halves of the
 * page behave identically, so they share one hook rather than two copies of
 * the same `useCallback`/`useEffect` pair. */
interface AlertList {
  status: AlertStatusFilter;
  result: PaymentAlertListResponse | null;
  loading: boolean;
  error: string | null;
  hasItems: boolean;
  page: number;
  totalPages: number;
  setPage: (updater: (p: number) => number) => void;
  load: () => Promise<void>;
}

function useAlertList(status: AlertStatusFilter): AlertList {
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<PaymentAlertListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setResult(await listPaymentAlerts({ page, pageSize: PAGE_SIZE, status }));
    } catch (e) {
      setError(e instanceof ApiError ? errorMessage(e) : 'Ocurrió un error inesperado. Intenta de nuevo.');
    } finally {
      setLoading(false);
    }
  }, [page, status]);

  useEffect(() => {
    void load();
  }, [load]);

  return {
    status,
    result,
    loading,
    error,
    hasItems: result !== null && result.items.length > 0,
    page,
    totalPages: result ? Math.max(1, Math.ceil(result.total / result.pageSize)) : 1,
    setPage,
    load,
  };
}

function AlertsTable({
  list,
  onReviewed,
  mode,
}: {
  list: AlertList;
  onReviewed: () => void;
  mode: AlertStatusFilter;
}) {
  const { result } = list;
  if (!result) return null;

  return (
    <>
      <Table>
        <Thead>
          <Tr>
            <Th>Pedido</Th>
            <Th>Monto cobrado</Th>
            <Th>Pasarela</Th>
            <Th>Referencia de la pasarela</Th>
            <Th>Fecha del pago</Th>
            <Th>Estado del pedido</Th>
            <Th>Qué pasó y qué hacer</Th>
            <Th>{mode === 'pending' ? 'Revisar' : 'Revisión'}</Th>
          </Tr>
        </Thead>
        <Tbody>
          {result.items.map((alert) => (
            <AlertRow key={alert.id} alert={alert} mode={mode} onReviewed={onReviewed} />
          ))}
        </Tbody>
      </Table>

      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Página {result.page} de {list.totalPages} · {alertsCountLabel(result.total)}
        </p>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            size="sm"
            disabled={list.page <= 1}
            onClick={() => list.setPage((p) => Math.max(1, p - 1))}
          >
            Anterior
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={list.page >= list.totalPages}
            onClick={() => list.setPage((p) => Math.min(list.totalPages, p + 1))}
          >
            Siguiente
          </Button>
        </div>
      </div>
    </>
  );
}

function AlertRow({
  alert,
  mode,
  onReviewed,
}: {
  alert: PaymentAlert;
  mode: AlertStatusFilter;
  onReviewed: () => void;
}) {
  const guidance = alertGuidance(alert);

  return (
    <Tr>
      <Td>
        {alert.order ? (
          <>
            <a href={`/pedidos/${alert.order.id}`} className="font-medium text-foreground hover:underline">
              {vnt(alert.order.number)}
            </a>
            <span className="block text-xs text-muted-foreground">{alert.order.email}</span>
          </>
        ) : (
          <>
            <span className="text-muted-foreground">No identificado</span>
            {/* A previous version printed the payload's claimed order number
                here as if it were one of the merchant's orders, so a row
                could read "VNT-88888" and "no pudimos identificar el pedido"
                at the same time. The claim is still useful as a lead, so it
                stays — but labelled as what it is: something the gateway
                said, not an order in this store. */}
            {alert.referencedOrderNumber !== null ? (
              <span className="block text-xs text-muted-foreground">
                La pasarela mencionó el número {alert.referencedOrderNumber}, pero no coincide con ningún pedido
                tuyo.
              </span>
            ) : null}
          </>
        )}
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
          <>
            <Badge variant={STATUS_BADGE_VARIANT[alert.order.status]}>{STATUS_LABEL[alert.order.status]}</Badge>
            {alert.order.paymentStatus === 'PAID' ? (
              <span className="block text-xs text-muted-foreground">Ya estaba pagado</span>
            ) : null}
          </>
        ) : (
          <span className="text-sm text-muted-foreground">Sin pedido identificado</span>
        )}
      </Td>
      <Td>
        <div className="flex max-w-md flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{guidance.whatHappened}</span>
          <span className="font-medium text-foreground">{guidance.whatToDo}</span>
        </div>
      </Td>
      <Td>
        {mode === 'pending' ? (
          <ReviewForm alertId={alert.id} onReviewed={onReviewed} />
        ) : (
          <ReviewSummary alert={alert} onReviewed={onReviewed} />
        )}
      </Td>
    </Tr>
  );
}

/** The per-row "mark as reviewed" control. An explicit action + optional note,
 * never a bare "dismiss": the whole justification for letting an alert leave
 * the alarm is that the record says who did what. */
function ReviewForm({ alertId, onReviewed }: { alertId: string; onReviewed: () => void }) {
  const [action, setAction] = useState<ReviewAction>('refunded');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      await reviewPaymentAlert(alertId, { action, note: note.trim() || undefined });
      onReviewed();
    } catch (e) {
      setError(e instanceof ApiError ? errorMessage(e) : 'Ocurrió un error inesperado. Intenta de nuevo.');
      setSaving(false);
    }
  };

  return (
    <div className="flex min-w-56 flex-col gap-2">
      <label className="sr-only" htmlFor={`accion-${alertId}`}>
        Qué hiciste con este pago
      </label>
      <select
        id={`accion-${alertId}`}
        className="rounded-md border border-border bg-background px-2 py-1 text-sm"
        value={action}
        disabled={saving}
        onChange={(e) => setAction(e.target.value as ReviewAction)}
      >
        {REVIEW_ACTION_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <label className="sr-only" htmlFor={`nota-${alertId}`}>
        Nota (opcional)
      </label>
      <input
        id={`nota-${alertId}`}
        className="rounded-md border border-border bg-background px-2 py-1 text-sm"
        placeholder="Nota (opcional)"
        maxLength={500}
        value={note}
        disabled={saving}
        onChange={(e) => setNote(e.target.value)}
      />
      <Button size="sm" disabled={saving} onClick={() => void submit()}>
        {saving ? 'Guardando…' : 'Marcar como revisado'}
      </Button>
      {error ? <span className="text-xs text-destructive">{error}</span> : null}
    </div>
  );
}

/** What a reviewed row shows: who, what and when — plus the undo, which is
 * itself an append (`reopened`), never a delete. */
function ReviewSummary({ alert, onReviewed }: { alert: PaymentAlert; onReviewed: () => void }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const review = alert.review;
  if (!review) return null;

  const reopen = async () => {
    setSaving(true);
    setError(null);
    try {
      await reviewPaymentAlert(alert.id, { action: 'reopened' });
      onReviewed();
    } catch (e) {
      setError(e instanceof ApiError ? errorMessage(e) : 'Ocurrió un error inesperado. Intenta de nuevo.');
      setSaving(false);
    }
  };

  return (
    <div className="flex min-w-56 flex-col gap-1 text-sm">
      <span className="font-medium text-foreground">{REVIEW_ACTION_LABEL[review.action]}</span>
      <span className="text-xs text-muted-foreground">
        {review.reviewedByEmail} · {formatDateCO(review.reviewedAt)}
      </span>
      {review.note ? <span className="text-xs text-muted-foreground">“{review.note}”</span> : null}
      <Button variant="secondary" size="sm" className="mt-1 self-start" disabled={saving} onClick={() => void reopen()}>
        {saving ? 'Reabriendo…' : 'Reabrir'}
      </Button>
      {error ? <span className="text-xs text-destructive">{error}</span> : null}
    </div>
  );
}
