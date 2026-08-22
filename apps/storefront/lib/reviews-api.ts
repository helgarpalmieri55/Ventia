import { AccountApiError } from './account-api';
import { fetchStorefrontOrNull } from './storefront-api';

/**
 * Product reviews, from the storefront's side: the shapes the API returns, the
 * two calls the browser makes, and all of the display logic those calls feed.
 *
 * The display logic is here rather than inline in the components for the usual
 * reason in this app — vitest runs under Node with no DOM, so anything worth
 * asserting has to live in a module a test can import. That is not a
 * formality here: "how many stars is a 4.3", "what do we say to someone who
 * has not bought this", and "what percentage bar goes next to 0 reviews" are
 * exactly the places this feature can quietly render something wrong.
 *
 * ## Two different transports, on purpose
 *
 * The public list is fetched SERVER-side (`fetchStorefront`, like every other
 * storefront page) so the reviews are in the HTML for the shopper and for a
 * crawler. The shopper's own two calls go through the browser's same-origin
 * `/api/account/*` proxy, because they need the HttpOnly `ventia_shopper`
 * cookie and that cookie only round-trips through that proxy — see
 * `app/api/account/[[...path]]/route.ts`.
 */

/** One published review. `authorLabel` is already abbreviated by the API
 * (`reviewAuthorLabel` in `@ventia/core`) — the storefront never receives the
 * full name or the address and so cannot leak either. */
export interface PublicReview {
  id: string;
  rating: number;
  title: string | null;
  bodyMd: string;
  authorLabel: string;
  createdAt: string;
  replyMd: string | null;
  repliedAt: string | null;
}

export interface RatingSummary {
  /** `null` means "no reviews yet", and is NOT interchangeable with 0 — a 0
   * would render as the worst possible score on every new product. */
  average: number | null;
  count: number;
  distribution: Record<string, number>;
}

export interface ProductReviews {
  summary: RatingSummary;
  reviews: PublicReview[];
  page: number;
  pageSize: number;
}

/** The shopper's own review, as `GET /account/reviews` returns it. Carries
 * `status`, unlike the public shape: a shopper whose review the merchant hid
 * is told so, rather than being shown it back as if it were live. */
export interface OwnReview {
  id: string;
  rating: number;
  title: string | null;
  bodyMd: string;
  status: 'published' | 'hidden';
  createdAt: string;
  replyMd: string | null;
  repliedAt: string | null;
}

/** What the API says about this shopper and this product. `signed_out` is not
 * one of the API's answers — it is a 401, which this module maps to `null` and
 * the composer renders as "inicia sesión". */
export type Eligibility = 'can_review' | 'already_reviewed' | 'not_purchased' | 'email_not_verified';

export interface EligibilityResult {
  eligibility: Eligibility;
  review: OwnReview | null;
}

/**
 * Server-side read for the product page.
 *
 * `fetchStorefrontOrNull`, not the throwing variant, and that is a product
 * decision rather than defensive habit: this fetch runs on the page where the
 * sale happens, and an upstream hiccup in REVIEWS must not take down the
 * photos, the price and the "Agregar al carrito" button with it. `null` (no
 * reviews section content) is the right degradation; a crashed PDP is not.
 *
 * `null` therefore covers two cases — a 404 (which the page has already
 * handled by the time it renders) and a transient failure. `ProductReviews`
 * treats both the same way, since neither is something to explain to a shopper.
 */
export async function fetchProductReviews(
  tenantHost: string,
  slug: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ProductReviews | null> {
  return fetchStorefrontOrNull<ProductReviews>(
    tenantHost,
    `/v1/storefront/products/${encodeURIComponent(slug)}/reviews`,
    fetchImpl,
  );
}

/**
 * Whether this browser's shopper may review this product.
 *
 * A 401 becomes `null` — "not signed in" — for the same reason `fetchMe` does
 * it: most people reading a product page are not signed in, and that is an
 * answer, not a failure. Every other status still throws, because a composer
 * that silently rendered "inicia sesión" at a signed-in shopper would send
 * them round a sign-in loop they are already through.
 */
export async function fetchReviewEligibility(
  productId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<EligibilityResult | null> {
  const res = await fetchImpl(`/api/account/reviews?productId=${encodeURIComponent(productId)}`, {
    method: 'GET',
    credentials: 'include',
  });
  if (res.status === 401) return null;
  if (!res.ok) throw await reviewApiError(res);
  return (await res.json()) as EligibilityResult;
}

/**
 * Posts the review.
 *
 * Sends only what the shopper wrote. There is deliberately no `orderId` in
 * this payload even though the client could often work one out: the API
 * resolves the entitling order from the session, and a client that offered one
 * would be inviting the API to trust it.
 */
export async function submitReview(
  input: { productId: string; rating: number; title?: string; bodyMd?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<OwnReview> {
  const body: Record<string, unknown> = { productId: input.productId, rating: input.rating };
  // Omitted rather than sent blank: the API's schema has both optional with a
  // `min(1)`, so `''` is a 400 while an absent key is the intended "didn't say".
  if (input.title) body.title = input.title;
  if (input.bodyMd) body.bodyMd = input.bodyMd;

  const res = await fetchImpl('/api/account/reviews', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await reviewApiError(res);
  return ((await res.json()) as { review: OwnReview }).review;
}

/** Reuses `AccountApiError` rather than declaring a third error class: these
 * calls go through the same proxy, carry the same `{ error }` code shape, and
 * a page that catches one already catches the other. */
async function reviewApiError(res: Response): Promise<AccountApiError> {
  let code = 'UNKNOWN';
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body?.error === 'string') code = body.error;
  } catch {
    // A non-JSON error body (a proxy timeout page, say) is not worth a
    // different failure mode than an unrecognised code.
  }
  return new AccountApiError(res.status, code);
}

// ---- display -------------------------------------------------------------

/**
 * The average, in Colombian notation: `4.5` → `"4,5"`.
 *
 * Always one decimal, so `5` prints as `"5,0"` and the number does not change
 * width as a store's reviews come in. `null` for "no rating yet" — the caller
 * has to say something else, and cannot accidentally print a zero.
 */
export function formatAverage(average: number | null): string | null {
  if (average === null || !Number.isFinite(average)) return null;
  return average.toFixed(1).replace('.', ',');
}

/** "1 reseña" / "12 reseñas". The kind of copy nobody re-reads after writing
 * it, on the screen where a shopper decides to spend money. */
export function reviewCountLabel(count: number): string {
  return count === 1 ? '1 reseña' : `${count} reseñas`;
}

/**
 * How full each of the five stars is, left to right, as a percentage.
 *
 * A percentage rather than full/half/empty because a 4.3 drawn as four and a
 * half stars is a 4.5, and the number printed beside it says 4,3 — a shopper
 * who notices that stops trusting both. A CSS width renders the true value at
 * no extra cost.
 *
 * `null` (no reviews) gives five empty stars, never five full ones: an
 * unrated product must not be able to look perfect.
 */
export function starFillPercents(average: number | null): number[] {
  if (average === null || !Number.isFinite(average)) return [0, 0, 0, 0, 0];
  return [1, 2, 3, 4, 5].map((position) => {
    const filled = (average - (position - 1)) * 100;
    return Math.max(0, Math.min(100, Math.round(filled)));
  });
}

export interface DistributionRow {
  rating: number;
  count: number;
  /** 0..100, rounded. */
  percent: number;
}

/**
 * The 5→1 bar chart under the average.
 *
 * Ordered highest first, which is the order everyone reads this control in,
 * and always five rows so the chart does not change height between products.
 *
 * The division guards against a zero total explicitly. `0/0` is `NaN`, and a
 * `NaN%` CSS width is silently dropped by the browser — which means the bug
 * would not show up as a broken page but as bars that look full, on exactly
 * the products that have no reviews at all.
 */
export function distributionRows(summary: RatingSummary): DistributionRow[] {
  return [5, 4, 3, 2, 1].map((rating) => {
    const count = summary.distribution[String(rating)] ?? 0;
    return {
      rating,
      count,
      percent: summary.count > 0 ? Math.round((count / summary.count) * 100) : 0,
    };
  });
}

const DATE_FORMATTER = new Intl.DateTimeFormat('es-CO', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  // Bogotá, not the reader's clock — same reasoning as `account-orders.ts`:
  // a review written at 21:30 on the 3rd is stored as 02:30Z on the 4th, and
  // for a store whose customers and merchant are both in Colombia the
  // merchant's own day is the only right answer.
  timeZone: 'America/Bogota',
});

/** Returns the RAW value for an unparseable date rather than "Invalid Date" —
 * same convention as `formatOrderDate`. */
export function formatReviewDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return DATE_FORMATTER.format(date);
}

/**
 * What the composer shows, given who is reading.
 *
 * `null` from {@link fetchReviewEligibility} means signed out; everything else
 * is the API's own verdict. Each state gets a real sentence with a real next
 * step, because the alternative — hiding the form and saying nothing — makes
 * the section look broken to the one shopper it most needs to convert.
 *
 * "Solo quienes compraron este producto pueden reseñarlo" is said out loud
 * rather than silently hidden. It is the reason the reviews above it are worth
 * reading, so it is a selling point, not an apology.
 */
export interface ComposerCopy {
  message: string;
  /** Where the shopper goes to fix it, when there is somewhere to go. */
  action: { label: string; href: string } | null;
  /** Whether to render the form at all. */
  showForm: boolean;
}

export function composerCopy(result: EligibilityResult | null): ComposerCopy {
  if (result === null) {
    return {
      message: 'Inicia sesión para escribir una reseña de este producto.',
      action: { label: 'Entrar', href: '/cuenta/entrar' },
      showForm: false,
    };
  }
  switch (result.eligibility) {
    case 'can_review':
      return { message: 'Compraste este producto. Cuéntanos cómo te fue.', action: null, showForm: true };
    case 'email_not_verified':
      return {
        message: 'Confirma tu correo para poder escribir una reseña.',
        action: { label: 'Ir a mi cuenta', href: '/cuenta' },
        showForm: false,
      };
    case 'not_purchased':
      return {
        message: 'Solo quienes compraron este producto pueden reseñarlo. Por eso puedes confiar en las reseñas de abajo.',
        action: null,
        showForm: false,
      };
    case 'already_reviewed':
      return {
        message:
          result.review?.status === 'hidden'
            ? 'Ya escribiste tu reseña. En este momento no está visible en la tienda.'
            : 'Ya escribiste tu reseña de este producto. ¡Gracias!',
        action: null,
        showForm: false,
      };
  }
}

/** Ratings the form offers, worst to best — the order a star row is drawn in. */
export const RATING_CHOICES = [1, 2, 3, 4, 5] as const;

/** es-CO word for each star, so the control is understandable to a screen
 * reader and to someone who is not sure whether 1 is good or bad. */
export const RATING_LABELS: Record<number, string> = {
  1: 'Muy malo',
  2: 'Malo',
  3: 'Regular',
  4: 'Bueno',
  5: 'Excelente',
};

/** Mirrors `REVIEW_TITLE_MAX` / `REVIEW_BODY_MAX` in `@ventia/core`. Local
 * copies so the textarea can count down without pulling the whole schema
 * package into the browser bundle; `reviewFormError` is what keeps them
 * honest, since the API rejects anything longer anyway. */
export const TITLE_MAX = 120;
export const BODY_MAX = 4000;

/**
 * Client-side check before submitting. Returns an es-CO message or `null`.
 *
 * Deliberately NOT the authority — the API validates the same things and is
 * the only thing an attacker cannot skip. This exists so a shopper who forgot
 * to pick a star is told so instantly instead of watching a request fail.
 */
export function reviewFormError(input: { rating: number | null; title: string; bodyMd: string }): string | null {
  if (input.rating === null) return 'Elige cuántas estrellas le das.';
  if (!Number.isInteger(input.rating) || input.rating < 1 || input.rating > 5) {
    return 'Elige cuántas estrellas le das.';
  }
  if (input.title.trim().length > TITLE_MAX) return `El título no puede pasar de ${TITLE_MAX} caracteres.`;
  if (input.bodyMd.trim().length > BODY_MAX) return `La reseña no puede pasar de ${BODY_MAX} caracteres.`;
  return null;
}

/**
 * What went wrong, in es-CO, for the codes this form can actually provoke.
 *
 * `PURCHASE_REQUIRED` and `EMAIL_NOT_VERIFIED` are reachable even though the
 * composer checks eligibility first: the page may have been open for an hour,
 * and the answer can change underneath it. Falling back to a generic sentence
 * for anything else is deliberate — a shopper reading `VALIDATION_FAILED` has
 * been told nothing.
 */
export function reviewErrorMessage(err: unknown): string {
  const code = err instanceof AccountApiError ? err.code : 'UNKNOWN';
  switch (code) {
    case 'PURCHASE_REQUIRED':
      return 'Solo quienes compraron este producto pueden reseñarlo.';
    case 'EMAIL_NOT_VERIFIED':
      return 'Confirma tu correo para poder escribir una reseña.';
    case 'REVIEW_ALREADY_EXISTS':
      return 'Ya habías escrito una reseña de este producto.';
    default:
      return 'No pudimos guardar tu reseña. Intenta de nuevo.';
  }
}
