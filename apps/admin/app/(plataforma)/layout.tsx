import { redirect } from 'next/navigation';
import { getPlatformSession } from '../../lib/platform-session';
import { PLATFORM_PATH } from '../../lib/platform-api';

export const metadata = {
  // Distinct from the merchant admin's "Ventia Admin" on purpose: an operator
  // habitually has both open, and the browser tab is the one piece of chrome
  // they read before clicking into a window.
  title: 'Consola de plataforma · Ventia',
};

/**
 * Shell for Ventia's OWN back office (docs/SPEC.md §6 M9) — the operator's
 * view across every merchant.
 *
 * ## Route-group placement
 *
 * A SIBLING of `(app)`, never nested under it, for the same reason
 * `(setup)/onboarding` is: `(app)/layout.tsx` requires a merchant membership
 * and redirects a tenant-less session to `/onboarding`. A Ventia operator
 * frequently has no store of their own, so wrapping this in the merchant
 * shell would bounce exactly the people it is for — and would render an
 * operator console inside a merchant sidebar, which is the confusion this
 * whole surface is designed against.
 *
 * ## What is a control and what is chrome
 *
 * The gate below is NOT the access control. `PlatformAdminGuard` is: every
 * `/v1/platform/*` response is a 403 for a non-operator no matter what this
 * component renders, and this component's own verdict comes from asking that
 * guard (see `platform-session.ts`). Removing this file would leak nothing;
 * it would just mean a merchant who guessed the URL saw an empty console full
 * of error alerts instead of a straight answer.
 *
 * Everything below the gate — the black chrome, the hazard band, the warning
 * line — is chrome in the strict sense: it protects an OPERATOR from
 * themselves, not the platform from a merchant. It is worth building anyway,
 * because the realistic incident on this surface is not an intruder; it is a
 * legitimate operator suspending the wrong company's storefront because the
 * page looked like the one they had open a minute ago.
 */
export default async function PlatformLayout({ children }: { children: React.ReactNode }) {
  const session = await getPlatformSession();

  if (session.access === 'anonymous') redirect('/login');

  if (session.access !== 'operator') {
    // Deliberately rendered in the ORDINARY merchant styling, with none of
    // the console chrome: a merchant who typed this URL should see a plain
    // page, not a glimpse of an operator console.
    return (
      <main className="mx-auto flex min-h-screen max-w-lg flex-col items-start justify-center gap-4 p-6">
        <h1 className="text-xl font-semibold text-foreground">
          {session.access === 'denied' ? 'No tienes acceso a esta sección' : 'No pudimos verificar tu acceso'}
        </h1>
        <p className="text-sm text-muted-foreground">
          {session.access === 'denied'
            ? 'Esta es la consola interna de Ventia y tu cuenta no está autorizada para verla. Si administras una tienda, vuelve a tu panel.'
            : 'No pudimos comunicarnos con el servidor para confirmar tu acceso. Intenta de nuevo en un momento.'}
        </p>
        <a href="/" className="text-sm font-medium text-primary hover:underline">
          Ir a mi panel
        </a>
      </main>
    );
  }

  return (
    <div data-surface="plataforma" className="min-h-screen bg-background text-foreground">
      {/* Full-bleed hazard band. First thing on the page, above everything,
          on every route in this group — there is no scroll position and no
          sub-page from which this surface looks like the merchant admin. */}
      <div className="platform-hazard h-2 w-full" aria-hidden="true" />

      <header className="border-b border-border bg-background">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-2 px-6 py-4">
          <div className="flex flex-col">
            <span className="font-mono text-xs font-bold uppercase tracking-[0.2em] text-primary">
              Ventia · Consola de plataforma
            </span>
            <span className="text-xs text-muted-foreground">
              Estás viendo cuentas de otros comercios. Esta no es tu tienda.
            </span>
          </div>
          <nav className="flex gap-1">
            <a
              href={PLATFORM_PATH}
              className="rounded-md px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted"
            >
              Comercios
            </a>
          </nav>
          <div className="ml-auto flex items-center gap-4">
            {session.email ? (
              <span className="font-mono text-xs text-muted-foreground">Operador: {session.email}</span>
            ) : null}
            {/* The way out, always present: an operator who realises they are
                in the wrong place should not have to remember a URL. */}
            <a href="/" className="text-sm font-medium text-primary hover:underline">
              Salir de la consola
            </a>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl p-6">{children}</main>
    </div>
  );
}
