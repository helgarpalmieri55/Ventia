import { CONVERSATIONS_PATH } from './conversations-api';
import { CUSTOMERS_PATH } from './customers-api';
import { DOMAINS_PATH } from './domains-api';
import { ASSISTANT_PATH } from './assistant-api';
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
  // Both roles, mirroring the API: PrivacyController sits behind
  // AdminSessionGuard with no class-level @Roles(), like the orders
  // controller — looking a shopper up by phone to answer "¿dónde está mi
  // pedido?" is fulfilment work. The IRREVERSIBLE action on this page (Ley
  // 1581 supresión) is owner-only, enforced server-side by @Roles('owner') on
  // that one handler and hidden from staff by the page itself.
  { href: CUSTOMERS_PATH, label: 'Clientes' },
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
  // Both roles, same reasoning as Pedidos and Pagos por revisar: answering a
  // shopper the AI handed over is fulfilment work, not account
  // administration, and the API mirrors that (no @Roles() on
  // ConversationsController).
  //
  // Permanent rather than conditional on there being an escalation. A store
  // whose plan excludes human handoff still has conversations worth reading —
  // seeing what the agent actually says to customers is the main reason a
  // merchant opens this — and its empty state is a real answer rather than
  // filler.
  { href: CONVERSATIONS_PATH, label: 'Conversaciones' },
  // Both roles, mirroring the API: `AgentCommandController` sits behind
  // AdminSessionGuard with no @Roles(), like the dashboard and orders. What it
  // answers is a summary of orders, products and conversations a staff session
  // can already page through one screen at a time, and it has no write tool at
  // all — so gating the summary would hide nothing a staff member cannot
  // already read.
  { href: ASSISTANT_PATH, label: 'Asistente' },
];

/** Owner-only items — the server mirrors this with @Roles('owner') on the
 * equipo/configuracion/lanzamiento controllers, so a staff session hitting
 * one of these routes directly still gets 403 FORBIDDEN_ROLE; hiding them
 * from the nav is a UX nicety, not the enforcement boundary. */
const OWNER_ONLY_ITEMS: NavItem[] = [
  { href: '/equipo', label: 'Equipo' },
  { href: '/configuracion', label: 'Configuración' },
  // Owner-only, mirroring `@Roles('owner')` on CustomDomainsController — the
  // whole resource is owner-only there, not just its writes, so a staff
  // session cannot even list domains.
  //
  // Its own item rather than a Configuración tab: a merchant who bought a
  // domain goes looking for the word "dominio", and the page is also where
  // they find the address their store ALREADY has, which is worth a permanent
  // route rather than being buried three clicks deep. Next to Configuración
  // because it is account administration, and before Lanzamiento, which stays
  // last.
  { href: DOMAINS_PATH, label: 'Dominios' },
  { href: '/lanzamiento', label: 'Lanzamiento' },
];

/** Pure helper: which sidebar links a given role sees in the admin shell. */
export function navItems(role: Role): NavItem[] {
  return role === 'owner' ? [...CATALOG_ITEMS, ...OWNER_ONLY_ITEMS] : CATALOG_ITEMS;
}
