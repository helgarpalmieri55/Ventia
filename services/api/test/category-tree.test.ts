import { describe, expect, it } from 'vitest';
import { MAX_CATEGORY_DEPTH, rejectCategoryParent, type CategoryNode } from '../src/catalog/category-tree';

/**
 * The category tree's shape rules, driven directly.
 *
 * These run without a database on purpose. What is being tested is arithmetic
 * over a graph, and the cases that matter most — a cycle, a subtree dragged
 * past the depth limit — are ones a controller test can only reach by first
 * building the offending tree through the very endpoint that is supposed to
 * refuse it. The HTTP-level tests in categories.test.ts prove the guard is
 * wired in; these prove it is right.
 */

/** `Mujer › Ropa › Vestidos` — the deepest chain MAX_CATEGORY_DEPTH allows. */
const FULL_CHAIN: CategoryNode[] = [
  { id: 'mujer', parentId: null },
  { id: 'ropa', parentId: 'mujer' },
  { id: 'vestidos', parentId: 'ropa' },
];

describe('rejectCategoryParent — cycles', () => {
  it('refuses a category as its own parent', () => {
    expect(rejectCategoryParent(FULL_CHAIN, 'ropa', 'ropa')).toBe('CATEGORY_PARENT_SELF');
  });

  it('refuses moving a category under its own descendant', () => {
    // `mujer` under `vestidos` would close the loop mujer → vestidos → ropa →
    // mujer. Every breadcrumb render walks this relation upward, so the cost
    // of allowing it is a hung request, not a confusing menu.
    expect(rejectCategoryParent(FULL_CHAIN, 'mujer', 'vestidos')).toBe('CATEGORY_CYCLE');
    expect(rejectCategoryParent(FULL_CHAIN, 'mujer', 'ropa')).toBe('CATEGORY_CYCLE');
  });

  it('allows a move that only goes sideways', () => {
    const nodes: CategoryNode[] = [
      { id: 'mujer', parentId: null },
      { id: 'hombre', parentId: null },
      { id: 'ropa', parentId: 'mujer' },
    ];
    expect(rejectCategoryParent(nodes, 'ropa', 'hombre')).toBeNull();
  });

  it('terminates on a cycle that is already in the table', () => {
    // Nothing this module allows can produce this; a direct SQL write or a row
    // written before the guard shipped can. The walk must refuse rather than
    // spin, or one bad row makes every later category edit hang.
    const corrupt: CategoryNode[] = [
      { id: 'a', parentId: 'b' },
      { id: 'b', parentId: 'a' },
      { id: 'c', parentId: null },
    ];
    // The verdicts themselves are not the point — an already-broken tree has
    // no correct depth — but returning one at all is: both calls have to come
    // back, and the move that would close a second loop still has to be
    // refused.
    expect(['CATEGORY_TOO_DEEP', null]).toContain(rejectCategoryParent(corrupt, 'c', 'a'));
    expect(rejectCategoryParent(corrupt, 'a', 'b')).toBe('CATEGORY_CYCLE');
  });
});

describe('rejectCategoryParent — depth', () => {
  it('allows nesting up to the limit', () => {
    expect(rejectCategoryParent(FULL_CHAIN, null, 'mujer')).toBeNull();
    expect(rejectCategoryParent(FULL_CHAIN, null, 'ropa')).toBeNull();
  });

  it('refuses one level past the limit', () => {
    expect(rejectCategoryParent(FULL_CHAIN, null, 'vestidos')).toBe('CATEGORY_TOO_DEEP');
  });

  it('counts the descendants of the category being moved, not just the category', () => {
    // `ropa` is a root here with `vestidos` under it. Hanging it off `mujer`
    // is legal at MAX_CATEGORY_DEPTH 3; hanging it off `hombre-ropa` (already
    // at depth 2) would push `vestidos` to depth 4. Checking only the moved
    // category would wave the second one through and leave the tree deeper
    // than any code that renders it expects.
    const nodes: CategoryNode[] = [
      { id: 'mujer', parentId: null },
      { id: 'hombre', parentId: null },
      { id: 'hombre-ropa', parentId: 'hombre' },
      { id: 'ropa', parentId: null },
      { id: 'vestidos', parentId: 'ropa' },
    ];
    expect(rejectCategoryParent(nodes, 'ropa', 'mujer')).toBeNull();
    expect(rejectCategoryParent(nodes, 'ropa', 'hombre-ropa')).toBe('CATEGORY_TOO_DEEP');
  });

  it('treats a category being created as having no descendants', () => {
    // A `null` id means the row does not exist yet, so there is nothing under
    // it and the only question is how deep its parent already sits.
    const deep = Array.from({ length: MAX_CATEGORY_DEPTH }, (_, i) => ({
      id: `n${i}`,
      parentId: i === 0 ? null : `n${i - 1}`,
    }));
    expect(rejectCategoryParent(deep, null, `n${MAX_CATEGORY_DEPTH - 2}`)).toBeNull();
    expect(rejectCategoryParent(deep, null, `n${MAX_CATEGORY_DEPTH - 1}`)).toBe('CATEGORY_TOO_DEEP');
  });
});
