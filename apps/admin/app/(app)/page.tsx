'use client';

import { useCallback, useEffect, useState } from 'react';
import { Alert, Card, CardContent, CardHeader, CardTitle, Spinner } from '@ventia/ui';
import { ApiError } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
import { formatCOP } from '../../lib/format';
import {
  CHANNEL_LABEL,
  changeCaption,
  getDashboard,
  hasNoSales,
  methodLabel,
  type DashboardResponse,
} from '../../lib/dashboard-api';

/**
 * El tablero — the merchant's home screen (docs/design-gap.md §5).
 *
 * This renders exactly what `GET /v1/admin/dashboard` can derive today and
 * nothing more. The design also shows a live-activity feed and an "Insights de
 * tu IA" panel; neither is here, and neither is stubbed with placeholder
 * content, because a panel that looks real and is empty forever teaches a
 * merchant to distrust the screen.
 *
 * Every figure the API refuses to compute (`null`) is rendered as words rather
 * than as a zero. A brand-new store must read as new, not as failing.
 */
export default function TableroPage() {
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      // No range: the API's default window is the last 30 days ending today in
      // `America/Bogota`. Deliberately not computed here — the browser's clock
      // and zone are the visitor's, and a merchant travelling abroad must not
      // see a different "hoy" than their store does.
      setData(await getDashboard());
    } catch (e) {
      setLoadError(e instanceof ApiError ? errorMessage(e) : 'Ocurrió un error inesperado. Intenta de nuevo.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <Spinner />;
  if (loadError) return <Alert variant="error">{loadError}</Alert>;
  if (!data) return null;

  const { kpis } = data;
  const resolution = kpis.aiResolution;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">Tablero</h1>
        <p className="text-sm text-muted-foreground">
          Del {data.range.from} al {data.range.to} ({data.range.days} días, hora de Colombia). Se compara con el
          período anterior de igual duración: del {data.previousRange.from} al {data.previousRange.to}.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi title="Ventas" value={formatCOP(kpis.salesCents.value)} caption={changeCaption(kpis.salesCents).text} />
        <Kpi title="Pedidos" value={String(kpis.orders.value)} caption={changeCaption(kpis.orders).text} />
        <Kpi
          title="Conversaciones"
          value={String(kpis.conversations.value)}
          caption={changeCaption(kpis.conversations).text}
        />
        <Kpi
          title="Resolución de la IA"
          // Words, not "0%": a store nobody has written to has not failed to
          // resolve anything.
          value={resolution.ratePct === null ? 'Sin conversaciones' : `${resolution.ratePct}%`}
          caption={
            resolution.ratePct === null
              ? 'aún nadie ha escrito'
              : `${resolution.conversations - resolution.handedToHuman} de ${resolution.conversations} sin pasar a una persona`
          }
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Ventas por día</CardTitle>
        </CardHeader>
        <CardContent>
          <SalesChart series={data.series} />
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Más vendidos</CardTitle>
          </CardHeader>
          <CardContent>
            {data.topProducts.length === 0 ? (
              <Empty>Todavía no has vendido nada en este período.</Empty>
            ) : (
              <ul className="flex flex-col gap-2 text-sm">
                {data.topProducts.map((product) => (
                  <li key={product.productId ?? product.name} className="flex justify-between gap-4">
                    <span className="truncate">{product.name}</span>
                    <span className="shrink-0 text-muted-foreground">
                      {product.units} u · {formatCOP(product.salesCents)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Canales de venta</CardTitle>
          </CardHeader>
          <CardContent>
            {hasNoSales(data.salesByChannel) ? (
              <Empty>Aún no hay ventas que repartir.</Empty>
            ) : (
              <ul className="flex flex-col gap-2 text-sm">
                {data.salesByChannel.map((slice) => (
                  <li key={slice.channel} className="flex justify-between gap-4">
                    <span>{CHANNEL_LABEL[slice.channel]}</span>
                    <span className="shrink-0 text-muted-foreground">
                      {slice.sharePct}% · {formatCOP(slice.salesCents)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Medios de pago</CardTitle>
          </CardHeader>
          <CardContent>
            {data.paymentMethods.length === 0 ? (
              <Empty>Aún no hay pagos registrados.</Empty>
            ) : (
              <ul className="flex flex-col gap-2 text-sm">
                {data.paymentMethods.map((slice) => (
                  <li key={slice.method} className="flex justify-between gap-4">
                    <span>{methodLabel(slice.method)}</span>
                    <span className="shrink-0 text-muted-foreground">
                      {slice.sharePct}% · {formatCOP(slice.salesCents)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Kpi({ title, value, caption }: { title: string; value: string; caption: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-2xl font-semibold">{value}</p>
        <p className="mt-1 text-xs text-muted-foreground">{caption}</p>
      </CardContent>
    </Card>
  );
}

/**
 * Bars in plain CSS rather than a charting library: this app has no chart
 * dependency, and adding one to draw thirty rectangles is a decision that
 * should be made when the Analítica section of the design gets built, not
 * smuggled in here.
 *
 * The series always covers every day in the range, empty ones included (the
 * API zero-fills it), so a dead week reads as a dead week instead of being
 * skipped.
 */
function SalesChart({ series }: { series: DashboardResponse['series'] }) {
  const peak = Math.max(...series.map((point) => point.salesCents), 0);
  if (peak === 0) return <Empty>Sin ventas en este período.</Empty>;

  return (
    <div className="flex h-32 items-end gap-1">
      {series.map((point) => (
        <div
          key={point.date}
          className="flex-1 rounded-t bg-primary/70"
          // Scaled against the window's own peak, so the shape of a small
          // store's week is as readable as a large one's.
          style={{ height: `${Math.max(2, (point.salesCents / peak) * 100)}%` }}
          title={`${point.date}: ${formatCOP(point.salesCents)} · ${point.orders} pedido(s)`}
        />
      ))}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}
