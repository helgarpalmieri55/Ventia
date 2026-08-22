import type {
  DashboardChannelSlice,
  DashboardKpi,
  DashboardResponse,
  DashboardSalesChannel,
} from '@ventia/core';
import { apiFetch } from './api';

/**
 * Client for `GET /v1/admin/dashboard` — the tablero of
 * `docs/design-gap.md` §5.
 *
 * The response types are IMPORTED from `@ventia/core` rather than
 * hand-written, which is the opposite of what `payment-alerts-api.ts` and
 * `conversations-api.ts` do. The reason those hand-write theirs is that their
 * shapes live in `services/api/src`, which this app cannot reach; this one's
 * shape lives in `@ventia/core/dashboard-schemas`, a package the admin already
 * depends on, precisely so both ends of the wire are typed from one
 * declaration. Copying it here would reintroduce the drift that file avoids.
 */

export type { DashboardResponse } from '@ventia/core';

/** Both bounds are INCLUSIVE Colombian civil dates (`YYYY-MM-DD`). Omit both
 * for the API's default window — the last 30 days ending today in Bogota,
 * which is the server's clock and not the browser's. */
export interface DashboardRangeParams {
  from?: string;
  to?: string;
}

export async function getDashboard(params: DashboardRangeParams = {}): Promise<DashboardResponse> {
  const qs = new URLSearchParams();
  if (params.from) qs.set('from', params.from);
  if (params.to) qs.set('to', params.to);
  const query = qs.toString();
  return apiFetch<DashboardResponse>(`/v1/admin/dashboard${query ? `?${query}` : ''}`);
}

/** es-CO labels for the sales-channel ring. `other` is deliberately vague —
 * it is the bucket for anything that is not one of the three named entry
 * points, not a channel a merchant ever chose. */
export const CHANNEL_LABEL: Record<DashboardSalesChannel, string> = {
  web: 'Tienda online',
  whatsapp: 'WhatsApp',
  instagram: 'Instagram',
  other: 'Otros',
};

/** es-CO labels for the payment-method breakdown. Unknown keys fall through to
 * the raw value, because `Order.paymentProvider` is a free string column and a
 * value nobody expected is something the merchant should see rather than
 * something this map should swallow. */
const METHOD_LABEL: Record<string, string> = {
  cod: 'Contra entrega',
  wompi: 'Wompi',
  mercadopago: 'Mercado Pago',
  epayco: 'ePayco',
};

export function methodLabel(method: string): string {
  return METHOD_LABEL[method] ?? method;
}

/**
 * How a variation should read on a tile.
 *
 * `null` means the API had no honest comparison to make — a store with no
 * sales at all in the previous window. The caption says so instead of
 * rendering a `+100%` that would describe a base that does not exist, which is
 * the whole reason the API sends `null` rather than a number.
 */
export function changeCaption(kpi: DashboardKpi): { text: string; tone: 'up' | 'down' | 'flat' | 'unknown' } {
  if (kpi.changePct === null) return { text: 'sin período anterior', tone: 'unknown' };
  if (kpi.changePct === 0) return { text: 'igual que el período anterior', tone: 'flat' };
  const sign = kpi.changePct > 0 ? '+' : '';
  return {
    text: `${sign}${kpi.changePct}% vs. período anterior`,
    tone: kpi.changePct > 0 ? 'up' : 'down',
  };
}

/** True when the ring has nothing to draw. Every slice carries `sharePct:
 * null` in that case, so the page can render one empty state instead of four
 * slices each reporting a confident 0%. */
export function hasNoSales(slices: DashboardChannelSlice[]): boolean {
  return slices.every((slice) => slice.sharePct === null);
}
