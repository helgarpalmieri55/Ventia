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
