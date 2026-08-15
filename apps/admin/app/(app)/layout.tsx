import { redirect } from 'next/navigation';
import { navItems } from '../../lib/nav';
import { getMe } from '../../lib/session';
import { LogoutButton } from './_components/logout-button';
import { PaymentAlertsBanner } from './_components/payment-alerts-banner';

/**
 * Route-group structure (documented per the task contract):
 *
 * - `(auth)`   — public pages: /login, /registro, /verificar. No session
 *                required; its own layout is just a centered-card shell.
 * - `(app)`    — THIS layout: the merchant shell (sidebar + logout) for a
 *                fully-onboarded session. Requires a session AND a tenant.
 * - `(setup)`  — /onboarding, with its own layout (app/(setup)/onboarding/
 *                layout.tsx) that requires only a session, tolerating
 *                "no tenant yet" — the exact state a fresh signup is in.
 *
 * Route groups don't affect the URL, so `(app)/page.tsx` still serves `/`,
 * `(setup)/onboarding/page.tsx` still serves `/onboarding`, etc. — no path
 * collisions. `(setup)/onboarding` is a SIBLING of `(app)`, not nested under
 * it, specifically so this layout's `no-tenant` redirect target
 * (`/onboarding`) is never re-wrapped by this same layout — a Next.js
 * layout has no reliable way to know its own route's pathname to special-
 * case it, so sibling route groups (rather than one shared (app) layout
 * trying to skip its own redirect for one child route) is what avoids the
 * redirect loop.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getMe();

  if (session.kind === 'anonymous') redirect('/login');
  if (session.kind === 'no-tenant') redirect('/onboarding');

  const { me } = session;
  const items = navItems(me.role);

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-60 shrink-0 flex-col gap-1 border-r border-border bg-background p-4">
        <p className="mb-4 truncate text-sm font-semibold text-foreground">{me.tenant?.name ?? 'Tu tienda'}</p>
        <nav className="flex flex-col gap-1">
          {items.map((item) => (
            <a
              key={item.href}
              href={item.href}
              className="rounded-md px-3 py-2 text-sm text-foreground hover:bg-muted"
            >
              {item.label}
            </a>
          ))}
        </nav>
        <div className="mt-auto flex flex-col gap-2 border-t border-border pt-4">
          <p className="truncate text-xs text-muted-foreground">{me.email}</p>
          <LogoutButton />
        </div>
      </aside>
      <main className="flex-1 p-6">
        {/* Above `children`, in the layout rather than on any single page:
            a payment that was taken but never became an order is the one
            thing in this admin app that must be seen from wherever the
            merchant happens to be. Renders nothing at all when there is
            nothing to report — see the component's doc comment. */}
        <PaymentAlertsBanner />
        {children}
      </main>
    </div>
  );
}
