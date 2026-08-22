import { starFillPercents } from '../lib/reviews-api';

/**
 * Five stars filled to the true average — 4,3 draws as 4.3 stars, not 4.5.
 *
 * Each star is one glyph painted twice: an empty one underneath, and a clipped
 * copy on top whose width is the percentage `starFillPercents` computed. That
 * is the whole implementation, which matters here: no icon package, no
 * JavaScript, and it renders inside a Server Component so the rating is in the
 * HTML a crawler reads.
 *
 * Not interactive. The star PICKER in `review-composer.tsx` is a separate,
 * client-side control with real buttons — a rating you can click has to be
 * reachable by keyboard, and conflating the two would either make this
 * decorative row focusable or leave the picker unusable without a mouse.
 */
export function StarRating({ average, size = 'md' }: { average: number | null; size?: 'sm' | 'md' | 'lg' }) {
  const percents = starFillPercents(average);
  const sizeClass = size === 'lg' ? 'text-2xl' : size === 'sm' ? 'text-sm' : 'text-base';

  return (
    <span
      className={`inline-flex leading-none ${sizeClass}`}
      // One label for the whole row. Five separate stars announced one by one
      // is noise; "4,3 de 5" is the information.
      role="img"
      aria-label={average === null ? 'Sin calificación' : `${average.toFixed(1).replace('.', ',')} de 5`}
    >
      {percents.map((percent, index) => (
        <span key={index} className="relative inline-block" aria-hidden="true">
          <span className="text-muted-foreground/30">★</span>
          <span
            className="absolute inset-y-0 left-0 overflow-hidden text-amber-500"
            style={{ width: `${percent}%` }}
          >
            ★
          </span>
        </span>
      ))}
    </span>
  );
}
