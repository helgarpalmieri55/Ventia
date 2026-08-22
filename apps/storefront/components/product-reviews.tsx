import {
  REVIEWS_PAGE_SIZE,
  distributionRows,
  formatAverage,
  reviewCountLabel,
  type ProductReviews as ProductReviewsData,
} from '../lib/reviews-api';
import { ReviewComposer } from './review-composer';
import { ReviewItem } from './review-item';
import { ReviewPager } from './review-pager';
import { StarRating } from './star-rating';

/**
 * The reviews block on a product page: the average, the 5→1 breakdown, the
 * reviews themselves, the control that reaches the rest of them, and the
 * island that lets a buyer add theirs.
 *
 * A Server Component, so the reviews are in the HTML — they are the part of a
 * product page a search engine most wants and a slow phone least wants to wait
 * for. Two client islands hang off it, and each one earns its place by
 * depending on something the server does not know: `ReviewComposer` on who is
 * reading, and `ReviewPager` on what the reader has asked to see. The FIRST
 * page of reviews is server-rendered either way, so a shopper who never
 * presses anything and a crawler that runs no JavaScript both get the same
 * thing they got before either island existed.
 *
 * ## The empty state is not an empty section
 *
 * A product with no reviews still renders this block, still says so in words,
 * and still offers the form to whoever bought it. Hiding the section on zero
 * reviews would leave the store with no way for its first review ever to be
 * written — the products that most need one are exactly the ones that have
 * none.
 */
export function ProductReviews({ productId, data }: { productId: string; data: ProductReviewsData | null }) {
  // `null` means the reviews fetch failed (the product itself is already known
  // to exist — the page rendered). The composer still goes up: a shopper who
  // came back to write about something they bought should not be blocked by a
  // failure to LIST what other people wrote.
  const summary = data?.summary ?? null;
  const reviews = data?.reviews ?? [];
  const average = summary?.average ?? null;
  const formattedAverage = formatAverage(average);

  return (
    <section className="flex flex-col gap-6" id="resenas">
      <h2 className="text-xl font-semibold">Reseñas</h2>

      <div className="grid gap-6 md:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
        <div className="flex flex-col gap-3">
          {formattedAverage !== null && summary ? (
            <>
              <div className="flex items-baseline gap-2">
                <span className="text-3xl font-semibold">{formattedAverage}</span>
                <span className="text-sm text-muted-foreground">de 5</span>
              </div>
              <StarRating average={average} size="lg" />
              <p className="text-sm text-muted-foreground">
                {/* The count is as load-bearing as the average: 5,0 out of two
                    reviews and 4,6 out of two hundred are different claims,
                    and only the count tells them apart. */}
                {reviewCountLabel(summary.count)}
              </p>
              <ul className="flex flex-col gap-1">
                {distributionRows(summary).map((row) => (
                  <li key={row.rating} className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span className="w-8 shrink-0">{row.rating} ★</span>
                    <span className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                      <span className="block h-full bg-amber-500" style={{ width: `${row.percent}%` }} />
                    </span>
                    <span className="w-6 shrink-0 text-right">{row.count}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              Este producto todavía no tiene reseñas. Si lo compraste, tu opinión será la primera.
            </p>
          )}

          <ReviewComposer productId={productId} />
        </div>

        {/* ONE list, whoever rendered the row. The server writes the first
            page's items and `ReviewPager` appends the rest into this same
            `<ul>` — two adjacent lists would be announced as two lists of
            reviews, which is not what a shopper is reading. */}
        <ul className="flex flex-col gap-6">
          {reviews.map((review) => (
            <ReviewItem key={review.id} review={review} />
          ))}
          {/* The pager replaces the sentence that used to sit here ("mostrando
              las 10 reseñas más recientes de 34") and says the same true thing
              while doing something about it. It renders nothing at all when
              the whole list is already on screen, which is the common case. */}
          <ReviewPager
            total={summary?.count ?? reviews.length}
            shownIds={reviews.map((review) => review.id)}
            pageSize={data?.pageSize ?? REVIEWS_PAGE_SIZE}
            firstPage={data?.page ?? 1}
          />
        </ul>
      </div>
    </section>
  );
}
