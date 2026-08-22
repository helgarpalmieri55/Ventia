import { describe, expect, it } from 'vitest';
import {
  memberWarning,
  moveBy,
  orderChanged,
  storefrontStatus,
  type CollectionMember,
} from '../lib/collections-api';

function member(productId: string, overrides: Partial<CollectionMember> = {}): CollectionMember {
  return {
    productId,
    position: 0,
    name: productId,
    slug: productId,
    status: 'active',
    priceCents: 1000,
    thumbnailUrl: null,
    ...overrides,
  };
}

describe('moveBy', () => {
  it('swaps a product with its neighbour in either direction', () => {
    expect(moveBy(['a', 'b', 'c'], 1, -1)).toEqual(['b', 'a', 'c']);
    expect(moveBy(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'c', 'b']);
  });

  it('never wraps around at the ends — the first product must not become the last', () => {
    expect(moveBy(['a', 'b', 'c'], 0, -1)).toEqual(['a', 'b', 'c']);
    expect(moveBy(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'b', 'c']);
  });

  it('ignores an index that is not in the list (a double-click racing a re-render)', () => {
    expect(moveBy(['a', 'b'], 5, -1)).toEqual(['a', 'b']);
    expect(moveBy(['a', 'b'], -1, 1)).toEqual(['a', 'b']);
    expect(moveBy([], 0, 1)).toEqual([]);
  });

  it('returns a new array, so React sees the change', () => {
    const original = ['a', 'b'];
    const moved = moveBy(original, 0, 1);
    expect(moved).not.toBe(original);
    expect(original).toEqual(['a', 'b']);
  });
});

describe('orderChanged', () => {
  it('is false while nothing has moved', () => {
    const list = [member('a'), member('b')];
    expect(orderChanged(list, [...list])).toBe(false);
  });

  it('is true once two products swap places', () => {
    const list = [member('a'), member('b')];
    expect(orderChanged(list, moveBy(list, 0, 1))).toBe(true);
  });

  it('is true when a product was removed from the working list', () => {
    expect(orderChanged([member('a'), member('b')], [member('a')])).toBe(true);
  });

  it('compares ids, not the rest of the row — a renamed product has not moved', () => {
    expect(orderChanged([member('a', { name: 'Camisa' })], [member('a', { name: 'Camisa azul' })])).toBe(false);
  });
});

describe('storefrontStatus', () => {
  it('explains a collection the merchant hid, before anything about its products', () => {
    const status = storefrontStatus({ isActive: false, productCount: 8, activeProductCount: 0 });
    expect(status.visible).toBe(false);
    expect(status.label).toContain('Oculta');
  });

  it('says an empty collection does not appear at all, rather than as an empty strip', () => {
    const status = storefrontStatus({ isActive: true, productCount: 0, activeProductCount: 0 });
    expect(status.visible).toBe(false);
    expect(status.label).toContain('no aparece en la tienda');
  });

  it('names the case a merchant cannot otherwise diagnose: members exist, none is buyable', () => {
    const status = storefrontStatus({ isActive: true, productCount: 8, activeProductCount: 0 });
    expect(status.visible).toBe(false);
    expect(status.label).toContain('8 productos');
    expect(status.label).toContain('ninguno disponible');
  });

  it('counts what a shopper sees, and flags the rest as unpublished', () => {
    expect(storefrontStatus({ isActive: true, productCount: 3, activeProductCount: 3 })).toEqual({
      visible: true,
      label: 'Visible con 3 productos',
    });
    expect(storefrontStatus({ isActive: true, productCount: 3, activeProductCount: 1 })).toEqual({
      visible: true,
      label: 'Visible con 1 producto (2 sin publicar)',
    });
  });

  it('uses es-CO singulars', () => {
    expect(storefrontStatus({ isActive: true, productCount: 1, activeProductCount: 1 }).label).toBe(
      'Visible con 1 producto',
    );
    expect(storefrontStatus({ isActive: true, productCount: 1, activeProductCount: 0 }).label).toContain(
      '1 producto,',
    );
  });
});

describe('memberWarning', () => {
  it('tells archived and draft apart — the merchant fixes them in different places', () => {
    expect(memberWarning('archived')).toContain('Archivado');
    expect(memberWarning('draft')).toContain('Borrador');
    expect(memberWarning('active')).toBeNull();
  });
});
