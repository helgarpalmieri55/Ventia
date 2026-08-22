'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Alert, Button, Input, Spinner } from '@ventia/ui';
import {
  BODY_MAX,
  RATING_CHOICES,
  RATING_LABELS,
  TITLE_MAX,
  composerCopy,
  fetchReviewEligibility,
  formatReviewDate,
  reviewErrorMessage,
  reviewFormError,
  type EligibilityResult,
} from '../lib/reviews-api';
import { StarRating } from './star-rating';

/**
 * "Escribe una reseña" — the only client island in the reviews section.
 *
 * ## It asks the server who is reading
 *
 * The session cookie is HttpOnly, so this component cannot know whether anyone
 * is signed in, let alone whether they bought this product. It asks
 * (`GET /api/account/reviews?productId=`) and renders the answer. While that
 * is in flight it renders a spinner rather than the signed-out message:
 * flashing "inicia sesión" at a shopper who is signed in and has already
 * bought the thing is the one wrong answer this component can give.
 *
 * ## Every non-writable state still says something
 *
 * See `composerCopy` — a shopper who has not bought this product is told so
 * plainly, because that sentence is the reason the reviews above it are worth
 * reading.
 */
export function ReviewComposer({ productId }: { productId: string }) {
  const router = useRouter();
  const [state, setState] = React.useState<EligibilityResult | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    fetchReviewEligibility(productId)
      .then((result) => {
        if (!cancelled) setState(result);
      })
      .catch((err) => {
        // A genuine fault (not a 401 — that is already `null`). The section
        // collapses to nothing rather than showing a form that cannot work.
        console.error('[reviews] failed to resolve eligibility', err);
        if (!cancelled) setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [productId]);

  if (loading) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner /> Cargando…
      </p>
    );
  }
  if (failed) return null;

  const copy = composerCopy(state);

  return (
    <div className="flex flex-col gap-3 rounded-md border border-border p-4">
      <p className="text-sm text-muted-foreground">{copy.message}</p>

      {copy.action ? (
        <Link className="text-sm font-medium underline underline-offset-4" href={copy.action.href}>
          {copy.action.label}
        </Link>
      ) : null}

      {state?.review ? <OwnReviewCard review={state.review} /> : null}

      {copy.showForm ? (
        <ReviewForm
          productId={productId}
          onPosted={(review) => {
            // Update this island immediately AND ask the server to re-render
            // the list above it, which is a Server Component and knows nothing
            // about what just happened here. Without the refresh the shopper
            // posts a review and watches the page not change, which reads as a
            // failure and produces a second submit (and a 409).
            setState({ eligibility: 'already_reviewed', review });
            router.refresh();
          }}
        />
      ) : null}
    </div>
  );
}

/** The shopper's own review, echoed back. Rendered even when the merchant has
 * hidden it — `composerCopy` says so in words, and showing it as if it were
 * live would simply be a lie to the person who wrote it. */
function OwnReviewCard({ review }: { review: NonNullable<EligibilityResult['review']> }) {
  return (
    <div className="flex flex-col gap-1 rounded-md bg-muted/40 p-3">
      <div className="flex items-center gap-2">
        <StarRating average={review.rating} size="sm" />
        <span className="text-xs text-muted-foreground">{formatReviewDate(review.createdAt)}</span>
      </div>
      {review.title ? <p className="text-sm font-medium">{review.title}</p> : null}
      {review.bodyMd ? <p className="whitespace-pre-wrap text-sm">{review.bodyMd}</p> : null}
    </div>
  );
}

function ReviewForm({
  productId,
  onPosted,
}: {
  productId: string;
  onPosted: (review: NonNullable<EligibilityResult['review']>) => void;
}) {
  const [rating, setRating] = React.useState<number | null>(null);
  const [title, setTitle] = React.useState('');
  const [bodyMd, setBodyMd] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const invalid = reviewFormError({ rating, title, bodyMd });
    if (invalid) {
      setError(invalid);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      // Imported lazily so the submit path is the only thing that pulls it in.
      const { submitReview } = await import('../lib/reviews-api');
      const review = await submitReview({
        productId,
        rating: rating as number,
        title: title.trim(),
        bodyMd: bodyMd.trim(),
      });
      onPosted(review);
    } catch (err) {
      setError(reviewErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="flex flex-col gap-3" onSubmit={handleSubmit}>
      {/* Real buttons, not a decorative star row: a rating has to be
          selectable with a keyboard, and `aria-pressed` is what tells a screen
          reader which one is currently chosen. */}
      <fieldset className="flex flex-col gap-1">
        <legend className="text-sm font-medium">¿Cómo te pareció?</legend>
        <div className="flex items-center gap-1">
          {RATING_CHOICES.map((choice) => (
            <button
              key={choice}
              type="button"
              onClick={() => setRating(choice)}
              aria-pressed={rating === choice}
              aria-label={`${choice} — ${RATING_LABELS[choice]}`}
              className={`text-2xl leading-none ${
                rating !== null && choice <= rating ? 'text-amber-500' : 'text-muted-foreground/40'
              }`}
            >
              ★
            </button>
          ))}
          {rating !== null ? <span className="ml-2 text-sm text-muted-foreground">{RATING_LABELS[rating]}</span> : null}
        </div>
      </fieldset>

      <Input
        value={title}
        maxLength={TITLE_MAX}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Título (opcional)"
        aria-label="Título de la reseña"
      />

      {/* A plain textarea: `@ventia/ui` has no multiline control, and adding
          one to the shared kit for a single screen is not this task's job. */}
      <textarea
        value={bodyMd}
        maxLength={BODY_MAX}
        onChange={(e) => setBodyMd(e.target.value)}
        rows={4}
        placeholder="Cuéntanos cómo te fue (opcional)"
        aria-label="Tu reseña"
        className="w-full rounded-md border border-border bg-background p-2 text-sm"
      />

      {error ? <Alert variant="error">{error}</Alert> : null}

      <div>
        <Button type="submit" disabled={submitting}>
          {submitting ? 'Publicando…' : 'Publicar reseña'}
        </Button>
      </div>
      {/* Said before they click, not after. Reviews here go live immediately —
          there is no queue — and a shopper should know that their name (short
          form) and their words will be on the page. */}
      <p className="text-xs text-muted-foreground">
        Tu reseña se publica de inmediato con tu nombre abreviado.
      </p>
    </form>
  );
}
