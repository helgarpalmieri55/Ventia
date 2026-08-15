import { ALERTS_PATH } from './payment-alerts-api';

export type Role = 'owner' | 'staff';

export interface NavItem {
  href: string;
  label: string;
}

/** Catalog items every admin-portal role can reach (server also enforces
 * this: AdminSessionGuard has no @Roles() restriction on these routes). */
const CATALOG_ITEMS: NavItem[] = [
  { href: '/productos', label: 'Productos' },
  { href: '/categorias', label: 'Categorías' },
  { href: '/importar', label: 'Importar CSV' },
  { href: '/pedidos', label: 'Pedidos' },
  // Both roles, mirroring the API: payment-alerts.controller.ts sits behind
  // AdminSessionGuard with no @Roles(), exactly like the orders controller,
  // because chasing a shopper who was charged for a cancelled order is
  // fulfilment work rather than owner-only account administration.
  //
  // Permanent, not conditional on there being something to show. The shell
  // banner (app/(app)/_components/payment-alerts-banner.tsx) is what raises
  // the alarm; this link is what makes the page findable AFTERWARDS — a
  // merchant who saw the banner yesterday, or who wants to re-check a case
  // they already handled, needs a route back that doesn't depend on an alert
  // still being live. Its empty state is a genuinely useful answer ("no
  // tienes pagos por revisar"), not filler.
  { href: ALERTS_PATH, label: 'Pagos por revisar' },
];

/** Owner-only items — the server mirrors this with @Roles('owner') on the
 * equipo/configuracion/lanzamiento controllers, so a staff session hitting
 * one of these routes directly still gets 403 FORBIDDEN_ROLE; hiding them
 * from the nav is a UX nicety, not the enforcement boundary. */
const OWNER_ONLY_ITEMS: NavItem[] = [
  { href: '/equipo', label: 'Equipo' },
  { href: '/configuracion', label: 'Configuración' },
  { href: '/lanzamiento', label: 'Lanzamiento' },
];

/** Pure helper: which sidebar links a given role sees in the admin shell. */
export function navItems(role: Role): NavItem[] {
  return role === 'owner' ? [...CATALOG_ITEMS, ...OWNER_ONLY_ITEMS] : CATALOG_ITEMS;
}
