'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { Alert } from '@ventia/ui';
import { ALERTS_PATH, listPaymentAlerts, alertsBannerSummary } from '../../../lib/payment-alerts-api';

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
 * No count, no zero-state, no skeleton, no error box. A permanent element in
 * the shell that is usually empty trains merchants to skip that region, which
 * is exactly the habit that would make the real alert invisible on the day it
 * matters. So: `total === 0`, still loading, or the request failed -> this
 * component contributes nothing to the layout at all. The failure case is
 * deliberate rather than sloppy — a red "no pudimos verificar tus pagos" box
 * on every page of the app whenever the API blips would be pure noise, and the
 * `/pagos-por-revisar` page (linked from the nav on every page) does surface
 * load errors properly, with a retry.
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
  // On /pagos-por-revisar the banner would sit directly above the page it
  // links to, telling the merchant to go where they already are. The page
  // states the same thing at more length, so the banner stands down there.
  const onAlertsPage = usePathname() === ALERTS_PATH;

  useEffect(() => {
    if (onAlertsPage) return;
    let cancelled = false;
    // pageSize 1: this only needs `total`. The rows themselves live on the
    // dedicated page.
    listPaymentAlerts({ page: 1, pageSize: 1 })
      .then((res) => {
        if (!cancelled) setTotal(res.total);
      })
      .catch(() => {
        // Silent by design — see the doc comment above.
      });
    return () => {
      cancelled = true;
    };
  }, [onAlertsPage]);

  if (onAlertsPage || total === 0) return null;

  return (
    <Alert variant="error" className="mb-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-semibold">Hay pagos que no se aplicaron a su pedido</p>
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
