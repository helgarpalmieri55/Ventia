'use client';

import * as React from 'react';
import { usePathname } from 'next/navigation';
import { Button, Spinner } from '@ventia/ui';
import {
  REVIEW_PAGE_ERROR,
  fetchReviewsPage,
  mergeReviewPages,
  productSlugFromPath,
  reviewPagerState,
  type PublicReview,
} from '../lib/reviews-api';
import { ReviewItem } from './review-item';

/**
 * "Ver 10 reseñas más" — the second client island in the reviews section, and
 * the only one that exists purely because of where its data lives.
 *
 * ## Why an island, when everything around it is server-rendered
 *
 * `ProductReviews` is a COMPONENT, not a page. In the App Router only a page
 * receives `searchParams`, so the cheap version of this — a `?resenas=2` link
 * that re-renders on the server, no JavaScript at all — would have to be
 * plumbed through `app/productos/[slug]/page.tsx`, which is what owns the
 * reviews fetch. That is the right shape for a page whose whole content is a
 * list. It is the wrong shape for a section three quarters of the way down a
 * product page: following it reloads the photos, the price, the variant
 * picker and the cart button, and drops the shopper at the top of a page they
 * had scrolled to the bottom of. A pager that appends is the behaviour the
 * control actually promises.
 *
 * So: page 1 stays server-rendered — it is in the HTML, it is what a crawler
 * indexes, and it is what a shopper on a slow phone sees without waiting for
 * any script — and this island only ever fetches page 2 onward. Nobody who
 * does not press the button pays for it.
 *
 * ## What it renders, and where
 *
 * `<li>` elements, into the SAME `<ul>` the server already filled (see
 * `ReviewItem`). Appending a second list below the first would announce
 * "lista, 10 elementos" twice to a screen reader for what is one list of
 * reviews.
 *
 * ## What it renders when it cannot work
 *
 * Nothing. If the URL is not a product page (so there is no slug to ask
 * about), or the store has nothing more than what is already shown, this
 * returns `null` and the section is exactly what it was before this component
 * existed. A failed request is different — the shopper pressed something, so
 * they are told, and the button stays so they can try again.
 */
export function ReviewPager({
  total,
  shownIds,
  pageSize,
  firstPage,
}: {
  /** `summary.count` — the store's count of PUBLISHED reviews for this
   * product, which is also the denominator of the average above. */
  total: number;
  /** The ids the server already rendered. Ids and not the reviews themselves:
   * this component does not re-render them, it only needs to know not to
   * append one twice when an offset page overlaps. */
  shownIds: string[];
  pageSize: number;
  /** The page the server rendered — 1 in practice, and read from the response
   * rather than assumed so this counts from wherever it actually started. */
  firstPage: number;
}) {
  const pathname = usePathname();
  const [extra, setExtra] = React.useState<PublicReview[]>([]);
  const [lastPage, setLastPage] = React.useState(firstPage);
  const [loading, setLoading] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  // Set when a page comes back with no rows at all. `total` and the list are
  // two separate reads, so a review hidden between them leaves a count
  // promising a row that no offset will ever return — and without this the
  // button would still be there, doing nothing, forever.
  const [exhausted, setExhausted] = React.useState(false);

  const slug = productSlugFromPath(pathname);
  const shown = shownIds.length + extra.length;
  const state = reviewPagerState(shown, total, pageSize, exhausted);

  async function loadMore() {
    if (!slug || loading) return;
    setLoading(true);
    setFailed(false);
    try {
      const next = await fetchReviewsPage(slug, lastPage + 1, pageSize);
      if (next.reviews.length === 0) setExhausted(true);
      // Merged against everything on screen, the server's first page
      // included: paging by offset over a list ordered newest-first means a
      // review posted since the page loaded shifts every later row down one,
      // and the same review would otherwise be drawn twice.
      setExtra((current) => mergeReviewPages(current, next.reviews, shownIds));
      setLastPage((current) => current + 1);
    } catch (err) {
      console.error('[reviews] failed to load another page', err);
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }

  // No slug means this is not a product page and there is nothing this can
  // ask for — so the button goes, but the SENTENCE stays. "Mostrando 10 de 34
  // reseñas." is the line this section carried before the pager existed, and
  // it is still true; dropping it as well would make a broken pager quietly
  // cost the shopper information they used to have.
  const showButton = slug !== null && state.buttonLabel !== null;

  // Nothing to append, nothing to say, nothing to press, nothing to apologise
  // for — which is the ordinary case, a product whose reviews all fit.
  if (extra.length === 0 && state.statusLabel === null && !showButton && !failed) return null;

  return (
    <>
      {extra.map((review) => (
        <ReviewItem key={review.id} review={review} />
      ))}

      {/* An `<li>` because it lives inside the reviews `<ul>`; `list-none` so
          it is not announced or bulleted as if it were a review. */}
      <li className="flex list-none flex-col items-start gap-3">
        {state.statusLabel ? <p className="text-sm text-muted-foreground">{state.statusLabel}</p> : null}

        {failed ? (
          // `role="alert"`: the shopper pressed a button and nothing visible
          // changed, so this has to interrupt rather than wait to be found.
          <p role="alert" className="text-sm text-destructive">
            {REVIEW_PAGE_ERROR}
          </p>
        ) : null}

        {showButton ? (
          <Button variant="secondary" onClick={loadMore} disabled={loading}>
            {loading ? <Spinner /> : null}
            {loading ? 'Cargando…' : state.buttonLabel}
          </Button>
        ) : null}
      </li>
    </>
  );
}
