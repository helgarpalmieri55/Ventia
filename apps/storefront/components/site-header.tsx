import Link from 'next/link';
import { Input } from '@ventia/ui';
import type { CategoryTreeNode } from '../lib/category-tree';
import { AccountButton } from './account-button';
import { CartButton } from './cart-button';

/**
 * The storefront's global header: the store's name, a way to search, the cart,
 * and — the reason this component exists — a way into the catalog.
 *
 * Until now the storefront had no header at all. The only category navigation
 * anywhere was a grid of tiles on the home page, so a shopper who had followed
 * a link to a product had no way to reach any other category without going
 * back to `/`. With the eight products of a demo store that is invisible;
 * product.md §5 is blunt that with two hundred it makes the store unusable.
 *
 * ## Two renderings of the same tree, one per input device
 *
 * Mobile gets a horizontally scrollable row of top-level categories, sitting
 * in the open where they can be seen and tapped. Not a hamburger: the whole
 * point is discovery, and a menu behind a button is a menu nobody opens. The
 * subcategories are one level further in — `app/categorias/[slug]/page.tsx`
 * renders a category's children as chips and a breadcrumb, so nothing is
 * unreachable, it just takes the tap that a touch screen has no hover to save.
 *
 * Desktop gets the same top-level list as a bar with a drop-down per category
 * that has children. Opened on hover AND on `focus-within`, and revealed with
 * `opacity` rather than `hidden`/`invisible` — both of those remove the links
 * from the tab order, which is precisely how a keyboard user ends up unable to
 * open a menu that a mouse user opens by accident.
 *
 * Rendering the list twice duplicates a handful of anchors in the DOM. That is
 * the accepted cost of a CSS-only header: the alternative is a client
 * component with open/close state on every page of the store, including
 * checkout.
 *
 * ## Why the mobile rail is a sibling of the sticky bar, not inside it
 *
 * The bar sticks so the cart, search and the way home are always one tap
 * away. The category rail is deliberately left OUT of it and scrolls away with
 * the page: bar plus rail is around 110px, and permanently spending a third of
 * a small phone's viewport on chrome is a worse trade than a scroll to the top
 * — especially on the checkout, which this header also renders on. On md+
 * there is room for both, so there the whole thing sticks.
 *
 * ## Shape
 *
 * A Server Component that fetches nothing. `RootLayout` resolves the tenant
 * and the categories once per request and hands them down, so this cannot add
 * a round trip of its own, and a store with no categories yet renders the bar
 * and simply omits the nav.
 */
export interface SiteHeaderProps {
  storeName: string;
  /** The merchant's logo from their saved theme, when they have uploaded one
   * and it is actually a string — `Tenant.theme` is an unvalidated JSON blob
   * (see lib/theme.ts), so the caller is responsible for that check. */
  logoUrl?: string;
  /** Already pruned of empty branches by `buildCategoryNav`. */
  categories: CategoryTreeNode[];
}

export function SiteHeader({ storeName, logoUrl, categories }: SiteHeaderProps) {
  return (
    <>
      {/* z-30: under the chat widget's z-40, over ordinary page content. */}
      <header className="sticky top-0 z-30 border-b border-border bg-background">
        <div className="mx-auto flex max-w-6xl items-center gap-2 px-4 py-3">
          <Link href="/" className="mr-auto flex min-w-0 items-center gap-2">
            {logoUrl ? (
              // Plain <img> for the same reason as product photos (no
              // remote-image config); height-constrained so a merchant who
              // uploads a 2000px logo does not get a header taller than the
              // content under it.
              <img src={logoUrl} alt={storeName} className="h-8 w-auto max-w-[10rem] object-contain" />
            ) : (
              <span className="truncate text-lg font-semibold">{storeName}</span>
            )}
          </Link>

          {/* Plain GET form, same as /buscar's own — it navigates, so it needs
              no JavaScript. Hidden on phones, where it would eat the whole
              bar; there the magnifier opens the search page instead. */}
          <form action="/buscar" method="get" role="search" className="hidden w-56 md:block">
            <Input type="search" name="q" placeholder="Buscar" aria-label="Buscar productos" className="h-9" />
          </form>
          <Link
            href="/buscar"
            aria-label="Buscar productos"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-border transition-colors hover:bg-muted md:hidden"
          >
            <SearchIcon />
          </Link>

          {/* Before the cart, not after: the cart is the action a shopper
              reaches for mid-purchase and stays in the corner it has always
              been in. An account is an offer beside it — never a step in
              front of it, since guest checkout is the default path. */}
          <AccountButton />
          <CartButton />
        </div>

        {/* Desktop: the category bar rides along inside the sticky header. */}
        {categories.length > 0 ? (
          <nav aria-label="Categorías" className="hidden md:block">
            <ul className="mx-auto flex max-w-6xl flex-wrap items-center gap-1 px-4 pb-2">
              {categories.map((category) => (
                <li key={category.id} className="group relative">
                  <Link
                    href={`/categorias/${category.slug}`}
                    className="inline-flex items-center gap-1 rounded-md px-3 py-2 text-sm transition-colors hover:bg-muted"
                  >
                    {category.name}
                    {category.children.length > 0 ? <ChevronDownIcon /> : null}
                  </Link>
                  {category.children.length > 0 ? (
                    <div className="pointer-events-none absolute left-0 top-full z-10 w-max min-w-52 max-w-[min(20rem,80vw)] rounded-md border border-border bg-background p-2 opacity-0 shadow-lg transition-opacity group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100">
                      <CategorySubList nodes={category.children} />
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          </nav>
        ) : null}
      </header>

      {/* Phones: one scrollable rail, outside the sticky bar (see above).
          `snap-start` so a flick lands on a chip boundary rather than
          mid-word, and the scrollbar is hidden because on a touch screen it is
          only ever a grey smear across the chips. */}
      {categories.length > 0 ? (
        <nav aria-label="Categorías" className="border-b border-border md:hidden">
          <ul className="flex snap-x gap-2 overflow-x-auto px-4 py-2 [scrollbar-width:none]">
            {categories.map((category) => (
              <li key={category.id} className="shrink-0 snap-start">
                <Link
                  href={`/categorias/${category.slug}`}
                  className="block rounded-full border border-border px-3 py-1.5 text-sm transition-colors hover:bg-muted"
                >
                  {category.name}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}
    </>
  );
}

/** The inside of a drop-down, recursive so it renders whatever depth the tree
 * has rather than assuming `MAX_CATEGORY_DEPTH` is 3 — the API is free to
 * raise that limit without this file knowing (see lib/category-tree.ts). A
 * third level is indented against a rule instead of opening a second flyout:
 * flyouts that chase the cursor sideways are the classic way to lose a menu. */
function CategorySubList({ nodes }: { nodes: CategoryTreeNode[] }) {
  return (
    <ul className="flex flex-col gap-0.5">
      {nodes.map((node) => (
        <li key={node.id}>
          <Link
            href={`/categorias/${node.slug}`}
            className="block rounded-md px-3 py-1.5 text-sm transition-colors hover:bg-muted"
          >
            {node.name}
          </Link>
          {node.children.length > 0 ? (
            <div className="ml-4 border-l border-border pl-1">
              <CategorySubList nodes={node.children} />
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function SearchIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="h-5 w-5"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}

function ChevronDownIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="h-3.5 w-3.5 opacity-60"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}
