'use client';

import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Alert, Button, Card, CardContent, CardHeader, CardTitle, Spinner } from '@ventia/ui';
import { sendProviderRefHint } from '../../../../lib/checkout-api';
import { decideEpaycoRetorno } from '../../../../lib/epayco-retorno';

/** The ePayco RESPONSE page — where ePayco sends the shopper's browser back
 * after they finish (or abandon) payment on epayco.co.
 *
 * `EpaycoProvider.createCheckoutSession` (packages/payments/src/epayco.ts) sets
 * the session-create `response` field to
 * `{storefrontBaseUrl}/pago/epayco-retorno/{orderNumber}`, per tenant. Mirrors
 * `app/pago/wompi-retorno/[orderNumber]/page.tsx` deliberately — same shape,
 * same fire-and-forget hint, same graceful-degradation branches.
 *
 * ## Why this route exists
 *
 * ePayco's `standard` mode (the mode this integration uses, because card data
 * must never touch this app) navigates the whole page away to epayco.co, so the
 * `/pago/epayco` bridge page is unloaded and its `setHooks` callbacks
 * structurally cannot fire — established by reading ePayco's actual shipped
 * `checkout-v2.js`. That left the bridge page's manual "Ya pagué, ver mi
 * pedido" link as the ONLY way back, on a page the shopper is no longer on. A
 * shopper who didn't click it first was stranded. This route is ePayco's own
 * documented answer to that, and it is now populated because
 * `OrderForPayment.storefrontBaseUrl` finally carries a real per-tenant public
 * URL.
 *
 * ## Order number in the PATH, `ref_payco` as the query param
 *
 * Same reasoning as the Wompi return page: the gateway appends its own query
 * param (`?ref_payco=...`) to whatever URL it was given, and no ePayco doc
 * promises correct behavior when a query string is already present. A path
 * segment removes the ambiguity instead of betting on it. The branchy decision
 * itself — including the `ref_payco` / `x_ref_payco` two-spelling rule taken
 * from ePayco's own sample repo — lives in `lib/epayco-retorno.ts` so it can be
 * unit-tested without React Testing Library, which this app doesn't have.
 *
 * ## What the captured ref is worth — do NOT overclaim this
 *
 * The ref is sent to the API as a best-effort HINT
 * (`PATCH /api/checkout/:orderNumber/provider-ref-hint`, which writes
 * `Order.providerRef`/`providerRefSource` and nothing else). ePayco's own docs
 * say this page is "NOT reliable to validate the final state of the
 * transaction" and that its "parameters can be manipulated by the user", so it
 * is never treated as proof of anything.
 *
 * **This does NOT restore ePayco reconciliation coverage.** A hint-sourced ref
 * is refused for ePayco by `reconciliation.worker.ts`'s provenance gate
 * (`ACCOUNT_SCOPED_LOOKUP_PROVIDERS`), because ePayco's status-lookup endpoint
 * is unauthenticated and merchant-agnostic. An ePayco order whose confirmation
 * webhook never arrives still cannot be settled, and still falls through to the
 * 15-minute stock-reservation expiry worker. What this page achieves is the UX
 * return path, plus a support/audit breadcrumb on the order. See
 * `lib/epayco-retorno.ts`'s module doc comment for the full statement.
 *
 * **The hint PATCH is fired WITHOUT being awaited, and navigation happens
 * immediately** — not chained off `.finally()` either. A slow or hanging hint
 * endpoint must never delay the shopper's redirect.
 */

function EpaycoRetornoContent({ orderNumber }: { orderNumber: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const refPayco = searchParams.get('ref_payco');
  const xRefPayco = searchParams.get('x_ref_payco');

  const decision = React.useMemo(
    () => decideEpaycoRetorno(orderNumber, refPayco, xRefPayco),
    [orderNumber, refPayco, xRefPayco],
  );
  const handled = React.useRef(false);

  React.useEffect(() => {
    if (decision.kind === 'error') return;
    // Guard against React's development-mode double-invocation of effects (and
    // any re-render): the PATCH is idempotent server-side, but there's no
    // reason to send it twice or push the same route twice.
    if (handled.current) return;
    handled.current = true;

    if (decision.kind === 'navigate-with-hint') {
      // Fire-and-forget, with its own catch — a genuinely independent side
      // effect. NOT awaited and NOT sequenced before the navigation below.
      void sendProviderRefHint(decision.orderNumber, decision.providerRef).catch((e) => {
        console.error('[pago/epayco-retorno] provider-ref hint failed (non-blocking)', e);
      });
    }

    router.push(decision.confirmationPath);
  }, [decision, router]);

  // No usable order number: a malformed or hand-edited URL (never produced by
  // this app's own checkout flow). Same graceful-degradation posture as the
  // Wompi return page and the ePayco bridge page — a clear message and a way
  // back, not a crash and not a silent dead end.
  if (decision.kind === 'error') {
    return (
      <main className="mx-auto flex max-w-xl flex-col gap-4 px-4 py-16">
        <Alert variant="error">
          No pudimos identificar tu pedido al volver del pago con ePayco. Si ya pagaste, revisa tu correo de
          confirmación o contáctanos; si no, vuelve a intentar tu pedido desde el carrito.
        </Alert>
        <Button href="/carrito" className="self-start">
          Volver al carrito
        </Button>
      </main>
    );
  }

  return (
    <main className="mx-auto flex max-w-xl flex-col items-center gap-6 px-4 py-16 text-center">
      <Card className="w-full">
        <CardHeader>
          <CardTitle>Pago con ePayco</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col items-center gap-4 py-8">
          <Spinner className="h-8 w-8" />
          <p className="text-sm text-muted-foreground">Te estamos llevando a tu pedido…</p>
          {/* Manual fallback, same reasoning as the Wompi return page's and the
              ePayco bridge page's always-visible link: if client-side
              navigation doesn't happen for any reason, the shopper still has a
              way to their order rather than being stranded on a spinner. */}
          <Button href={decision.confirmationPath} variant="secondary">
            Ver mi pedido
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}

/** `params` is a Promise in this Next.js version (same convention as
 * `app/productos/[slug]/page.tsx`'s server components) — unwrapped here with
 * `React.use()`, which is how a Client Component reads it. The `Suspense`
 * boundary below is required for `useSearchParams()` per Next's own rule
 * (nextjs.org/docs/messages/missing-suspense-with-csr-bailout) and is kept for
 * the same defensive reason the sibling payment pages keep theirs. */
export default function EpaycoRetornoPage({ params }: { params: Promise<{ orderNumber: string }> }) {
  const { orderNumber } = React.use(params);
  return (
    <React.Suspense
      fallback={
        <main className="mx-auto flex max-w-xl flex-col items-center gap-4 px-4 py-16">
          <Spinner className="h-8 w-8" />
        </main>
      }
    >
      <EpaycoRetornoContent orderNumber={orderNumber} />
    </React.Suspense>
  );
}
