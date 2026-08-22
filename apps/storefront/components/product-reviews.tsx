import {
  distributionRows,
  formatAverage,
  formatReviewDate,
  reviewCountLabel,
  type ProductReviews as ProductReviewsData,
} from '../lib/reviews-api';
import { ReviewComposer } from './review-composer';
import { StarRating } from './star-rating';

/**
 * The reviews block on a product page: the average, the 5→1 breakdown, the
 * reviews themselves, and the one client island that lets a buyer add theirs.
 *
 * A Server Component, so the reviews are in the HTML — they are the part of a
 * product page a search engine most wants and a slow phone least wants to wait
 * for. Only `ReviewComposer` is client-side, because only it depends on who is
 * reading.
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

        <ul className="flex flex-col gap-6">
          {reviews.map((review) => (
            <li key={review.id} className="flex flex-col gap-2 border-b border-border pb-6 last:border-b-0">
              <div className="flex flex-wrap items-center gap-2">
                <StarRating average={review.rating} size="sm" />
                <span className="text-sm font-medium">{review.authorLabel}</span>
                {/* Said on every single review, not as a badge on some of
                    them: on this store there is no other kind. It is the whole
                    reason these reviews are worth more than a form anyone
                    could fill in. */}
                <span className="rounded-full bg-emerald-600/10 px-2 py-0.5 text-xs text-emerald-700">
                  Compra verificada
                </span>
                <span className="text-xs text-muted-foreground">{formatReviewDate(review.createdAt)}</span>
              </div>
              {review.title ? <p className="font-medium">{review.title}</p> : null}
              {review.bodyMd ? (
                // Plain text with line breaks preserved — this app still has
                // no markdown renderer (see the product description), and
                // rendering shopper-supplied markdown as HTML would be the
                // worst possible place to start.
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
          ))}
        </ul>
      </div>

      {summary && summary.count > reviews.length ? (
        <p className="text-sm text-muted-foreground">
          {/* Honest about what is on screen rather than pretending this is all
              of them. A pager here would need a client island and a second
              round trip; saying the number costs nothing and does not lie. */}
          Mostrando las {reviews.length} reseñas más recientes de {summary.count}.
        </p>
      ) : null}
    </section>
  );
}
