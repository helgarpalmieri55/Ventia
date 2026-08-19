'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@ventia/ui';
import { formatCOP, formatDateCO } from '../../../../../lib/format';
import { PLAN_LABELS, type PlatformSubscription } from '../../../../../lib/platform-api';

export interface SubscriptionPanelProps {
  subscription: PlatformSubscription | null;
}

/**
 * Suscripción — read-only for now.
 *
 * **This is the seam for subscription tracking.** `GET /v1/platform/tenants/:id`
 * already returns the newest `Subscription` row (`plan`, `priceCents`,
 * `paidUntil`, `notes`) or `null`, and this component renders exactly that
 * and nothing else. When the API grows write endpoints (record a payment,
 * move `paidUntil`, edit the note), the work lands here and in
 * `PlatformSubscription` in `lib/platform-api.ts` — the detail page below
 * only passes the field through, so no other file changes.
 *
 * Nothing is invented in the meantime: no "próximo cobro" derived from a
 * price, no status badge computed from `paidUntil`. A platform console that
 * guesses at billing state is worse than one that says it has none, because
 * an operator will act on the guess.
 */
export function SubscriptionPanel({ subscription }: SubscriptionPanelProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Suscripción</CardTitle>
      </CardHeader>
      <CardContent>
        {subscription ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted-foreground">Plan facturado</dt>
            <dd className="text-foreground">{PLAN_LABELS[subscription.plan]}</dd>
            <dt className="text-muted-foreground">Precio</dt>
            <dd className="text-foreground">{formatCOP(subscription.priceCents)}</dd>
            <dt className="text-muted-foreground">Pagado hasta</dt>
            <dd className="text-foreground">
              {subscription.paidUntil ? formatDateCO(subscription.paidUntil) : 'Sin fecha registrada'}
            </dd>
            <dt className="text-muted-foreground">Notas</dt>
            <dd className="text-foreground">{subscription.notes?.trim() || '—'}</dd>
          </dl>
        ) : (
          <p className="text-sm text-muted-foreground">
            Este comercio no tiene una suscripción registrada. El cobro de la v1 se lleva por fuera del producto.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
