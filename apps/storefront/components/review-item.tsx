import { formatReviewDate, type PublicReview } from '../lib/reviews-api';
import { StarRating } from './star-rating';

/**
 * One published review, as a list item.
 *
 * Extracted from `product-reviews.tsx` so that the first page (rendered on the
 * server, in the HTML) and every later page (fetched by `ReviewPager` in the
 * browser) are the same markup. Two copies would be two places for the
 * "compra verificada" badge, the shop's reply, or the date's timezone to drift
 * — and the drift would only ever show up below the fold, after a shopper
 * pressed "ver más".
 *
 * No `'use client'`. It has no state and no browser API, so it renders on the
 * server inside `ProductReviews` and is also pulled into the client bundle by
 * `ReviewPager` — which is exactly what a presentational component should be
 * able to do.
 *
 * Renders an `<li>` and nothing else, because both callers put it inside the
 * SAME `<ul>`: the server writes the first page's items, the pager appends the
 * rest into the same list, so a screen reader announces one list of reviews
 * rather than two lists that happen to be adjacent.
 */
export function ReviewItem({ review }: { review: PublicReview }) {
  return (
    <li className="flex flex-col gap-2 border-b border-border pb-6 last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        <StarRating average={review.rating} size="sm" />
        <span className="text-sm font-medium">{review.authorLabel}</span>
        {/* Said on every single review, not as a badge on some of them: on
            this store there is no other kind. It is the whole reason these
            reviews are worth more than a form anyone could fill in. */}
        <span className="rounded-full bg-emerald-600/10 px-2 py-0.5 text-xs text-emerald-700">
          Compra verificada
        </span>
        <span className="text-xs text-muted-foreground">{formatReviewDate(review.createdAt)}</span>
      </div>
      {review.title ? <p className="font-medium">{review.title}</p> : null}
      {review.bodyMd ? (
        // Plain text with line breaks preserved — this app still has no
        // markdown renderer (see the product description), and rendering
        // shopper-supplied markdown as HTML would be the worst possible place
        // to start.
        <p className="whitespace-pre-wrap text-sm text-muted-foreground">{review.bodyMd}</p>
      ) : null}

      {review.replyMd ? (
        <div className="mt-1 rounded-md border-l-2 border-primary/40 bg-muted/40 p-3">
          <p className="text-xs font-medium">
            Respuesta de la tienda
            {review.repliedAt ? ` · ${formatReviewDate(review.repliedAt)}` : ''}
          </p>
          <p className="whitespace-pre-wrap text-sm text-muted-foreground">{review.replyMd}</p>
        </div>
      ) : null}
    </li>
  );
}
