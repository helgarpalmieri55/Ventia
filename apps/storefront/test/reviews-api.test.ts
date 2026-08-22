import { describe, expect, it, vi } from 'vitest';
import { AccountApiError } from '../lib/account-api';
import {
  BODY_MAX,
  TITLE_MAX,
  composerCopy,
  distributionRows,
  fetchProductReviews,
  fetchReviewEligibility,
  formatAverage,
  formatReviewDate,
  reviewCountLabel,
  reviewErrorMessage,
  reviewFormError,
  starFillPercents,
  submitReview,
  type EligibilityResult,
  type OwnReview,
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
