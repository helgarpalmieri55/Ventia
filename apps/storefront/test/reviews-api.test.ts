import { describe, expect, it, vi } from 'vitest';
import { AccountApiError } from '../lib/account-api';
import {
  BODY_MAX,
  REVIEWS_PAGE_SIZE,
  REVIEW_PAGE_ERROR,
  TITLE_MAX,
  composerCopy,
  distributionRows,
  fetchProductReviews,
  fetchReviewEligibility,
  fetchReviewsPage,
  formatAverage,
  formatReviewDate,
  mergeReviewPages,
  productSlugFromPath,
  reviewCountLabel,
  reviewErrorMessage,
  reviewFormError,
  reviewPagerState,
  starFillPercents,
  submitReview,
  type EligibilityResult,
  type OwnReview,
  type PublicReview,
  type RatingSummary,
} from '../lib/reviews-api';

/**
 * This app has no DOM test runner, so the reviews feature's testable logic
 * lives in `lib/reviews-api.ts` and is exercised here: the two request shapes,
 * and every display decision that could quietly render something false — a
 * rating of 0 on a product with no reviews, a star row that disagrees with the
 * number printed beside it, a percentage bar computed from a division by zero.
 */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function summary(overrides: Partial<RatingSummary> = {}): RatingSummary {
  return { average: null, count: 0, distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }, ...overrides };
}

function ownReview(overrides: Partial<OwnReview> = {}): OwnReview {
  return {
    id: 'r1',
    rating: 5,
    title: null,
    bodyMd: '',
    status: 'published',
    createdAt: '2026-05-04T15:00:00.000Z',
    replyMd: null,
    repliedAt: null,
    ...overrides,
  };
}

describe('fetchProductReviews', () => {
  it('asks the API for this tenant product, by slug', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ summary: summary(), reviews: [] }));
    process.env.API_INTERNAL_URL = 'http://api.internal:4000';

    await fetchProductReviews('tienda.ventia.localhost', 'camisa azul', fetchImpl as unknown as typeof fetch);

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://api.internal:4000/v1/storefront/products/camisa%20azul/reviews');
    expect((init.headers as Record<string, string>)['x-tenant-domain']).toBe('tienda.ventia.localhost');
  });

  it('degrades a failing reviews fetch to null instead of taking the product page down', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('boom', { status: 503 }));
    await expect(
      fetchProductReviews('tienda.ventia.localhost', 'camisa', fetchImpl as unknown as typeof fetch),
    ).resolves.toBeNull();
  });
});

describe('fetchReviewEligibility', () => {
  it('reads "not signed in" out of a 401 rather than treating it as a failure', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));
    await expect(fetchReviewEligibility('p1', fetchImpl as unknown as typeof fetch)).resolves.toBeNull();
  });

  it('sends the cookie and the product id', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ eligibility: 'can_review', review: null }));

    const result = await fetchReviewEligibility('p1', fetchImpl as unknown as typeof fetch);

    expect(result).toEqual({ eligibility: 'can_review', review: null });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/account/reviews?productId=p1');
    // Without this the HttpOnly session never reaches the proxy and every
    // signed-in shopper looks signed out.
    expect(init.credentials).toBe('include');
  });

  it('still throws for a real fault — a 500 must not render as "sign in"', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: 'BOOM' }, 500));
    await expect(fetchReviewEligibility('p1', fetchImpl as unknown as typeof fetch)).rejects.toBeInstanceOf(
      AccountApiError,
    );
  });
});

describe('submitReview', () => {
  it('omits a blank title and body rather than sending empty strings', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ review: ownReview() }, 201));

    await submitReview({ productId: 'p1', rating: 5, title: '', bodyMd: '' }, fetchImpl as unknown as typeof fetch);

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    // The API's schema has both optional with min(1): `''` is a 400, an absent
    // key is the intended "didn't say".
    expect(JSON.parse(init.body as string)).toEqual({ productId: 'p1', rating: 5 });
  });

  it('never sends an orderId, even if a caller passes one', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ review: ownReview() }, 201));

    await submitReview(
      { productId: 'p1', rating: 4, orderId: 'o1' } as unknown as { productId: string; rating: number },
      fetchImpl as unknown as typeof fetch,
    );

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).not.toHaveProperty('orderId');
  });

  it('surfaces the API error CODE so the form can say the true thing', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: 'PURCHASE_REQUIRED' }, 403));

    await expect(
      submitReview({ productId: 'p1', rating: 5 }, fetchImpl as unknown as typeof fetch),
    ).rejects.toMatchObject({ code: 'PURCHASE_REQUIRED', status: 403 });
  });
});

describe('formatAverage', () => {
  it('uses the Colombian decimal comma and always one decimal', () => {
    expect(formatAverage(4.5)).toBe('4,5');
    expect(formatAverage(5)).toBe('5,0');
    expect(formatAverage(3.25)).toBe('3,3');
  });

  it('returns null for "no rating yet" so a caller cannot print a zero', () => {
    expect(formatAverage(null)).toBeNull();
    expect(formatAverage(Number.NaN)).toBeNull();
  });
});

describe('reviewCountLabel', () => {
  it('gets the singular right', () => {
    expect(reviewCountLabel(1)).toBe('1 reseña');
    expect(reviewCountLabel(0)).toBe('0 reseñas');
    expect(reviewCountLabel(12)).toBe('12 reseñas');
  });
});

describe('starFillPercents', () => {
  it('fills to the true average, not to the nearest half', () => {
    // A 4.3 drawn as four and a half stars contradicts the "4,3" printed
    // beside it.
    expect(starFillPercents(4.3)).toEqual([100, 100, 100, 100, 30]);
    expect(starFillPercents(5)).toEqual([100, 100, 100, 100, 100]);
    expect(starFillPercents(1)).toEqual([100, 0, 0, 0, 0]);
  });

  it('draws an unrated product as EMPTY, never as full', () => {
    expect(starFillPercents(null)).toEqual([0, 0, 0, 0, 0]);
  });

  it('clamps rather than emitting a negative or >100 width', () => {
    expect(starFillPercents(0)).toEqual([0, 0, 0, 0, 0]);
    expect(starFillPercents(9)).toEqual([100, 100, 100, 100, 100]);
  });
});

describe('distributionRows', () => {
  it('is ordered 5 to 1 and always five rows', () => {
    const rows = distributionRows(summary({ count: 4, distribution: { 1: 1, 2: 0, 3: 0, 4: 0, 5: 3 } }));
    expect(rows.map((r) => r.rating)).toEqual([5, 4, 3, 2, 1]);
    expect(rows[0]).toEqual({ rating: 5, count: 3, percent: 75 });
    expect(rows[4]).toEqual({ rating: 1, count: 1, percent: 25 });
  });

  it('never divides by zero — a NaN width is silently dropped and the bars look FULL', () => {
    const rows = distributionRows(summary());
    expect(rows.every((r) => r.percent === 0)).toBe(true);
    expect(rows.every((r) => Number.isFinite(r.percent))).toBe(true);
  });
});

describe('formatReviewDate', () => {
  it('formats in Bogotá, so an evening review is not dated a day later', () => {
    // 21:30 on the 3rd in Bogotá is 02:30Z on the 4th.
    expect(formatReviewDate('2026-05-04T02:30:00.000Z')).toContain('3 de mayo');
  });

  it('returns the raw value rather than "Invalid Date"', () => {
    expect(formatReviewDate('mañana')).toBe('mañana');
  });
});

describe('composerCopy', () => {
  function copy(result: EligibilityResult | null) {
    return composerCopy(result);
  }

  it('sends a signed-out visitor to sign in, and shows no form', () => {
    const result = copy(null);
    expect(result.showForm).toBe(false);
    expect(result.action).toEqual({ label: 'Entrar', href: '/cuenta/entrar' });
    expect(result.message).toContain('Inicia sesión');
  });

  it('shows the form ONLY to someone who bought it and has not reviewed it', () => {
    expect(copy({ eligibility: 'can_review', review: null }).showForm).toBe(true);
    expect(copy({ eligibility: 'not_purchased', review: null }).showForm).toBe(false);
    expect(copy({ eligibility: 'email_not_verified', review: null }).showForm).toBe(false);
    expect(copy({ eligibility: 'already_reviewed', review: ownReview() }).showForm).toBe(false);
  });

  it('explains the purchase requirement instead of hiding the section', () => {
    // It is the reason the reviews above it are worth reading, so it is said
    // out loud.
    expect(copy({ eligibility: 'not_purchased', review: null }).message).toContain('compraron');
  });

  it('points an unconfirmed shopper at the one thing that will fix it', () => {
    const result = copy({ eligibility: 'email_not_verified', review: null });
    expect(result.message).toContain('Confirma tu correo');
    expect(result.action).toEqual({ label: 'Ir a mi cuenta', href: '/cuenta' });
  });

  it('tells the author when their own review is not visible', () => {
    // Showing a hidden review back to its author as though it were live is
    // simply a lie to the one person who can check.
    const hidden = copy({ eligibility: 'already_reviewed', review: ownReview({ status: 'hidden' }) });
    expect(hidden.message).toContain('no está visible');

    const live = copy({ eligibility: 'already_reviewed', review: ownReview({ status: 'published' }) });
    expect(live.message).not.toContain('no está visible');
  });
});

describe('reviewFormError', () => {
  it('asks for a rating before anything else', () => {
    expect(reviewFormError({ rating: null, title: '', bodyMd: '' })).toContain('estrellas');
    expect(reviewFormError({ rating: 0, title: '', bodyMd: '' })).toContain('estrellas');
    expect(reviewFormError({ rating: 6, title: '', bodyMd: '' })).toContain('estrellas');
  });

  it('accepts a rating with no words at all', () => {
    expect(reviewFormError({ rating: 5, title: '', bodyMd: '' })).toBeNull();
  });

  it('bounds the title and body the same way the API does', () => {
    expect(reviewFormError({ rating: 5, title: 'x'.repeat(TITLE_MAX), bodyMd: '' })).toBeNull();
    expect(reviewFormError({ rating: 5, title: 'x'.repeat(TITLE_MAX + 1), bodyMd: '' })).toContain('título');
    expect(reviewFormError({ rating: 5, title: '', bodyMd: 'x'.repeat(BODY_MAX + 1) })).toContain('reseña');
  });
});

describe('reviewErrorMessage', () => {
  it('translates the codes this form can actually provoke', () => {
    expect(reviewErrorMessage(new AccountApiError(403, 'PURCHASE_REQUIRED'))).toContain('compraron');
    expect(reviewErrorMessage(new AccountApiError(403, 'EMAIL_NOT_VERIFIED'))).toContain('Confirma tu correo');
    expect(reviewErrorMessage(new AccountApiError(409, 'REVIEW_ALREADY_EXISTS'))).toContain('Ya habías escrito');
  });

  it('falls back to a sentence a shopper can act on', () => {
    // "VALIDATION_FAILED" tells a shopper nothing.
    expect(reviewErrorMessage(new AccountApiError(400, 'VALIDATION_FAILED'))).toBe(
      'No pudimos guardar tu reseña. Intenta de nuevo.',
    );
    expect(reviewErrorMessage(new Error('offline'))).toBe('No pudimos guardar tu reseña. Intenta de nuevo.');
  });
});

// ---- the pager ------------------------------------------------------------

function publicReview(id: string): PublicReview {
  return {
    id,
    rating: 5,
    title: null,
    bodyMd: `Reseña ${id}`,
    authorLabel: 'Ana P.',
    createdAt: '2025-03-01T15:00:00.000Z',
    replyMd: null,
    repliedAt: null,
  };
}

describe('REVIEWS_PAGE_SIZE', () => {
  it('matches the API default, so "ver 10 reseñas más" is a promise the request keeps', () => {
    // `DEFAULT_PAGE_SIZE` in
    // services/api/src/reviews/storefront-reviews.controller.ts.
    expect(REVIEWS_PAGE_SIZE).toBe(10);
  });
});

describe('productSlugFromPath', () => {
  it('reads the slug the reviews endpoint is keyed by off the product URL', () => {
    expect(productSlugFromPath('/productos/camiseta-blanca')).toBe('camiseta-blanca');
  });

  it('tolerates a trailing slash', () => {
    expect(productSlugFromPath('/productos/camiseta-blanca/')).toBe('camiseta-blanca');
  });

  it('decodes the segment, so it is not escaped twice on the way back out', () => {
    expect(productSlugFromPath('/productos/caf%C3%A9')).toBe('café');
  });

  it('gives up — rather than guessing — on any route that is not a product page', () => {
    // The pager renders nothing for `null`, which is exactly the behaviour the
    // reviews section had before it existed.
    expect(productSlugFromPath('/')).toBeNull();
    expect(productSlugFromPath('/productos')).toBeNull();
    expect(productSlugFromPath('/productos/')).toBeNull();
    expect(productSlugFromPath('/categorias/ropa')).toBeNull();
    expect(productSlugFromPath('/productos/camiseta/opiniones')).toBeNull();
    expect(productSlugFromPath('/tienda/productos/camiseta')).toBeNull();
  });

  it('gives up on a malformed escape instead of throwing inside a render', () => {
    expect(productSlugFromPath('/productos/%zz')).toBeNull();
  });
});

describe('reviewPagerState', () => {
  it('offers the next full page when there is more than one left', () => {
    const state = reviewPagerState(10, 34, 10);
    expect(state.hasMore).toBe(true);
    expect(state.nextCount).toBe(10);
    expect(state.statusLabel).toBe('Mostrando 10 de 34 reseñas.');
    expect(state.buttonLabel).toBe('Ver 10 reseñas más');
  });

  it('promises only what is actually left, never a full page that is not there', () => {
    const state = reviewPagerState(30, 34, 10);
    expect(state.nextCount).toBe(4);
    expect(state.buttonLabel).toBe('Ver 4 reseñas más');
  });

  it('says "1 reseña" when exactly one is left', () => {
    expect(reviewPagerState(33, 34, 10).buttonLabel).toBe('Ver 1 reseña más');
  });

  it('draws no button once the whole list is on screen — a control that fetches nothing is broken', () => {
    const state = reviewPagerState(34, 34, 10);
    expect(state.hasMore).toBe(false);
    expect(state.nextCount).toBe(0);
    expect(state.buttonLabel).toBeNull();
    expect(state.statusLabel).toBe('Mostrando las 34 reseñas.');
  });

  it('says nothing at all about a list that always fitted', () => {
    // Three reviews on a product with three reviews: a running commentary
    // under a list a shopper can count is noise, not information.
    const state = reviewPagerState(3, 3, 10);
    expect(state.hasMore).toBe(false);
    expect(state.statusLabel).toBeNull();
    expect(state.buttonLabel).toBeNull();
  });

  it('never counts past the total, even when the merchant hid one mid-read', () => {
    // `total` is the store's published count and `shown` is what this browser
    // holds; a review hidden between the two makes shown > total, and
    // "mostrando 11 de 10" reads as a bug in the store.
    const state = reviewPagerState(11, 10, 10);
    expect(state.hasMore).toBe(false);
    expect(state.nextCount).toBe(0);
    expect(state.statusLabel).toBe('Mostrando las 11 reseñas.');
  });

  it('survives a page size of zero rather than offering "ver 0 reseñas más" forever', () => {
    const state = reviewPagerState(0, 5, 0);
    expect(state.nextCount).toBe(1);
    expect(state.buttonLabel).toBe('Ver 1 reseña más');
  });
});

describe('mergeReviewPages', () => {
  it('appends a fresh page in the order it arrived', () => {
    const merged = mergeReviewPages([publicReview('a')], [publicReview('b'), publicReview('c')]);
    expect(merged.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('drops a review the offset page repeated, so nobody is quoted twice', () => {
    // Paging by OFFSET over a newest-first list: one review posted since the
    // page loaded pushes every later row down one, and page 2 legitimately
    // starts with the last row of page 1.
    const merged = mergeReviewPages([publicReview('a'), publicReview('b')], [publicReview('b'), publicReview('c')]);
    expect(merged.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('also excludes the ids the SERVER already rendered, which it was never handed', () => {
    const merged = mergeReviewPages([], [publicReview('server-1'), publicReview('nueva')], ['server-1']);
    expect(merged.map((r) => r.id)).toEqual(['nueva']);
  });

  it('dedupes within one page as well as against the previous ones', () => {
    const merged = mergeReviewPages([], [publicReview('a'), publicReview('a')]);
    expect(merged.map((r) => r.id)).toEqual(['a']);
  });

  it('returns the SAME array when a page adds nothing, so React does not re-render for a no-op', () => {
    const loaded = [publicReview('a')];
    expect(mergeReviewPages(loaded, [publicReview('a')])).toBe(loaded);
  });

  it('does not mutate what it was given', () => {
    const loaded = [publicReview('a')];
    mergeReviewPages(loaded, [publicReview('b')]);
    expect(loaded).toHaveLength(1);
  });
});

describe('fetchReviewsPage', () => {
  it('asks the same-origin proxy for the named page, at the size the button promised', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ summary: summary(), reviews: [publicReview('b')], page: 2, pageSize: 10 }),
    );

    const result = await fetchReviewsPage('camiseta-blanca', 2, 10, fetchImpl as unknown as typeof fetch);

    expect(result.reviews.map((r) => r.id)).toEqual(['b']);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    // `/api/reviews/*`, NOT the API directly: `API_INTERNAL_URL` is an
    // internal hostname the browser cannot reach.
    expect(url).toBe('/api/reviews/camiseta-blanca?page=2&pageSize=10');
    expect(init.method).toBe('GET');
  });

  it('escapes the slug rather than pasting it into the path', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ summary: summary(), reviews: [], page: 2, pageSize: 10 }));
    await fetchReviewsPage('café/au', 2, 10, fetchImpl as unknown as typeof fetch);
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe(
      '/api/reviews/caf%C3%A9%2Fau?page=2&pageSize=10',
    );
  });

  it('sends no credentials: published reviews are read by people who never signed in', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ summary: summary(), reviews: [], page: 2, pageSize: 10 }));
    await fetchReviewsPage('camiseta', 2, 10, fetchImpl as unknown as typeof fetch);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.credentials).toBeUndefined();
  });

  it('throws rather than resolving empty, so "no pudimos cargar más" is not read as "no hay más"', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'PRODUCT_NOT_FOUND' }, 404));
    await expect(
      fetchReviewsPage('camiseta', 2, 10, fetchImpl as unknown as typeof fetch),
    ).rejects.toBeInstanceOf(AccountApiError);
  });
});

describe('REVIEW_PAGE_ERROR', () => {
  it('is a retry prompt, not an error page: the reviews already fetched are still on screen', () => {
    expect(REVIEW_PAGE_ERROR).toContain('Intenta de nuevo');
  });
});

describe('reviewPagerState, once a page has come back empty', () => {
  it('stops offering more even though the count still promises some', () => {
    // `summary.count` and the list are two separate reads. A review hidden
    // between them leaves a total that no offset will ever satisfy, and a
    // button that does nothing while the number above it never moves is worse
    // than no button.
    const state = reviewPagerState(10, 34, 10, true);
    expect(state.hasMore).toBe(false);
    expect(state.buttonLabel).toBeNull();
  });

  it('still says what is on screen, so the list does not just stop without a word', () => {
    expect(reviewPagerState(20, 34, 10, true).statusLabel).toBe('Mostrando las 20 reseñas.');
  });

  it('defaults to trusting the count, since an unexhausted pager has seen no empty page', () => {
    expect(reviewPagerState(10, 34, 10).hasMore).toBe(true);
  });
});

describe('an exhausted pager never answers by vanishing', () => {
  it('replaces the promise with what is actually there, instead of removing the whole block', () => {
    // 10 shown of a claimed 34, and page 2 came back empty. Without this the
    // pager would render nothing at all — the button AND the "mostrando 10 de
    // 34" line would disappear the instant the shopper pressed something.
    const state = reviewPagerState(10, 34, 10, true);
    expect(state.buttonLabel).toBeNull();
    expect(state.statusLabel).toBe('Mostrando las 10 reseñas.');
  });

  it('still says nothing about a short list nobody ever paged', () => {
    expect(reviewPagerState(3, 3, 10).statusLabel).toBeNull();
  });
});
