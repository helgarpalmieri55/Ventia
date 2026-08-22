import { cn } from '@ventia/ui';

/**
 * Every place the storefront shows a product photo goes through here.
 *
 * ## Why one component instead of a class string per call site
 *
 * Product imagery was previously written out by hand in each place that
 * needed it, and each place had picked a different answer: the grid tile
 * forced a square, the PDP forced a square per image with its own rounding,
 * and the agent's chat suggestions used a 48px square with a different radius.
 * A shopper scrolling a grid, opening a product and being shown the same
 * garment cropped differently at each step reads as three different stores.
 *
 * ## The three things this fixes, in order of how much they cost a sale
 *
 * 1. **A forced ratio.** Every photo lands in a 4:5 portrait box, cropped with
 *    `object-cover` — the merchant uploads whatever their phone took (there is
 *    no crop step in the admin yet; that is the open image-pipeline debt in
 *    product.md §1), and without a ratio a catalog of mixed portrait and
 *    landscape shots turns a grid into a ragged staircase. 4:5 rather than the
 *    square it replaces because clothing on a body is taller than it is wide,
 *    and this platform's first stores sell clothing.
 * 2. **No layout shift.** The box carries the aspect ratio, so the space is
 *    reserved before a single byte of the image arrives; the `<img>` is
 *    absolutely positioned inside it and therefore cannot resize its parent
 *    when it loads. On the mobile connections almost all of this traffic will
 *    arrive on, the alternative is a grid that jumps under the shopper's
 *    thumb as each thumbnail lands.
 * 3. **A real placeholder.** A product with no photo gets a drawn mark, not an
 *    empty grey rectangle that looks like a rendering bug.
 *
 * ## Still a plain `<img>`
 *
 * Not `next/image`, matching the convention this app and the admin already
 * follow: thumbnails come from whatever host the merchant uploaded to and
 * there is no `images.remotePatterns` config for it, so `next/image` would
 * refuse the URL outright. Consequences handled by hand here: `loading` and
 * `decoding` are set explicitly, and there is no `srcset` because the API
 * serves exactly one size per image today.
 *
 * A `src` that 404s is NOT handled — the browser draws its broken-image glyph
 * inside the reserved box. Catching that needs an `onError` handler, which
 * would make every product tile in the store a client component; the real fix
 * is validating the URL when the merchant uploads it.
 */
export interface ProductImageProps {
  /** `null`/`undefined` renders the placeholder. */
  src?: string | null;
  /** Empty string when the surrounding markup already names the product (the
   * grid tile prints the name right underneath), so a screen reader does not
   * hear it twice. */
  alt: string;
  /** `eager` only for an image that is certainly above the fold — the PDP's
   * first photo. Everything else stays lazy so a 200-product category page
   * does not open 200 connections. */
  loading?: 'lazy' | 'eager';
  /** Sizing and rounding for the call site: the box is `w-full` and square-
   * cornered by default, so a caller passes e.g. `w-12` or `rounded-md`. The
   * aspect ratio is deliberately not overridable — that is the whole point. */
  className?: string;
}

export function ProductImage({ src, alt, loading = 'lazy', className }: ProductImageProps) {
  return (
    <div
      // `@container` so the placeholder can drop its caption when it is being
      // rendered thumbnail-sized (chat suggestions, cart-sized boxes) — the
      // caption is unreadable below ~8rem and a viewport breakpoint cannot
      // tell those apart from a full-width tile on the same screen.
      className={cn('@container relative aspect-[4/5] w-full overflow-hidden bg-muted', className)}
    >
      {src ? (
        <img
          src={src}
          alt={alt}
          loading={loading}
          decoding="async"
          className="absolute inset-0 h-full w-full object-cover"
        />
      ) : (
        <NoPhoto />
      )}
    </div>
  );
}

/** The no-photo mark: a bag outline and an es-CO caption, both in the tenant's
 * muted foreground so it reads as part of the store's palette rather than as
 * a missing asset. `aria-hidden` because it says nothing a shopper needs —
 * the product's name is always adjacent to it, and `ProductImage`'s `alt`
 * only describes an image that exists. */
function NoPhoto() {
  return (
    <div
      aria-hidden="true"
      className="absolute inset-0 flex flex-col items-center justify-center gap-[4%] text-muted-foreground"
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.25}
        strokeLinecap="round"
        strokeLinejoin="round"
        className="w-[30%] opacity-45"
      >
        <path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z" />
        <path d="M3 6h18" />
        <path d="M16 10a4 4 0 0 1-8 0" />
      </svg>
      <span className="hidden text-[0.6875rem] uppercase tracking-[0.18em] opacity-60 @[8rem]:block">
        Sin foto
      </span>
    </div>
  );
}
