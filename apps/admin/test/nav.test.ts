import { describe, expect, it } from 'vitest';
import { navItems } from '../lib/nav';

describe('navItems', () => {
  it('gives owners all 7 items in order, with es-CO labels', () => {
    const items = navItems('owner');

    expect(items).toHaveLength(7);
    expect(items.map((item) => item.label)).toEqual([
      'Productos',
      'Categorías',
      'Importar CSV',
      'Pedidos',
      'Equipo',
      'Configuración',
      'Lanzamiento',
    ]);
  });

  it('gives staff only the 4 catalog items', () => {
    const items = navItems('staff');

    expect(items).toHaveLength(4);
    expect(items.map((item) => item.label)).toEqual(['Productos', 'Categorías', 'Importar CSV', 'Pedidos']);
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
