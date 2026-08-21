/**
 * The rules a category's parent has to satisfy, kept out of the controller and
 * pure so they can be exercised directly.
 *
 * Postgres enforces none of this. The `Category.parentId` foreign key added in
 * migration 20260821140000 stops a parent that does not exist, and nothing
 * else: a category can point at itself, two can point at each other, and a
 * chain can be nested a hundred deep. Each of those is a live outage rather
 * than a cosmetic problem — the storefront breadcrumb (`Inicio › Mujer ›
 * Ropa`) and the admin's category tree both walk this relation upward, so a
 * cycle is an infinite loop in a request handler, not a confusing menu.
 *
 * The whole tenant's `(id, parentId)` pairs are read in one query and walked
 * here in memory instead of asking Postgres for a recursive CTE. Two reasons:
 * a store's category list is tens of rows, not thousands, so the query is
 * cheaper than the round trips a walk would cost; and `tenantDb()` deliberately
 * blocks raw SQL (packages/db/src/tenant-client.ts), which is where a CTE
 * would have to live.
 */

/**
 * How many levels a tenant's category tree may have, counting the root as 1.
 *
 * Three is what the storefront navigation was designed to render — the deepest
 * breadcrumb in the design is `Inicio › Mujer › Ropa`, which is two categories
 * under a root — plus one level of headroom. It is a product limit, not a
 * technical one: raising it means checking that the header menu and the
 * breadcrumb still read sensibly, not that anything here stops working.
 */
export const MAX_CATEGORY_DEPTH = 3;

/** The only two columns any of this needs. */
export interface CategoryNode {
  id: string;
  parentId: string | null;
}

/** Why a proposed parent was refused. `null` means it is fine. */
export type CategoryParentRejection = 'CATEGORY_PARENT_SELF' | 'CATEGORY_CYCLE' | 'CATEGORY_TOO_DEEP';

function indexById(nodes: CategoryNode[]): Map<string, CategoryNode> {
  return new Map(nodes.map((node) => [node.id, node]));
}

function indexChildren(nodes: CategoryNode[]): Map<string, string[]> {
  const children = new Map<string, string[]>();
  for (const node of nodes) {
    if (!node.parentId) continue;
    const siblings = children.get(node.parentId);
    if (siblings) siblings.push(node.id);
    else children.set(node.parentId, [node.id]);
  }
  return children;
}

/**
 * Levels from `startId` up to its root, counting `startId` itself. A root is 1.
 *
 * The `seen` set is not defence against anything this module allows — it is
 * defence against a cycle that already exists in the table, put there before
 * this guard shipped or by a direct SQL write. Without it, one bad row turns
 * every subsequent category edit into a hung request.
 */
function depthOf(byId: Map<string, CategoryNode>, startId: string): number {
  const seen = new Set<string>();
  let cursor: string | null = startId;
  let depth = 0;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    depth += 1;
    cursor = byId.get(cursor)?.parentId ?? null;
  }
  return depth;
}

/** Levels from `rootId` down to its deepest descendant, counting `rootId`. A
 * childless category is 1. This is what makes moving a subtree checkable:
 * re-parenting a category drags everything under it down by the same amount. */
function subtreeHeight(nodes: CategoryNode[], rootId: string): number {
  const children = indexChildren(nodes);
  const seen = new Set<string>();
  let level = [rootId];
  let height = 0;
  while (level.length > 0) {
    height += 1;
    const next: string[] = [];
    for (const id of level) {
      if (seen.has(id)) continue;
      seen.add(id);
      next.push(...(children.get(id) ?? []));
    }
    level = next;
  }
  return height;
}

/**
 * Whether `category` may hang under `parentId`.
 *
 * @param nodes every category in the tenant, as it is stored right now.
 * @param categoryId the category being moved, or `null` when creating one —
 *   a category that does not exist yet has no descendants and cannot be its
 *   own ancestor, so only the depth rule applies to it.
 * @param parentId the proposed parent. Callers must have already confirmed it
 *   belongs to this tenant; a parent from another store is a 404, not a shape
 *   problem, and Postgres will not catch it (foreign keys are not subject to
 *   row-level security).
 */
export function rejectCategoryParent(
  nodes: CategoryNode[],
  categoryId: string | null,
  parentId: string,
): CategoryParentRejection | null {
  if (categoryId !== null && categoryId === parentId) return 'CATEGORY_PARENT_SELF';

  const byId = indexById(nodes);

  if (categoryId !== null) {
    // Walking up from the proposed parent must never arrive back at the
    // category being moved — that is exactly what would close a loop.
    const seen = new Set<string>();
    let cursor: string | null = parentId;
    while (cursor && !seen.has(cursor)) {
      if (cursor === categoryId) return 'CATEGORY_CYCLE';
      seen.add(cursor);
      cursor = byId.get(cursor)?.parentId ?? null;
    }
  }

  const height = categoryId === null ? 1 : subtreeHeight(nodes, categoryId);
  if (depthOf(byId, parentId) + height > MAX_CATEGORY_DEPTH) return 'CATEGORY_TOO_DEEP';

  return null;
}
