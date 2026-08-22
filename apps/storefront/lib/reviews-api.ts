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

/**
 * How many reviews one request brings back.
 *
 * Mirrors `DEFAULT_PAGE_SIZE` in
 * `services/api/src/reviews/storefront-reviews.controller.ts`. Sent
 * explicitly on every pager request rather than left to the API's default,
 * because the pager's arithmetic ("ver 10 reseñas más") is a promise about
 * how many arrive, and a default that drifted on the server would make this
 * app lie in Spanish rather than merely fetch a different number.
 *
 * The FIRST page is not fetched by this app at all — the product page renders
 * it server-side — so `ProductReviews` passes the API's own reported
 * `pageSize` down and this constant is only the fallback for a response that
 * did not carry one.
 */
export const REVIEWS_PAGE_SIZE = 10;

/**
 * The product slug from the URL the reviews section is standing on.
 *
 * ## Why the pager reads the address bar
 *
 * `ProductReviews` is a COMPONENT, not a page. Only a page receives
 * `searchParams`/`params` in the App Router, so a link-based `?page=2` pager
 * would have to be plumbed through `app/productos/[slug]/page.tsx` — and the
 * component is handed `productId` and the reviews themselves, never the slug.
 * The public reviews endpoint is keyed by slug (it hangs off the product's own
 * URL), so the client island needs one.
 *
 * It is not a guess: the reviews block only ever renders on `/productos/<slug>`
 * and that path segment IS the product slug the endpoint wants — the same
 * value, from the same column, by construction.
 *
 * Returns `null` for anything that is not that route, and the pager drops its
 * BUTTON when it does — keeping the "Mostrando 10 de 34 reseñas." line, which
 * is exactly what the section said before any of this existed. Degrading to
 * the previous behaviour rather than to nothing is what lets this afford to be
 * strict about which paths it accepts.
 */
export function productSlugFromPath(pathname: string): string | null {
  const match = /^\/productos\/([^/?#]+)\/?$/.exec(pathname);
  if (!match) return null;
  try {
    // The pathname arrives percent-encoded; `fetchReviewsPage` re-encodes it.
    // Decoding first is what keeps a slug from being double-escaped on the way
    // back out.
    const slug = decodeURIComponent(match[1]);
    return slug.length > 0 ? slug : null;
  } catch {
    // A malformed escape (`%zz`) is not a slug this store ever minted.
    return null;
  }
}

/**
 * One more page of reviews, through the storefront's own origin.
 *
 * Not a direct call to the API: `API_INTERNAL_URL` is an internal hostname the
 * browser cannot reach at all (see `app/api/cart/[[...path]]/route.ts`), which
 * is why every browser-side read in this app goes through a Route Handler.
 * This one is `app/api/reviews/[slug]/route.ts` — a plain forwarder, no
 * cookies involved, because published reviews are readable by someone who has
 * never signed in.
 *
 * Throws on any non-OK status rather than resolving to `null`. The first page
 * is already on screen, so a failure here is not "there are no reviews" — it
 * is "we could not get more", and the pager has a sentence for that.
 */
export async function fetchReviewsPage(
  slug: string,
  page: number,
  pageSize: number,
  fetchImpl: typeof fetch = fetch,
): Promise<ProductReviews> {
  const res = await fetchImpl(
    `/api/reviews/${encodeURIComponent(slug)}?page=${page}&pageSize=${pageSize}`,
    { method: 'GET' },
  );
  if (!res.ok) throw await reviewApiError(res);
  return (await res.json()) as ProductReviews;
}

/**
 * Appends a freshly fetched page to what is already on screen, dropping
 * anything already there.
 *
 * The dedupe is not defensive habit. This pages by OFFSET over a list ordered
 * `createdAt desc`, so a review posted between the server render and the
 * shopper pressing the button shifts every later row down one — and page 2
 * then legitimately repeats the last review of page 1. Rendering the same
 * review twice, under a "compra verificada" badge, is the storefront claiming
 * two people said the same thing.
 *
 * Nothing is reordered and nothing already shown is removed: the shopper is
 * reading this list, and rows moving under them is worse than a row arriving
 * late.
 *
 * `alreadyShownIds` is how the caller excludes rows it is NOT holding in
 * `loaded` — the first page, which the server rendered into the HTML and which
 * the pager therefore never has objects for. Ids and not reviews, so that
 * page's bodies are not shipped a second time in the RSC payload just to be
 * compared against.
 */
export function mergeReviewPages(
  loaded: PublicReview[],
  incoming: PublicReview[],
  alreadyShownIds: readonly string[] = [],
): PublicReview[] {
  const seen = new Set([...alreadyShownIds, ...loaded.map((review) => review.id)]);
  const fresh = incoming.filter((review) => {
    if (seen.has(review.id)) return false;
    // Adding as we go guards a page that repeats a row within ITSELF, as well
    // as against the rows already on screen.
    seen.add(review.id);
    return true;
  });
  // Same array back when a page added nothing, so a React state setter given
  // this result does not re-render for a no-op.
  return fresh.length === 0 ? loaded : [...loaded, ...fresh];
}

/** What the pager renders, given how many reviews are on screen and how many
 * the store says exist. */
export interface ReviewPagerState {
  /** Whether there is anything left to fetch. */
  hasMore: boolean;
  /** How many the next request would bring — never more than are left. */
  nextCount: number;
  /** "Mostrando 10 de 34 reseñas." — or `null` when the whole list is on
   * screen and saying so would be noise. */
  statusLabel: string | null;
  /** The button's own text, `null` when there is no button. */
  buttonLabel: string | null;
}

/**
 * The pager's whole decision, as a pure function — which is the only reason it
 * is testable at all in an app with no DOM test runner.
 *
 * Three things it must never get wrong:
 *
 * 1. **A button that fetches nothing.** `shown >= total` means the list is
 *    complete; offering "ver más" there sends a request that comes back empty
 *    and leaves the shopper pressing a dead control.
 * 2. **A promise of more than exists.** With 34 reviews and 30 shown, the
 *    button says "ver 4 reseñas más", not 10.
 * 3. **Counting past the total.** `total` is the store's count of PUBLISHED
 *    reviews and `shown` is what this browser has; a review hidden by the
 *    merchant between the two can legitimately make `shown` exceed `total`.
 *    The `Math.max(0, …)` is what keeps that from becoming a negative
 *    `remaining` — a button offering "ver -1 reseñas más" under the line
 *    "mostrando 11 de 10".
 *
 * `exhausted` is the caller saying it has seen a page come back with no rows
 * at all, and it OVERRIDES the arithmetic. The count and the list are two
 * different reads: a review hidden between them leaves a `total` that promises
 * a row no offset will ever return, and without this the shopper is left
 * pressing a button that does nothing while the number above it never moves.
 * The list is the thing they are actually reading, so the list wins.
 */
export function reviewPagerState(
  shown: number,
  total: number,
  pageSize: number,
  exhausted = false,
): ReviewPagerState {
  const remaining = exhausted ? 0 : Math.max(0, total - shown);
  // Never 0: a `pageSize` of zero would make `nextCount` 0 and leave a button
  // that says "ver 0 reseñas más" and fetches nothing, forever.
  const size = Math.max(1, pageSize);
  const nextCount = Math.min(size, remaining);

  if (remaining === 0) {
    return {
      hasMore: false,
      nextCount: 0,
      // Said once the shopper has actually paged — a product whose three
      // reviews all fit on the first screen needs no running commentary. Also
      // said whenever `exhausted` ended the paging, even if only one screenful
      // is on show: the shopper pressed a button, and a control that answers
      // by silently deleting itself (along with the "mostrando 10 de 34" line
      // above it) reads as the page breaking under their hands.
      statusLabel: shown > size || exhausted ? `Mostrando las ${reviewCountLabel(shown)}.` : null,
      buttonLabel: null,
    };
  }

  return {
    hasMore: true,
    nextCount,
    statusLabel: `Mostrando ${shown} de ${reviewCountLabel(total)}.`,
    buttonLabel: `Ver ${reviewCountLabel(nextCount)} más`,
  };
}

/** What the shopper is told when one more page could not be fetched. Their
 * reviews are still on screen, so this is a retry prompt and not an error
 * page. */
export const REVIEW_PAGE_ERROR = 'No pudimos cargar más reseñas. Intenta de nuevo.';

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
