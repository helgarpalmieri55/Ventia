'use client';

import { useEffect, useState } from 'react';
import { Button } from '@ventia/ui';
import { apiFetch } from '../../../lib/api';
import {
  impersonationExitPath,
  impersonationReturnPath,
  remainingLabel,
  remainingLevel,
  remainingMs,
  storeLabel,
  type ImpersonationContext,
} from '../../../lib/impersonation';

export interface ImpersonationBannerProps {
  /** Straight from `GET /v1/admin/me` via `getMe()` in the `(app)` layout.
   * The component takes it as a prop and never fetches it: the server is the
   * source of truth (spec §5), and a component that asked a second time could
   * disagree with the session the rest of the shell was rendered from. */
  context: ImpersonationContext;
}

/**
 * The impersonation banner (docs/superpowers/specs/
 * 2026-08-19-impersonation-design.md §5).
 *
 * ## What the spec pins, and how each part is honoured here
 *
 * - **Source of truth is the server.** The only input is `context`, which the
 *   `(app)` layout read off `GET /v1/admin/me`. There is no cookie read here,
 *   no route param, no `localStorage`, no client-side "am I impersonating?"
 *   flag. If the server stops reporting a context, the layout stops rendering
 *   this component — the banner cannot outlive the truth it reports.
 *
 * - **It cannot be dismissed.** There is no close control and no state that
 *   could hide it. "A closable banner is a banner that is closed."
 *
 * - **It displaces rather than overlays.** No `fixed`, no `absolute`, no
 *   `z-index`. It is a block at the top of the layout's column and the rest
 *   of the shell starts below it — so it can never sit on top of a control,
 *   and can never be scrolled past.
 *
 * - **It names the store, shows the time, and holds the way out.** All three
 *   in one bar, because the moment an operator notices the reminder is the
 *   moment they need the exit, and sending them hunting for it elsewhere is
 *   how "I'll leave in a minute" becomes an hour.
 *
 * - **The countdown is functional.** It ticks once a second off the grant's
 *   own hard expiry (§2 — thirty minutes, no sliding window), and turns red
 *   under five minutes, because the number's job is to stop someone starting
 *   a long task they cannot finish.
 *
 * ## Assumed field names
 *
 * `lib/impersonation.ts` holds the assumed `/v1/admin/me` shape and is the
 * one place to change when the endpoint lands. This component only knows the
 * `ImpersonationContext` interface, and renders sensibly when parts of it are
 * `null`: an unreadable payload degrades the copy, never the presence.
 */
export function ImpersonationBanner({ context }: ImpersonationBannerProps) {
  // Seeded synchronously so the first paint already shows a real number
  // rather than a placeholder that shifts the layout a tick later.
  const [left, setLeft] = useState<number | null>(() => remainingMs(context.expiresAt));
  const [exiting, setExiting] = useState(false);
  const [exitError, setExitError] = useState<string | null>(null);

  useEffect(() => {
    setLeft(remainingMs(context.expiresAt));
    if (context.expiresAt === null) return;
    const id = setInterval(() => setLeft(remainingMs(context.expiresAt)), 1000);
    return () => clearInterval(id);
  }, [context.expiresAt]);

  const level = remainingLevel(left);

  async function exit() {
    setExitError(null);
    setExiting(true);
    const path = impersonationExitPath(context);
    try {
      if (path) await apiFetch<unknown>(path, { method: 'DELETE' });
    } catch {
      // The grant expires on its own (§2), so a failed exit is not a trap —
      // but it is also not done, and saying "listo" here would be a lie about
      // whose face the next click is wearing.
      setExitError('No pudimos cerrar la sesión de impersonación. Intenta de nuevo.');
      setExiting(false);
      return;
    }
    // A full navigation, not a router push: the shell's session is read
    // server-side, so the cookie change has to be re-read by a fresh request.
    window.location.assign(impersonationReturnPath(context));
  }

  return (
    <div
      role="region"
      aria-label="Sesión de impersonación"
      data-surface="impersonacion"
      className="border-b-2 border-amber-500 bg-[#0b1120] text-white"
    >
      {/* Same hazard stripe as the operator console's own chrome: an operator
          moving between the two surfaces reads it as one visual language. */}
      <div className="platform-hazard h-1.5 w-full" aria-hidden="true" />
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-2 px-6 py-3">
        <div className="flex min-w-0 flex-col">
          <span className="font-mono text-xs font-bold uppercase tracking-[0.2em] text-amber-400">
            Estás dentro de una tienda ajena
          </span>
          <span className="truncate text-sm">
            Actuando como <span className="font-semibold">{storeLabel(context)}</span>
            {context.operatorEmail ? (
              <span className="text-white/70"> · operador {context.operatorEmail}</span>
            ) : null}
          </span>
          <span className="text-xs text-white/70">
            Todo lo que hagas queda registrado a tu nombre en la auditoría de plataforma.
          </span>
        </div>

        <div className="ml-auto flex items-center gap-4">
          <span
            // The ticker is intentionally not a live region: announcing a new
            // value every second would make the page unusable with a screen
            // reader, and the text that matters (why this bar exists, how to
            // leave) is static and read on entry.
            aria-live="off"
            suppressHydrationWarning
            className={`font-mono text-sm tabular-nums ${
              level === 'critical' || level === 'expired' ? 'text-red-400' : 'text-white'
            }`}
          >
            {remainingLabel(left)}
          </span>
          <Button variant="secondary" size="sm" onClick={() => void exit()} disabled={exiting}>
            {exiting ? 'Saliendo…' : 'Salir de la tienda'}
          </Button>
        </div>

        {exitError ? <p className="w-full text-xs text-red-300">{exitError}</p> : null}
        {level === 'expired' ? (
          <p className="w-full text-xs text-amber-300">
            La sesión de impersonación expiró: la API ya no acepta acciones dentro de esta tienda. Sal y vuelve a
            entrar desde la consola si necesitas seguir.
          </p>
        ) : null}
      </div>
    </div>
  );
}
