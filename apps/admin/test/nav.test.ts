import { describe, expect, it } from 'vitest';
import { navItems } from '../lib/nav';

describe('navItems', () => {
  it('gives owners all 6 items in order, with es-CO labels', () => {
    const items = navItems('owner');

    expect(items).toHaveLength(6);
    expect(items.map((item) => item.label)).toEqual([
      'Productos',
      'Categorías',
      'Importar CSV',
      'Equipo',
      'Configuración',
      'Lanzamiento',
    ]);
  });

  it('gives staff only the 3 catalog items', () => {
    const items = navItems('staff');

    expect(items).toHaveLength(3);
    expect(items.map((item) => item.label)).toEqual(['Productos', 'Categorías', 'Importar CSV']);
  });

  it('every item has a distinct href', () => {
    const hrefs = navItems('owner').map((item) => item.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });
});
