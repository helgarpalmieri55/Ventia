import { describe, expect, it } from 'vitest';
import { navItems } from '../lib/nav';

describe('navItems', () => {
  it('gives owners all 8 items in order, with es-CO labels', () => {
    const items = navItems('owner');

    expect(items).toHaveLength(8);
    expect(items.map((item) => item.label)).toEqual([
      'Productos',
      'Categorías',
      'Importar CSV',
      'Pedidos',
      'Pagos por revisar',
      'Equipo',
      'Configuración',
      'Lanzamiento',
    ]);
  });

  it('gives staff only the 5 catalog items', () => {
    const items = navItems('staff');

    expect(items).toHaveLength(5);
    expect(items.map((item) => item.label)).toEqual([
      'Productos',
      'Categorías',
      'Importar CSV',
      'Pedidos',
      'Pagos por revisar',
    ]);
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

  it('every item has a distinct href', () => {
    const hrefs = navItems('owner').map((item) => item.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });
});
