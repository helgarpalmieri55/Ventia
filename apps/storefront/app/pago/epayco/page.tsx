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
 * their order — not a backstop to a trusted primary mechanism.
 *
 * ## RESOLVED (P3c Task 3): the hooks do NOT fire in `standard` mode, and
 * ## `onResponse` carries no ePayco transaction reference on any path
 *
 * The note above said to "treat this as unresolved until confirmed against
 * a real ePayco sandbox." No sandbox account was available for P3c Task 3
 * either — but the question was resolved anyway, from a STRICTLY BETTER
 * source than the docs: **the actual shipped `checkout-v2.js` this page
 * loads** (downloaded from `https://checkout.epayco.co/checkout-v2.js`
 * during P3c Task 3; 421,029 bytes; minified but with all string literals
 * and control flow intact and readable). What that script actually does:
 *
 *  1. **`type: "standard"` is a FULL-PAGE REDIRECT, so no hook of this page
 *     can ever fire — CONFIRMED, HIGH CONFIDENCE.** The dispatch chain is,
 *     verbatim from the script: `handleRenderFlow(e,t){... case "standard":
 *     this.handleStandardFlow(t); ...}` →
 *     `handleStandardFlow(e){this.redirectToCheckout(e)}` →
 *     `redirectToCheckout(e){...;window.location.href=e}`. The target is
 *     built by `buildURL` as
 *     `https://new-checkout.epayco.co/checkout-standard/{sessionId}`. So
 *     `checkout.open()` below navigates the browser AWAY from this page
 *     entirely; this document is unloaded and every closure registered via
 *     `setHooks` dies with it. (`onpage`/`component` mode instead render an
 *     in-page React container/iframe, which is exactly why ePayco's docs
 *     scope the hooks to `onpage` — the docs' restriction is not arbitrary,
 *     it's structural.)
 *  2. **On the `sessionId` code path this page uses, `onResponse` is never
 *     invoked at all — CONFIRMED, HIGH CONFIDENCE.** `configure({sessionId,
 *     ...}).open()` routes to `renderWithSessionId(...)`, whose entire body
 *     was read: it validates/resolves the session id, calls
 *     `getTransaction`/`updateTransactionSettings`, calls `buildURL`, then
 *     `handleRenderFlow(...)` — and returns. It contains NO
 *     `this.onResponse(...)` call on any branch.
 *  3. **Where `onResponse` IS invoked, its payload is the transaction-CREATE
 *     response, not a payment result — CONFIRMED, HIGH CONFIDENCE.** The
 *     only non-`component` invocation in the whole script is in
 *     `handleTransactionSuccess`, reached only from `createTransaction`
 *     (the legacy `open({key, test, ...inline transaction fields})` flow
 *     this app does not use): `...,this.onCreated&&this.onCreated(t),...;
 *     this.handleRenderFlow(n,s); return this.onResponse&&this.onResponse(t),
 *     this.safePostMessage(t,"onResponse"),{sessionId:i,url:s}`. Note `t` is
 *     the SAME object already handed to `onCreated` — the JSON body of the
 *     `POST .../transactions/` create call — and it is fired IMMEDIATELY
 *     after the widget renders, i.e. BEFORE the shopper has paid anything.
 *     It therefore cannot contain a payment reference, whatever it is named.
 *     (This contradicts docs.epayco.com's own prose description of
 *     `onResponse` as firing "cuando el pago ha sido procesado"; the shipped
 *     code is the authority here, and it disagrees with the docs.)
 *  4. **The string `ref_payco` does not occur anywhere in the script —
 *     CONFIRMED, HIGH CONFIDENCE (mechanical).** 0 matches for `ref_payco`
 *     (and 0 for `x_ref_payco`) across all 421 KB. The only path that could
 *     surface an externally-shaped payload is `component` mode, which
 *     bridges an iframe `postMessage` straight through
 *     (`"onResponse"===e.data?.event&&(null==o||o(e.data.response))`) — that
 *     payload is authored inside `new-checkout.epayco.co`, is NOT described
 *     by this script, and is UNVERIFIED/UNKNOWN. It is also irrelevant here:
 *     this page uses `standard`, not `component`.
 *  5. **ePayco publishes no first-party sample of the hooks at all.** A code
 *     search across ePayco's own official sample repo `github.com/epayco/
 *     resources` for `setHooks`/`onResponse` returns ZERO hits, so there is
 *     no first-party payload example to check against either.
 *
 * **Consequence, unchanged and still true:** THIS page cannot capture
 * ePayco's `x_ref_payco`, because no hook of this page ever runs in
 * `standard` mode and `onResponse`'s payload carries no payment reference on
 * any code path anyway. So nothing was implemented here rather than
 * pattern-matching the Wompi return page against a payload that does not
 * exist.
 *
 * ## UPDATE: the shopper's return path is now a REAL, separate route
 *
 * The paragraph above used to end by noting that a shopper's return depended
 * on ePayco's own response-page redirect — the session-create `response`
 * field — "which `packages/payments/src/epayco.ts` deliberately does not
 * populate". **It populates it now.** The blocker was that no per-tenant
 * public URL reached the adapter; `OrderForPayment.storefrontBaseUrl` supplies
 * one, so `epayco.ts` sets `response` to that tenant's own
 * `/pago/epayco-retorno/{orderNumber}` route
 * (`app/pago/epayco-retorno/[orderNumber]/page.tsx`), which reads `ref_payco`
 * off its query string exactly as ePayco's own first-party samples do.
 *
 * Two things that does and does not change:
 *  - **Does:** a shopper who pays on epayco.co now comes back to their order
 *    automatically. The always-visible manual "Ya pagué, ver mi pedido" link
 *    below stays as a fallback (this page is still where a shopper sits if the
 *    widget never opens), but it is no longer the ONLY way back.
 *  - **Does NOT:** reconciliation coverage. A `ref_payco` captured on the
 *    response page is stored with `providerRefSource: 'hint'`, and
 *    `reconciliation.worker.ts`'s provenance gate refuses hint-sourced refs for
 *    ePayco (its status lookup is unauthenticated and merchant-agnostic). An
 *    ePayco order whose confirmation webhook never arrives still has no
 *    settle path and still falls through to the 15-minute stock-reservation
 *    expiry worker. `markPaid`/`markFailed` stamping a `'verified'` ref from a
 *    real signed webhook remains ePayco's only settle-capable ref source.
 *
 * The `setHooks` call below is KEPT (not deleted) purely as zero-cost
 * defensive wiring: it is known not to fire in `standard` mode, but it costs
 * nothing, and it would resume working if this page ever moves to
 * `onpage`/`component` mode or if ePayco changes `standard`'s behavior.
 * Nothing depends on it.
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
      // VERIFIED NOT TO FIRE in `type: 'standard'` (this page's mode) — see
      // the module doc comment's "RESOLVED (P3c Task 3)" section: `open()`
      // does `window.location.href = ...`, unloading this page before any
      // hook could run, and `renderWithSessionId` never calls `onResponse`
      // on any branch anyway. Kept as zero-cost defensive wiring only.
      // Deliberately does NOT send a provider-ref hint: `onResponse`'s
      // payload carries no ePayco transaction reference on ANY code path
      // (it's the transaction-CREATE response, fired pre-payment), so there
      // is nothing to send. Do not "restore" a hint call here by analogy
      // with the Wompi return page without re-reading that section first.
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
