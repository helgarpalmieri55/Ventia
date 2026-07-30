'use client';

import * as React from 'react';
import Script from 'next/script';
import { useRouter, useSearchParams } from 'next/navigation';
import { Alert, Button, Card, CardContent, CardHeader, CardTitle, Spinner } from '@ventia/ui';

/** The ePayco bridge page (design doc decision 6 / plan Task 6).
 *
 * `EpaycoProvider.createCheckoutSession` (`packages/payments/src/epayco.ts`)
 * cannot hand the storefront a plain, provider-hosted redirect URL the way
 * Wompi's/Mercado Pago's adapters do — ePayco's real "Smart Checkout" v2
 * flow requires the BROWSER to load `checkout-v2.js` and call
 * `ePayco.checkout.configure({sessionId, type, test}).open()` client-side.
 * So instead, that adapter's `redirectUrl` points HERE — a normal,
 * same-origin storefront route — with the real ePayco `sessionId` and
 * `sandbox` flag (and, since this task, `orderNumber` — see below) riding
 * along as query params. This page's only job is to load that script and
 * drive the widget with them.
 *
 * ## The post-payment return-to-confirmation-page gap (read before touching
 * this file)
 *
 * `configure()` itself has NO redirect/return-URL parameter (re-confirmed
 * directly against docs.epayco.com/docs/checkout-implementacion during this
 * task — same finding `epayco.ts`'s Task 3 module comment already
 * documented). Fresh research done specifically for THIS task (not reused
 * from Task 3, which only looked at `configure()`'s own parameters) found
 * that the checkout object DOES expose a real, officially-documented
 * `setHooks()` method, with this EXACT verbatim code sample present on
 * docs.epayco.com/docs/checkout-implementacion:
 *
 * ```js
 * const checkout = ePayco.checkout.configure({ sessionId, type: "onpage", test: true });
 * checkout.setHooks({
 *   onCreated: (data) => { ... },
 *   onResponse: (response) => { ... },   // fires once the payment has been processed
 *   onErrors: (error) => { ... },
 *   onClosed: (errors) => { ... },        // fires when the shopper closes the widget
 * });
 * checkout.open();
 * ```
 *
 * This is wired below: both `onResponse` (payment processed) and `onClosed`
 * (widget dismissed, success or not) trigger the redirect to
 * `/checkout/confirmacion/{orderNumber}` — matching Wompi's/Mercado Pago's
 * own posture of redirecting back regardless of the in-browser outcome and
 * letting each provider's async webhook be the actual source of truth for
 * final payment status.
 *
 * Honesty note for the phase review, corrected after this task's own review:
 * the docs page this sample comes from ALSO states, verbatim (in Spanish),
 * that "estos hooks están disponibles para los tipos de implementación
 * onpage" — i.e. `setHooks` is explicitly documented as scoped to
 * `type: "onpage"`, NOT the `"standard"` mode this adapter actually uses
 * (design doc decision 6 requires `standard` — ePayco's own PCI-DSS-hosted
 * redirect experience, since card data must never touch this app). An
 * earlier version of this comment claimed the docs "don't state `setHooks`
 * is mode-specific" — that was wrong; they do, and against the mode this
 * page uses. So `setHooks` below is wired defensively (costs nothing if it
 * never fires), but the PERSISTENT, ALWAYS-VISIBLE manual "Ya pagué, ver mi
 * pedido" link is the only currently-VERIFIED way a shopper gets back to
 * their order — not a backstop to a trusted primary mechanism. Treat this
 * as unresolved until confirmed against a real ePayco sandbox in `standard`
 * mode specifically (no such account was available for this task).
 */

declare global {
  interface Window {
    ePayco?: {
      checkout: {
        configure: (config: { sessionId: string; type: 'standard' | 'onpage'; test: boolean }) => {
          setHooks: (hooks: {
            onCreated?: (data: unknown) => void;
            onResponse?: (response: unknown) => void;
            onErrors?: (error: unknown) => void;
            onClosed?: (errors: unknown) => void;
          }) => void;
          open: () => void;
        };
      };
    };
  }
}

// No Subresource Integrity hash: ePayco controls and can update this script
// at any time without notice, so a pinned SRI hash would break the widget on
// their next release rather than protect against tampering — a deliberate
// omission, not an oversight.
const EPAYCO_SCRIPT_SRC = 'https://checkout.epayco.co/checkout-v2.js';

type Stage = 'loading-script' | 'opening' | 'open' | 'script-error';

function ConfirmacionLink({ orderNumber, label }: { orderNumber: string | null; label: string }) {
  if (!orderNumber) return null;
  return (
    <Button href={`/checkout/confirmacion/${encodeURIComponent(orderNumber)}`} variant="secondary">
      {label}
    </Button>
  );
}

/** Wrapped in `Suspense` below. Next.js documents `useSearchParams()` in a
 * Client Component as requiring a `Suspense` boundary for static
 * prerendering (see https://nextjs.org/docs/messages/missing-suspense-with-csr-bailout)
 * — checked directly for this app: `app/layout.tsx` already forces every
 * route dynamic (it calls `headers()`/fetches the tenant on every request),
 * so removing this wrapper doesn't actually break this app's build today.
 * Kept anyway as cheap, correct-by-Next's-own-rule defensive practice that
 * would matter the moment the root layout's dynamic-forcing ever changes —
 * not a claim that today's build would fail without it. */
function EpaycoBridgeContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const session = searchParams.get('session');
  const sandbox = searchParams.get('sandbox');
  const orderNumber = searchParams.get('orderNumber');

  const [stage, setStage] = React.useState<Stage>('loading-script');
  const redirected = React.useRef(false);

  const goToConfirmation = React.useCallback(() => {
    if (redirected.current) return;
    redirected.current = true;
    if (orderNumber) {
      router.push(`/checkout/confirmacion/${encodeURIComponent(orderNumber)}`);
    }
    // No orderNumber at all (a malformed/direct visit — see module doc
    // comment): there's nothing to navigate to automatically. The visible
    // manual link (ConfirmacionLink) already degrades to rendering nothing
    // in that case too; the shopper falls back to navigating the site
    // themselves, same as any other broken/direct-hit URL.
  }, [orderNumber, router]);

  function handleScriptLoad() {
    if (!session) return; // guarded separately below; script wouldn't even be mounted without a session
    setStage('opening');
    const ePayco = window.ePayco;
    if (!ePayco) {
      setStage('script-error');
      return;
    }
    try {
      const checkout = ePayco.checkout.configure({
        sessionId: session,
        type: 'standard',
        test: sandbox === 'true',
      });
      checkout.setHooks({
        onResponse: () => goToConfirmation(),
        onClosed: () => goToConfirmation(),
        onErrors: () => {
          // Widget-reported error: still let the shopper get back to their
          // order (payment status is confirmed async by ePayco's webhook
          // regardless of what happened in-browser) rather than stranding
          // them here.
          goToConfirmation();
        },
      });
      checkout.open();
      setStage('open');
    } catch (e) {
      console.error('[pago/epayco] failed to configure/open ePayco checkout', e);
      setStage('script-error');
    }
  }

  function handleScriptError() {
    console.error('[pago/epayco] failed to load checkout-v2.js');
    setStage('script-error');
  }

  if (!session) {
    return (
      <main className="mx-auto flex max-w-xl flex-col gap-4 px-4 py-16">
        <Alert variant="error">
          No pudimos iniciar el pago con ePayco: falta la información de la sesión de pago. Vuelve a
          intentar tu pedido desde el carrito.
        </Alert>
        <Button href="/carrito" className="self-start">
          Volver al carrito
        </Button>
      </main>
    );
  }

  // `session` present but `orderNumber` missing/empty: a malformed or
  // truncated URL (never produced by this app's own real checkout flow,
  // which always includes it — see epayco.ts's redirectUrl construction —
  // but reachable via a hand-crafted/corrupted link). Without this explicit
  // branch, `ConfirmacionLink` silently renders nothing and the widget
  // proceeds with no way back at all — a silent dead end a live review pass
  // caught. Surface it instead of letting the shopper stall on a bare
  // loading card with no path forward.
  if (!orderNumber) {
    return (
      <main className="mx-auto flex max-w-xl flex-col gap-4 px-4 py-16">
        <Alert variant="error">
          No pudimos identificar tu pedido para este pago con ePayco. Si ya pagaste, revisa tu correo de
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
      <Script src={EPAYCO_SCRIPT_SRC} strategy="afterInteractive" onLoad={handleScriptLoad} onError={handleScriptError} />

      <Card className="w-full">
        <CardHeader>
          <CardTitle>Pago con ePayco</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col items-center gap-4 py-8">
          {stage === 'script-error' ? (
            <Alert variant="error" className="w-full">
              No pudimos cargar la pasarela de pago de ePayco. Verifica tu conexión e intenta de nuevo, o
              vuelve a tu pedido si ya alcanzaste a pagar.
            </Alert>
          ) : (
            <>
              <Spinner className="h-8 w-8" />
              <p className="text-sm text-muted-foreground">
                {stage === 'loading-script'
                  ? 'Cargando la pasarela de pago de ePayco…'
                  : stage === 'opening'
                    ? 'Abriendo el checkout de ePayco…'
                    : 'Completa tu pago en la ventana de ePayco. Cuando termines, usa el botón de abajo para volver a tu pedido.'}
              </p>
            </>
          )}

          {/* Manual fallback: rendered any time we have an orderNumber to
              point at, regardless of stage — see module doc comment's
              honesty note on why this stays visible even though a real
              onResponse/onClosed hook is wired above. */}
          <ConfirmacionLink orderNumber={orderNumber} label="Ya pagué, ver mi pedido" />
        </CardContent>
      </Card>
    </main>
  );
}

export default function EpaycoBridgePage() {
  return (
    <React.Suspense
      fallback={
        <main className="mx-auto flex max-w-xl flex-col items-center gap-4 px-4 py-16">
          <Spinner className="h-8 w-8" />
        </main>
      }
    >
      <EpaycoBridgeContent />
    </React.Suspense>
  );
}
