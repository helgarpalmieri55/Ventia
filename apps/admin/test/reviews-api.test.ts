import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../lib/api';
import {
  REPLY_MAX,
  STATUS_FILTERS,
  deleteReviewReply,
  listReviews,
  replyError,
  replyToReview,
  reviewErrorMessage,
  reviewExcerpt,
  reviewerLabel,
  setReviewStatus,
  starsLabel,
  statusTone,
  type AdminReview,
} from '../lib/reviews-api';

/**
 * The Reseñas screen's logic. Two things are being pinned down here: the exact
 * request bodies (the merchant must never be able to send a rating or a body —
 * editing a shopper's words would make every review in the store worthless),
 * and the copy/derivation the table renders.
 */

function review(overrides: Partial<AdminReview> = {}): AdminReview {
  return {
    id: 'rev-1',
    rating: 4,
    title: null,
    bodyMd: '',
    status: 'published',
    replyMd: null,
    repliedAt: null,
    createdAt: '2026-05-04T15:00:00.000Z',
    orderId: 'ord-1',
    product: { id: 'p1', name: 'Camisa', slug: 'camisa' },
    author: { name: null, email: 'ana@example.com' },
    ...overrides,
  };
}

function stubFetch(body: unknown, status = 200) {
  // A NEW Response per call: a `Response` body can only be read once, so a
  // single shared instance makes the second call in a test fail with "Body is
  // unusable" rather than whatever it was actually asserting.
  const impl = vi
    .fn()
    .mockImplementation(async () =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
    );
  vi.stubGlobal('fetch', impl);
  return impl;
}

describe('listReviews', () => {
  it('sends `status` only when the merchant picked one', async () => {
    const impl = stubFetch({ items: [], total: 0, page: 1, pageSize: 20 });

    await listReviews('all', 1);
    expect(impl.mock.calls[0][0]).toBe('/api/v1/admin/reviews?page=1&pageSize=20');

    await listReviews('hidden', 2);
    expect(impl.mock.calls[1][0]).toBe('/api/v1/admin/reviews?page=2&pageSize=20&status=hidden');

    vi.unstubAllGlobals();
  });

  it('offers exactly three filters, defaulting the screen to all of them', () => {
    // A screen that hid hidden reviews by default would make an
    // already-hidden review very hard to find again.
    expect(STATUS_FILTERS).toEqual(['all', 'published', 'hidden']);
  });
});

describe('the merchant can only moderate, never edit', () => {
  it('sends nothing but a status when hiding', async () => {
    const impl = stubFetch(review({ status: 'hidden' }));

    await setReviewStatus('rev-1', 'hidden');

    const [url, init] = impl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/admin/reviews/rev-1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({ status: 'hidden' });
    vi.unstubAllGlobals();
  });

  it('sends nothing but a trimmed reply when replying', async () => {
    const impl = stubFetch(review({ replyMd: 'Gracias' }));

    await replyToReview('rev-1', '  Gracias  ');

    const [, init] = impl.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ replyMd: 'Gracias' });
    expect(body).not.toHaveProperty('rating');
    expect(body).not.toHaveProperty('bodyMd');
    vi.unstubAllGlobals();
  });

  it('deletes a reply with an explicit null, not an empty string', async () => {
    // The API reads an ABSENT replyMd as "leave it alone" and `null` as
    // "delete it"; `''` would just be a validation error.
    const impl = stubFetch(review());

    await deleteReviewReply('rev-1');

    const [, init] = impl.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ replyMd: null });
    vi.unstubAllGlobals();
  });
});

describe('replyError', () => {
  it('refuses an empty reply — deleting one is its own button', () => {
    expect(replyError('')).toBe('Escribe tu respuesta.');
    expect(replyError('    ')).toBe('Escribe tu respuesta.');
  });

  it('accepts a reply at the limit and refuses one past it', () => {
    expect(replyError('x'.repeat(REPLY_MAX))).toBeNull();
    expect(replyError('x'.repeat(REPLY_MAX + 1))).toContain('4000');
  });
});

describe('starsLabel', () => {
  it('draws filled and empty stars to five, always', () => {
    expect(starsLabel(5)).toBe('★★★★★');
    expect(starsLabel(1)).toBe('★☆☆☆☆');
    expect(starsLabel(3)).toBe('★★★☆☆');
  });

  it('clamps a value the API should never send rather than rendering garbage', () => {
    expect(starsLabel(0)).toBe('☆☆☆☆☆');
    expect(starsLabel(9)).toBe('★★★★★');
    expect(starsLabel(-2)).toBe('☆☆☆☆☆');
  });
});

describe('statusTone', () => {
  it('does not colour a hidden review as an error — the merchant chose it', () => {
    expect(statusTone('published')).toBe('default');
    expect(statusTone('hidden')).toBe('secondary');
  });
});

describe('reviewerLabel', () => {
  it('prefers the name and falls back to the address the merchant already has', () => {
    expect(reviewerLabel({ name: 'Ana Gómez', email: 'ana@example.com' })).toBe('Ana Gómez');
    expect(reviewerLabel({ name: '  ', email: 'ana@example.com' })).toBe('ana@example.com');
    expect(reviewerLabel({ name: null, email: 'ana@example.com' })).toBe('ana@example.com');
  });
});

describe('reviewExcerpt', () => {
  it('prefers the title, then the body', () => {
    expect(reviewExcerpt(review({ title: 'Quedó perfecta', bodyMd: 'Llegó rápido' }))).toBe('Quedó perfecta');
    expect(reviewExcerpt(review({ bodyMd: 'Llegó rápido' }))).toBe('Llegó rápido');
  });

  it('says so instead of rendering an empty cell for a rating-only review', () => {
    // A rating with no words is a normal review, not a loading bug.
    expect(reviewExcerpt(review())).toBe('Sin texto');
  });

  it('truncates on a word boundary', () => {
    const long = review({ bodyMd: 'palabra '.repeat(40) });
    const excerpt = reviewExcerpt(long, 20);
    expect(excerpt.endsWith('…')).toBe(true);
    expect(excerpt.length).toBeLessThanOrEqual(21);
    expect(excerpt).not.toContain('palab…');
  });
});

describe('reviewErrorMessage', () => {
  it('has copy for the code this feature introduced', () => {
    // The API answers 404 for "deleted" and for "belongs to another store"
    // alike, so this sentence has to work for both.
    expect(reviewErrorMessage(new ApiError(404, 'REVIEW_NOT_FOUND'))).toContain('ya no existe');
  });

  it('delegates every shared code to the shared copy', () => {
    expect(reviewErrorMessage(new ApiError(403, 'FORBIDDEN_ROLE'))).toBe('No tienes permisos para esta acción.');
  });

  it('does not leak a raw exception at the merchant', () => {
    expect(reviewErrorMessage(new TypeError('boom'))).toBe('Ocurrió un error inesperado. Intenta de nuevo.');
  });
});
