import { describe, expect, it } from 'vitest';
import { navItems } from '../lib/nav';

describe('navItems', () => {
  it('gives owners all 14 items in order, with es-CO labels', () => {
    const items = navItems('owner');

    expect(items).toHaveLength(14);
    expect(items.map((item) => item.label)).toEqual([
      'Productos',
      'Categorías',
      // Next to Categorías because that is where a merchant looks for it, and
      // separate from it because a category is taxonomy and a collection is
      // curation — see the `Collection` model comment.
      'Colecciones',
      'Importar CSV',
      'Pedidos',
      'Clientes',
      'Pagos por revisar',
      'Conversaciones',
      'Reseñas',
      'Asistente',
      'Equipo',
      'Configuración',
      'Dominios',
      'Lanzamiento',
    ]);
  });

  it('gives staff only the 10 catalog items', () => {
    const items = navItems('staff');

    expect(items).toHaveLength(10);
    expect(items.map((item) => item.label)).toEqual([
      'Productos',
      'Categorías',
      'Colecciones',
      'Importar CSV',
      'Pedidos',
      'Clientes',
      'Pagos por revisar',
      'Conversaciones',
      // Both roles: hiding a bad review or answering it is customer work, not
      // account administration, and the moderation API has no @Roles() either.
      'Reseñas',
      // Both roles, mirroring /v1/admin/ai/command, which is not owner-only.
      'Asistente',
    ]);
  });

  it('gives both roles /conversaciones, mirroring the API\'s owner-or-staff guard', () => {
    // ConversationsController uses AdminSessionGuard with no @Roles(), for the
    // same reason as orders and payment alerts: answering a shopper the agent
    // handed over is fulfilment work, and staff are the people most likely to
    // be doing it.
    expect(navItems('owner').some((item) => item.href === '/conversaciones')).toBe(true);
    expect(navItems('staff').some((item) => item.href === '/conversaciones')).toBe(true);
  });

  it('gives both roles /pagos-por-revisar, mirroring the API\'s owner-or-staff guard', () => {
    // payment-alerts.controller.ts uses AdminSessionGuard with no @Roles(),
    // like the orders controller — hiding this from staff in the nav would
    // desync the two for no reason, and staff are the people most likely to
    // be handling the customer call this page exists for.
    expect(navItems('owner').some((item) => item.href === '/pagos-por-revisar')).toBe(true);
    expect(navItems('staff').some((item) => item.href === '/pagos-por-revisar')).toBe(true);
  });

  it('gives both owner and staff the /pedidos item (order fulfillment is shared, not owner-only)', () => {
    expect(navItems('owner').some((item) => item.href === '/pedidos')).toBe(true);
    expect(navItems('staff').some((item) => item.href === '/pedidos')).toBe(true);
  });

  it("gives both roles /clientes: the list mirrors the API's owner-or-staff guard", () => {
    // PrivacyController has no class-level @Roles(); only the irreversible
    // supresión handler is @Roles('owner'), and the page hides that button
    // from staff. Hiding the whole section from staff would take away the
    // customer lookup they need for fulfilment.
    expect(navItems('owner').some((item) => item.href === '/clientes')).toBe(true);
    expect(navItems('staff').some((item) => item.href === '/clientes')).toBe(true);
  });

  it('keeps /dominios out of the staff sidebar, mirroring the API\'s owner-only guard', () => {
    // CustomDomainsController is `@Roles('owner')` at the CLASS level — unlike
    // orders/customers/conversations, where only some handlers are restricted.
    // A staff session cannot even list domains (403 FORBIDDEN_ROLE from `GET
    // /v1/admin/domains`), so a link would only ever lead to an error page.
    expect(navItems('owner').some((item) => item.href === '/dominios')).toBe(true);
    expect(navItems('staff').some((item) => item.href === '/dominios')).toBe(false);
  });

  it('every item has a distinct href', () => {
    const hrefs = navItems('owner').map((item) => item.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });
});

describe('the merchant nav and the platform console', () => {
  /**
   * The operator console at `/plataforma` is deliberately absent from the
   * merchant sidebar, for both roles.
   *
   * `navItems` is keyed on `Role` — 'owner' | 'staff' — which is a
   * *membership* role. Platform authority in this codebase is emphatically
   * not a membership: `PlatformAdminGuard` reads an env allowlist plus
   * `User.isPlatformAdmin` plus a verified email, and explicitly refuses to
   * consult `Membership` so that no merchant-facing write path can ever widen
   * a session into an operator one. Gating a platform link on `role ===
   * 'owner'` would state the opposite relationship in the UI and would show
   * every store owner on the platform a link they cannot use.
   *
   * The alternative — probing `/v1/platform/tenants` from this layout to
   * decide whether to draw the link — would put one cross-tenant request on
   * every merchant page render, for every merchant, to benefit a handful of
   * operators who reach the console by bookmark. Operators get there by URL;
   * the console's own layout is what checks them, by asking the API.
   */
  it('never puts a /plataforma link in either role\'s sidebar', () => {
    for (const role of ['owner', 'staff'] as const) {
      expect(navItems(role).some((item) => item.href.startsWith('/plataforma'))).toBe(false);
    }
  });
});
