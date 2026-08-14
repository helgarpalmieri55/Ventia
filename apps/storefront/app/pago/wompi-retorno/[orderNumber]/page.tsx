'use client';

import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Alert, Button, Card, CardContent, CardHeader, CardTitle, Spinner } from '@ventia/ui';
import { sendProviderRefHint } from '../../../../lib/checkout-api';
import { decideWompiRetorno } from '../../../../lib/wompi-retorno';

/** The Wompi return-capture page (P3c design decision 2, second bullet).
 *
 * `WompiProvider.createCheckoutSession` (packages/payments/src/wompi.ts) now
 * registers `redirect-url = {storefrontBase}/pago/wompi-retorno/{orderNumber}`,
 * so after the shopper finishes (or abandons) payment on Wompi's hosted Web
 * Checkout, their browser lands HERE with Wompi's own `?id={transactionId}`
 * appended.
 *
 * ## Why the order number is a PATH segment and `id` the only query param
 *
 * Wompi appends `?id=...` to whatever `redirect-url` it was handed, and its
 * docs only ever show that appended onto a URL with NO existing query
 * string — nothing documents what it does if one is already there. A
 * `redirect-url` of `.../wompi-retorno?orderNumber=123` could plausibly come
 * back as `.../wompi-retorno?orderNumber=123?id=abc`, which parses as ONE
 * param whose value is `"123?id=abc"` — silently breaking both values at
 * once. The path-segment shape removes the ambiguity entirely instead of
 * betting on undocumented behavior. `lib/wompi-retorno.ts`'s own test file
 * pins this with an executable regression test.
 *
 * ## What this page does, and what it deliberately does NOT do
 *
 * It sends the transaction id to the API as a best-effort HINT
 * (`PATCH /api/checkout/:orderNumber/provider-ref-hint`, which writes
 * `Order.providerRef` and nothing else) and navigates the shopper on to
 * `/checkout/confirmacion/:orderNumber` — exactly like the ePayco bridge
 * page's `goToConfirmation` does.
 *
 * It never treats the returned id as proof of anything. Wompi's own docs are
 * explicit: "Do not use the redirection as a validation method of your
 * transactions, only for informative purposes for your users."
 *
 * ## What the hint is actually worth FOR WOMPI today — read before relying on it
 *
 * For Wompi, **nothing settles off this hint at all.** P3 wave-2 added a
 * provenance gate: `Order.providerRefSource` records whether a ref came from a
 * signature-verified webhook (`'verified'`) or from this deliberately
 * unauthenticated endpoint (`'hint'`), and
 * `services/api/src/payments/reconciliation.worker.ts` refuses a by-id lookup
 * from a hint-sourced ref for any provider whose transaction lookup is not
 * merchant-account-scoped. Wompi is one of those providers (its lookup
 * authenticates with the browser-side PUBLIC key; see that file's
 * `ACCOUNT_SCOPED_LOOKUP_PROVIDERS` for the evidence). So a Wompi order's
 * payment status is settled ONLY by the signed webhook. This comment used to
 * say the hint fed "the reconciliation job re-looking-this-up through Wompi's
 * authenticated API" — true when it was written, false since that gate landed.
 *
 * The hint is still sent, and is still worth sending: it lands on the order
 * (with its `'hint'` provenance) as a support/audit breadcrumb tying a shopper's
 * order to a real Wompi transaction id, and it is the mechanism a future
 * merchant-identifier binding — or a Wompi lookup proven to be account-scoped —
 * would immediately make settle-capable, with no change to this page.
 *
 * **The hint PATCH is fired WITHOUT being awaited, and navigation happens
 * immediately.** Not `await`ed, and deliberately not chained off `.finally()`
 * either: a slow or hanging hint endpoint must never delay the shopper's
 * redirect. Losing a hint therefore costs no settlement at all for Wompi today
 * (only the breadcrumb above); stalling here costs every shopper their
 * post-payment experience.
 *
 * Mirrors `app/pago/epayco/page.tsx`'s shape (`'use client'` +
 * `useSearchParams()` + a `Suspense` boundary + graceful-degradation
 * branches); the branchy decision itself lives in `lib/wompi-retorno.ts` so
 * it can be unit-tested without React Testing Library, which this app
 * doesn't have.
 */

function WompiRetornoContent({ orderNumber }: { orderNumber: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const id = searchParams.get('id');

  const decision = React.useMemo(() => decideWompiRetorno(orderNumber, id), [orderNumber, id]);
  const handled = React.useRef(false);

  React.useEffect(() => {
    if (decision.kind === 'error') return;
    // Guard against React's development-mode double-invocation of effects
    // (and any re-render): the PATCH is idempotent server-side, but there's
    // no reason to send it twice or push the same route twice.
    if (handled.current) return;
    handled.current = true;

    if (decision.kind === 'navigate-with-hint') {
      // Fire-and-forget, with its own catch — a genuinely independent side
      // effect. NOT awaited and NOT sequenced before the navigation below.
      void sendProviderRefHint(decision.orderNumber, decision.providerRef).catch((e) => {
        console.error('[pago/wompi-retorno] provider-ref hint failed (non-blocking)', e);
      });
    }

    router.push(decision.confirmationPath);
  }, [decision, router]);

  // No usable order number: a malformed or hand-edited URL (never produced
  // by this app's own checkout flow). Same graceful-degradation posture as
  // the ePayco bridge page's own missing-param branch — a clear message and
  // a way back, not a crash and not a silent dead end.
  if (decision.kind === 'error') {
    return (
      <main className="mx-auto flex max-w-xl flex-col gap-4 px-4 py-16">
        <Alert variant="error">
          No pudimos identificar tu pedido al volver del pago con Wompi. Si ya pagaste, revisa tu correo de
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
          <CardTitle>Pago con Wompi</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col items-center gap-4 py-8">
          <Spinner className="h-8 w-8" />
          <p className="text-sm text-muted-foreground">Te estamos llevando a tu pedido…</p>
          {/* Manual fallback, same reasoning as the ePayco bridge page's
              always-visible link: if client-side navigation doesn't happen
              for any reason, the shopper still has a way to their order
              rather than being stranded on a spinner. */}
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
 * (nextjs.org/docs/messages/missing-suspense-with-csr-bailout) and is kept
 * for the same defensive reason `app/pago/epayco/page.tsx` keeps its own. */
export default function WompiRetornoPage({ params }: { params: Promise<{ orderNumber: string }> }) {
  const { orderNumber } = React.use(params);
  return (
    <React.Suspense
      fallback={
        <main className="mx-auto flex max-w-xl flex-col items-center gap-4 px-4 py-16">
          <Spinner className="h-8 w-8" />
        </main>
      }
    >
      <WompiRetornoContent orderNumber={orderNumber} />
    </React.Suspense>
  );
}
