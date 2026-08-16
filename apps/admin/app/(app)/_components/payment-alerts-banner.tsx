'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { Alert } from '@ventia/ui';
import { ApiError } from '../../../lib/api';
import { ALERTS_PATH, listPaymentAlerts, alertsBannerSummary } from '../../../lib/payment-alerts-api';

/**
 * How many consecutive failures are tolerated in silence before this says so.
 *
 * Two, not one: a single failed poll is overwhelmingly a blip (a sleeping
 * laptop's first request, a redeploy, a flaky mobile connection), and a red
 * box on every page of the app for that is pure noise. Two in a row on
 * successive page loads is no longer a blip.
 */
const QUIET_FAILURE_ALLOWANCE = 2;

/** Survives remounts — this component unmounts and remounts on every
 * navigation, so a per-instance counter would reset to zero constantly and
 * never reach the threshold. Module scope is what makes "consecutive" mean
 * consecutive across a session rather than within one page view. */
let consecutiveFailures = 0;

/**
 * Treats a network-layer failure as transient and anything else as a bug.
 *
 * `apiFetch` throws `ApiError(0, 'NETWORK')` when fetch itself rejects —
 * offline, DNS, a dropped connection — which genuinely is the blip case. A
 * real HTTP status is different in kind: a 500 here means the endpoint is
 * broken (the reviewer produced exactly one by revoking the `SELECT` grant
 * that migration 20260815120000 adds, simulating an environment where it was
 * never applied or was reverted), and a 401/403 means the session is wrong.
 * None of those get better by waiting, so none of them are worth hiding.
 */
function isTransient(error: unknown): boolean {
  return !(error instanceof ApiError) || error.status === 0;
}

/**
 * The shell-wide alarm for payments that arrived on an order that could no
 * longer be settled — a shopper charged with no order to show for it.
 *
 * ## Why it lives in the (app) layout and not on one page
 *
 * The bar set for this feature is "a merchant who logs in will notice, without
 * knowing the feature exists". A dedicated page alone fails that: nobody
 * browses to a page they have never heard of. A banner on `/pedidos` alone
 * fails it too, because the merchant's session may never touch that route —
 * they log in to add a product, check the catalog, edit settings. Rendering
 * this in the `(app)` layout means the notice is present on EVERY authenticated
 * admin page, which is the only placement that actually guarantees the
 * encounter. The dedicated `/pagos-por-revisar` page then holds the detail and
 * the instructions; this banner's whole job is to get them there.
 *
 * ## Why it renders nothing when there is nothing wrong
 *
 * No count, no zero-state, no skeleton. A permanent element in the shell that
 * is usually empty trains merchants to skip that region, which is exactly the
 * habit that would make the real alert invisible on the day it matters. So
 * `total === 0` or still loading -> this component contributes nothing to the
 * layout at all.
 *
 * ## Failure is NOT the same as "nothing wrong"
 *
 * The original version also rendered nothing when the request failed, on the
 * sound reasoning that a red box on every page for a transient blip is noise.
 * The gap was that it treated a persistent failure identically to a healthy
 * system: with the endpoint 500ing, the banner silently vanished and the whole
 * shell looked fine — the one surface designed to be unmissable was absent
 * exactly when its dependency was broken.
 *
 * So the two cases are now separated. A first failure, or any network-layer
 * failure, still says nothing. A non-network status (a 500 is a bug, not a
 * blip) says so immediately, and repeated failures say so after
 * `QUIET_FAILURE_ALLOWANCE`. What it says is one quiet line — muted, not the
 * destructive red reserved for real alerts, and never a claim about how many
 * alerts exist, because that is precisely what could not be determined. The
 * API logs the same failure server-side with the tenant id
 * (payment-alerts.controller.ts), so this is the visible half of a failure
 * that is also greppable.
 *
 * ## Why it is client-side
 *
 * `apiFetch` posts the session cookie to the same-origin `/api` proxy — the
 * same data-fetching path every other interactive surface in this app uses
 * (`/pedidos`, `/productos`, `/configuracion`). The layout is a server
 * component, so this is a `'use client'` island inside it rather than a
 * server-side fetch, which keeps one fetching convention across the app
 * instead of introducing a second, server-only one for a single banner.
 */
export function PaymentAlertsBanner() {
  const [total, setTotal] = useState(0);
  const [degraded, setDegraded] = useState(false);
  // On /pagos-por-revisar the banner would sit directly above the page it
  // links to, telling the merchant to go where they already are. The page
  // states the same thing at more length, so the banner stands down there.
  const onAlertsPage = usePathname() === ALERTS_PATH;

  useEffect(() => {
    if (onAlertsPage) return;
    let cancelled = false;
    // pageSize 1: this only needs `total`. The rows themselves live on the
    // dedicated page. `status: 'pending'` is what makes a reviewed alert leave
    // the banner — it stays fully visible in the page's "Revisados" section,
    // it just stops raising the alarm.
    listPaymentAlerts({ page: 1, pageSize: 1, status: 'pending' })
      .then((res) => {
        consecutiveFailures = 0;
        if (!cancelled) {
          setTotal(res.total);
          setDegraded(false);
        }
      })
      .catch((error: unknown) => {
        consecutiveFailures += 1;
        // Always visible in the browser console, whatever we choose to render
        // — a silent catch is what made this invisible in the first place.
        console.error('[payment-alerts-banner] could not load payment alerts', error);
        const shouldSurface = !isTransient(error) || consecutiveFailures >= QUIET_FAILURE_ALLOWANCE;
        if (!cancelled && shouldSurface) setDegraded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [onAlertsPage]);

  if (onAlertsPage) return null;

  if (degraded) {
    return (
      <div className="mb-6 rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground">
        No pudimos verificar si tienes pagos por revisar.{' '}
        <a href={ALERTS_PATH} className="font-medium underline">
          Intenta abrir la página
        </a>
        .
      </div>
    );
  }

  if (total === 0) return null;

  return (
    <Alert variant="error" className="mb-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-semibold">Hay pagos que no se aplicaron a ningún pedido</p>
          <p className="mt-1">{alertsBannerSummary(total)}</p>
        </div>
        <a
          href={ALERTS_PATH}
          className="shrink-0 rounded-md border border-destructive/40 px-3 py-2 text-sm font-medium hover:bg-destructive/10"
        >
          Revisar ahora
        </a>
      </div>
    </Alert>
  );
}
