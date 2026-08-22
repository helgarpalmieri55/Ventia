import { describe, expect, it } from 'vitest';
import {
  buildCategoryNav,
  buildCategoryTree,
  categoryPath,
  pruneEmptyCategories,
  type StorefrontCategory,
} from '../lib/category-tree';

/** A `GET /v1/storefront/categories` row with the boring fields filled in, so
 * each test only states the part it is about (who the parent is, how many
 * products). */
function row(id: string, parentId: string | null, productCount = 1): StorefrontCategory {
  return { id, name: id.toUpperCase(), slug: id, parentId, productCount };
}

/** The shape assertions below care about, without the counts noise. */
function shape(nodes: { slug: string; children: unknown[] }[]): unknown {
  return nodes.map((n) => ({
    slug: n.slug,
    children: shape(n.children as { slug: string; children: unknown[] }[]),
  }));
}

describe('buildCategoryTree', () => {
  it('nests children under their parent and keeps the API ordering among siblings', () => {
    // The API returns rows ordered by `position` then `name`
    // (services/api/src/storefront/categories.controller.ts) — that is the
    // merchant's chosen order and it has to survive into the menu, so the
    // rows here are deliberately NOT alphabetical.
    const tree = buildCategoryTree([
      row('mujer', null),
      row('ropa', 'mujer'),
      row('zapatos', 'mujer'),
      row('hombre', null),
      row('camisas', 'hombre'),
    ]);

    expect(shape(tree)).toEqual([
      {
        slug: 'mujer',
        children: [
          { slug: 'ropa', children: [] },
          { slug: 'zapatos', children: [] },
        ],
      },
      { slug: 'hombre', children: [{ slug: 'camisas', children: [] }] },
    ]);
  });

  it('nests three levels deep, the deepest tree the API allows', () => {
    // MAX_CATEGORY_DEPTH in services/api/src/catalog/category-tree.ts. Nothing
    // here enforces it — this pins that the renderer is handed the full depth
    // rather than a truncated tree, which is what lets that limit be raised
    // API-side without touching the storefront.
    const tree = buildCategoryTree([row('mujer', null), row('ropa', 'mujer'), row('vestidos', 'ropa')]);
    expect(shape(tree)).toEqual([
      { slug: 'mujer', children: [{ slug: 'ropa', children: [{ slug: 'vestidos', children: [] }] }] },
    ]);
  });

  it('returns a category whose parent is missing from the response as a root', () => {
    // The parent was deleted, or filtered out between the write and this
    // fetch. Hiding the child would make its products unreachable from the
    // entire shop; showing it at the top level is merely untidy.
    const tree = buildCategoryTree([row('ropa', 'fantasma')]);
    expect(shape(tree)).toEqual([{ slug: 'ropa', children: [] }]);
    expect(tree[0].parentId).toBeNull();
  });

  it('returns a category that is its own parent as a root', () => {
    // Rejected on write by `rejectCategoryParent` (CATEGORY_PARENT_SELF), and
    // not by Postgres — a row written before that guard shipped still arrives
    // here. Attaching it to itself would be an infinite render.
    const tree = buildCategoryTree([row('ropa', 'ropa')]);
    expect(shape(tree)).toEqual([{ slug: 'ropa', children: [] }]);
    expect(tree[0].parentId).toBeNull();
  });

  it('breaks a cycle at its first member in API order and keeps every category in the tree', () => {
    // CATEGORY_CYCLE is likewise a write-time rejection with no database
    // constraint behind it. If a cycle ever reaches this function, the whole
    // storefront hangs — the menu renders in the root layout, so every page
    // of the store, checkout included, would time out.
    const tree = buildCategoryTree([row('a', 'b'), row('b', 'a')]);
    expect(shape(tree)).toEqual([{ slug: 'a', children: [{ slug: 'b', children: [] }] }]);
  });

  it('breaks a three-category cycle without losing any of them', () => {
    const tree = buildCategoryTree([row('a', 'b'), row('b', 'c'), row('c', 'a')]);
    expect(shape(tree)).toEqual([
      { slug: 'a', children: [{ slug: 'c', children: [{ slug: 'b', children: [] }] }] },
    ]);
  });

  it('keeps a cycle hanging off a real root reachable', () => {
    // The cycle is upstream of `hijo`, not around it: `hijo` must still end up
    // somewhere in the tree rather than being stranded by the break.
    const tree = buildCategoryTree([row('a', 'b'), row('b', 'a'), row('hijo', 'b')]);
    expect(shape(tree)).toEqual([
      { slug: 'a', children: [{ slug: 'b', children: [{ slug: 'hijo', children: [] }] }] },
    ]);
  });

  it('keeps the first row of a repeated id and ignores the rest of it', () => {
    // Not something the API should ever send, but a duplicate id splits a
    // category in two: it renders twice and each copy shows only half its
    // children, which reads as products going missing from the menu. The
    // second row here contradicts the first on every field that matters —
    // parent, slug and count — so "first wins" is observable rather than a
    // claim the test cannot see.
    const tree = buildCategoryTree([
      { id: 'mujer', name: 'Mujer', slug: 'mujer', parentId: null, productCount: 2 },
      { id: 'ropa', name: 'Ropa', slug: 'ropa', parentId: 'mujer', productCount: 3 },
      { id: 'ropa', name: 'Ropa (repetida)', slug: 'ropa-repetida', parentId: null, productCount: 9 },
    ]);

    expect(shape(tree)).toEqual([{ slug: 'mujer', children: [{ slug: 'ropa', children: [] }] }]);
    expect(tree[0].totalProductCount).toBe(5);
  });

  it('returns an empty tree for an empty response', () => {
    expect(buildCategoryTree([])).toEqual([]);
  });

  it('sums productCount up the subtree into totalProductCount', () => {
    // A parent that holds no products of its own is the normal case in a
    // nested catalog: "Mujer" is a heading, "Mujer > Ropa" is where the
    // products live. `totalProductCount` is what makes that parent countable.
    const tree = buildCategoryTree([
      row('mujer', null, 0),
      row('ropa', 'mujer', 3),
      row('vestidos', 'ropa', 4),
      row('zapatos', 'mujer', 5),
    ]);

    const mujer = tree[0];
    expect(mujer.totalProductCount).toBe(12);
    expect(mujer.productCount).toBe(0);
    expect(mujer.children[0].totalProductCount).toBe(7);
    expect(mujer.children[1].totalProductCount).toBe(5);
  });
});

describe('pruneEmptyCategories', () => {
  it('drops a category with no products anywhere under it', () => {
    // A link to an empty grid. Harmless with eight products, which is exactly
    // why nobody noticed; with two hundred it is a menu full of dead ends.
    const tree = buildCategoryTree([row('mujer', null, 2), row('promos', null, 0)]);
    expect(shape(pruneEmptyCategories(tree))).toEqual([{ slug: 'mujer', children: [] }]);
  });

  it('keeps a parent that only has products through its children', () => {
    // The failure this guards: pruning on `productCount` instead of
    // `totalProductCount` deletes every heading category in a nested catalog,
    // taking its whole subtree with it.
    const tree = buildCategoryTree([row('mujer', null, 0), row('ropa', 'mujer', 3)]);
    expect(shape(pruneEmptyCategories(tree))).toEqual([
      { slug: 'mujer', children: [{ slug: 'ropa', children: [] }] },
    ]);
  });

  it('drops an empty child while keeping its non-empty siblings and parent', () => {
    const tree = buildCategoryTree([
      row('mujer', null, 0),
      row('ropa', 'mujer', 3),
      row('proximamente', 'mujer', 0),
    ]);
    expect(shape(pruneEmptyCategories(tree))).toEqual([
      { slug: 'mujer', children: [{ slug: 'ropa', children: [] }] },
    ]);
  });

  it('does not mutate the tree it was given, at any level', () => {
    // The category page builds the tree once and needs the unpruned copy for
    // its breadcrumb after the header has pruned its own — pruning in place
    // would erase the empty category the shopper is standing in, and the
    // child level is where that would happen first.
    const tree = buildCategoryTree([
      row('mujer', null, 0),
      row('ropa', 'mujer', 3),
      row('proximamente', 'mujer', 0),
      row('promos', null, 0),
    ]);

    pruneEmptyCategories(tree);

    expect(tree).toHaveLength(2);
    expect(tree[0].children).toHaveLength(2);
  });
});

describe('buildCategoryNav', () => {
  it('builds and prunes in one step', () => {
    const nav = buildCategoryNav([row('mujer', null, 0), row('ropa', 'mujer', 3), row('promos', null, 0)]);
    expect(shape(nav)).toEqual([{ slug: 'mujer', children: [{ slug: 'ropa', children: [] }] }]);
  });
});

describe('categoryPath', () => {
  const tree = buildCategoryTree([
    row('mujer', null),
    row('ropa', 'mujer'),
    row('vestidos', 'ropa'),
    row('hombre', null),
  ]);

  it('returns the trail from the top-level category down to the slug', () => {
    expect(categoryPath(tree, 'vestidos').map((n) => n.slug)).toEqual(['mujer', 'ropa', 'vestidos']);
  });

  it('returns just the category itself when it is top-level', () => {
    expect(categoryPath(tree, 'hombre').map((n) => n.slug)).toEqual(['hombre']);
  });

  it('returns an intermediate trail, not the deepest branch it walked into', () => {
    // Guards the off-by-one that shows `Inicio › Mujer › Ropa › Vestidos` on
    // the Ropa page: the search has to stop at the match, not at the leaf.
    expect(categoryPath(tree, 'ropa').map((n) => n.slug)).toEqual(['mujer', 'ropa']);
  });

  it('returns an empty trail for a slug that is not in the tree', () => {
    expect(categoryPath(tree, 'no-existe')).toEqual([]);
  });
});
