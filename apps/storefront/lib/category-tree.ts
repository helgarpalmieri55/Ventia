/**
 * The header's category navigation, assembled from the flat list
 * `GET /v1/storefront/categories` returns.
 *
 * The API projects `parentId` and stops there, on purpose — its own comment
 * (services/api/src/storefront/categories.controller.ts) says the storefront
 * needs the same rows twice, once walked upward for a breadcrumb and once
 * grouped by parent for a menu, and that a tree built server-side only serves
 * the second. So the nesting is assembled here.
 *
 * Everything in this module is a pure function over those rows, and that is
 * the point: this app has no DOM test runner (vitest runs in `node` — see
 * vitest.config.ts), so a component that renders a menu cannot be tested at
 * all, while the part that can actually be *wrong* — which category ends up
 * under which, and which ones are worth showing — can be. See
 * test/category-tree.test.ts.
 *
 * ## Why this is defensive about shapes the database cannot rule out
 *
 * `services/api/src/catalog/category-tree.ts` rejects self-parents, cycles and
 * anything deeper than `MAX_CATEGORY_DEPTH` when a category is written, and it
 * is explicit that Postgres enforces none of that: the `parentId` foreign key
 * only guarantees the parent row exists. A store whose categories predate that
 * guard, or that was edited by direct SQL, can still serve rows with a cycle
 * in them.
 *
 * That matters more here than anywhere else in the storefront, because this
 * navigation renders inside the root layout: a walk that never terminates is
 * not a confusing menu, it is a hung request on *every page of the store*,
 * checkout included. Hence two rules, applied by `resolveParents` below:
 *
 * 1. every upward walk is bounded by a `seen` set, and
 * 2. nothing is ever dropped for being misparented — a category with a broken
 *    parent becomes a root. Showing it in the wrong place is a bad menu;
 *    dropping it makes a set of products unreachable from the whole shop.
 *
 * This module deliberately does NOT re-check `MAX_CATEGORY_DEPTH`. The menu
 * renders whatever depth it is handed, recursively, so raising that limit on
 * the API side needs no change on this side.
 */

/** A row of `GET /v1/storefront/categories`. The one shape in this app that is
 * shared across pages rather than re-declared per file (as the product DTOs
 * are): the flat rows and the tree built from them have to agree field for
 * field, and two copies of this drifting apart is exactly how a menu starts
 * rendering `undefined`. */
export interface StorefrontCategory {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
  /** Products sitting DIRECTLY in this category, not counting its children —
   * the API counts the join rows for this category alone. Use
   * {@link CategoryTreeNode.totalProductCount} for the number a shopper would
   * expect to see after clicking. */
  productCount: number;
}

export interface CategoryTreeNode extends StorefrontCategory {
  children: CategoryTreeNode[];
  /** `productCount` of this category plus every descendant's. This is what
   * decides whether a category is worth showing: a parent like "Mujer" that
   * holds no products of its own but has 40 across its children is a real
   * destination, and pruning on `productCount` alone would hide it. */
  totalProductCount: number;
}

/**
 * Each category's usable parent id, with every shape a recursive renderer
 * cannot survive already resolved away.
 *
 * Returns `null` for a category that should hang at the top level, which
 * covers three cases: it genuinely has no parent; it points at a row that is
 * not in this response (deleted, or filtered out between the write and this
 * fetch); or it sits on a cycle — including the one-category cycle of a
 * category that is its own parent.
 *
 * A cycle is broken at whichever of its members comes first in API order — that
 * member becomes a root and drags the rest of the loop underneath it. The
 * result is a strange-looking menu for a store whose data is already corrupt,
 * instead of a storefront that serves no pages at all.
 */
function resolveParents(rows: StorefrontCategory[]): Map<string, string | null> {
  const declared = new Map<string, string | null>();
  for (const row of rows) {
    // First row wins for a repeated id. Two nodes sharing an id would
    // otherwise appear twice in the menu AND split that category's children
    // between the copies, so neither copy shows the full subtree.
    if (!declared.has(row.id)) declared.set(row.id, row.parentId);
  }

  const parents = new Map<string, string | null>();
  for (const [id, parentId] of declared) {
    // The `!== null` half is only what TypeScript needs to narrow `parentId`
    // for `declared.has`; the check that carries behaviour is whether the
    // parent is in this response at all.
    const usable = parentId !== null && declared.has(parentId);
    parents.set(id, usable ? parentId : null);
  }

  for (const id of parents.keys()) {
    // Walk up from `id` until the chain ends or repeats. Arriving back at `id`
    // means `id` sits on a cycle, so cut its link. Arriving at some other
    // repeated node means the cycle is upstream and belongs to whichever of
    // its own members this loop reaches later — leaving it alone here keeps
    // the break point deterministic (always the first member in API order).
    //
    // A category that is its own parent needs no separate check: it is simply
    // the shortest cycle there is, and this loop cuts it on the first
    // comparison. An explicit `parentId !== id` above would be a branch no
    // test could ever distinguish from this one.
    const seen = new Set<string>([id]);
    let cursor = parents.get(id) ?? null;
    while (cursor !== null && !seen.has(cursor)) {
      seen.add(cursor);
      cursor = parents.get(cursor) ?? null;
    }
    if (cursor === id) parents.set(id, null);
  }

  return parents;
}

/** Sums `productCount` up the subtree, filling in `totalProductCount` as it
 * goes. Plain recursion with no cycle guard because `buildCategoryTree` only
 * ever calls it on a forest `resolveParents` has already made acyclic — that
 * guarantee is the whole reason `resolveParents` exists. */
function accumulateProductCounts(node: CategoryTreeNode): number {
  let total = node.productCount;
  for (const child of node.children) total += accumulateProductCounts(child);
  node.totalProductCount = total;
  return total;
}

/**
 * Nests the flat rows, preserving the API's ordering (`position`, then `name`)
 * among siblings — the merchant's chosen order is the menu's order.
 *
 * Every row comes back exactly once: a category whose parent could not be used
 * is returned as a root, with its `parentId` rewritten to `null` so a caller
 * reading that field can never disagree with where the node actually sits.
 */
export function buildCategoryTree(rows: StorefrontCategory[]): CategoryTreeNode[] {
  const parents = resolveParents(rows);

  const nodes = new Map<string, CategoryTreeNode>();
  for (const row of rows) {
    if (nodes.has(row.id)) continue; // same first-wins dedupe as resolveParents
    nodes.set(row.id, {
      ...row,
      parentId: parents.get(row.id) ?? null,
      children: [],
      totalProductCount: row.productCount,
    });
  }

  const roots: CategoryTreeNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.parentId === null ? undefined : nodes.get(node.parentId);
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  for (const root of roots) accumulateProductCounts(root);
  return roots;
}

/**
 * Drops every category whose subtree sells nothing.
 *
 * A category with no products anywhere under it is a link to an empty grid.
 * With eight products nobody would notice; the header exists for the store
 * with two hundred, where a menu padded with dead ends is worse than a short
 * one. Kept separate from `buildCategoryTree` so a breadcrumb can still name
 * an empty category the shopper is *currently standing in* — see
 * `app/categorias/[slug]/page.tsx`, which builds the unpruned tree for exactly
 * that reason.
 */
export function pruneEmptyCategories(nodes: CategoryTreeNode[]): CategoryTreeNode[] {
  return nodes
    .filter((node) => node.totalProductCount > 0)
    .map((node) => ({ ...node, children: pruneEmptyCategories(node.children) }));
}

/** What the header renders: the tree, minus the dead ends. */
export function buildCategoryNav(rows: StorefrontCategory[]): CategoryTreeNode[] {
  return pruneEmptyCategories(buildCategoryTree(rows));
}

/**
 * The trail from a top-level category down to `slug`, e.g. `Mujer › Ropa` —
 * root first, the category itself last. Empty when no category has that slug.
 *
 * Takes the built tree rather than the flat rows so it never walks a parent
 * chain of its own: the input is already a forest, so this recursion cannot
 * loop no matter what the store's data looks like.
 */
export function categoryPath(nodes: CategoryTreeNode[], slug: string): CategoryTreeNode[] {
  for (const node of nodes) {
    if (node.slug === slug) return [node];
    const deeper = categoryPath(node.children, slug);
    if (deeper.length > 0) return [node, ...deeper];
  }
  return [];
}
