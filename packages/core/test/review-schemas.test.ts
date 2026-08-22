import { describe, expect, it } from 'vitest';
import {
  ANONYMOUS_REVIEWER_LABEL,
  RATING_VALUES,
  REVIEW_BODY_MAX,
  REVIEW_TITLE_MAX,
  reviewAuthorLabel,
  reviewCreateSchema,
  reviewModerationSchema,
  summarizeRatings,
} from '../src/review-schemas.js';

const PRODUCT_ID = '11111111-2222-4333-8444-555555555555';

describe('reviewCreateSchema', () => {
  it('accepts a rating with no text — the most common review from a phone', () => {
    const parsed = reviewCreateSchema.parse({ productId: PRODUCT_ID, rating: 5 });
    expect(parsed.bodyMd).toBe('');
    expect(parsed.title).toBeUndefined();
  });

  it('rejects ratings outside 1..5, including 0 and 6', () => {
    for (const rating of [0, 6, -1, 2.5]) {
      expect(reviewCreateSchema.safeParse({ productId: PRODUCT_ID, rating }).success).toBe(false);
    }
    for (const rating of RATING_VALUES) {
      expect(reviewCreateSchema.safeParse({ productId: PRODUCT_ID, rating }).success).toBe(true);
    }
  });

  it('does NOT coerce a stringified rating', () => {
    // A form that forgot to parse its own input must fail loudly rather than
    // land a cast value in an average.
    expect(reviewCreateSchema.safeParse({ productId: PRODUCT_ID, rating: '5' }).success).toBe(false);
  });

  it('has no orderId field — the entitling order is never client-supplied', () => {
    const parsed = reviewCreateSchema.parse({
      productId: PRODUCT_ID,
      rating: 4,
      orderId: '99999999-2222-4333-8444-555555555555',
    } as Record<string, unknown>);
    expect(parsed).not.toHaveProperty('orderId');
  });

  it('trims and bounds the title and the body', () => {
    const parsed = reviewCreateSchema.parse({
      productId: PRODUCT_ID,
      rating: 4,
      title: '  Quedó perfecta  ',
      bodyMd: '  Llegó en dos días.  ',
    });
    expect(parsed.title).toBe('Quedó perfecta');
    expect(parsed.bodyMd).toBe('Llegó en dos días.');

    expect(
      reviewCreateSchema.safeParse({ productId: PRODUCT_ID, rating: 4, title: 'x'.repeat(REVIEW_TITLE_MAX + 1) })
        .success,
    ).toBe(false);
    expect(
      reviewCreateSchema.safeParse({ productId: PRODUCT_ID, rating: 4, bodyMd: 'x'.repeat(REVIEW_BODY_MAX + 1) })
        .success,
    ).toBe(false);
  });

  it('rejects a productId that is not a uuid', () => {
    expect(reviewCreateSchema.safeParse({ productId: 'camisa-azul', rating: 4 }).success).toBe(false);
  });
});

describe('reviewModerationSchema', () => {
  it('accepts hiding, unhiding, replying and deleting a reply', () => {
    expect(reviewModerationSchema.parse({ status: 'hidden' })).toEqual({ status: 'hidden' });
    expect(reviewModerationSchema.parse({ status: 'published' })).toEqual({ status: 'published' });
    expect(reviewModerationSchema.parse({ replyMd: '  Gracias  ' }).replyMd).toBe('Gracias');
    // null is the delete, and it must survive parsing as null rather than
    // being dropped as "absent".
    expect(reviewModerationSchema.parse({ replyMd: null }).replyMd).toBeNull();
  });

  it('rejects an empty patch rather than answering 200 to a no-op', () => {
    expect(reviewModerationSchema.safeParse({}).success).toBe(false);
  });

  it('rejects an unknown status and a blank reply', () => {
    expect(reviewModerationSchema.safeParse({ status: 'pending' }).success).toBe(false);
    // A whitespace-only reply is a mis-click, not a deletion — deleting is
    // explicitly `null`.
    expect(reviewModerationSchema.safeParse({ replyMd: '   ' }).success).toBe(false);
  });
});

describe('summarizeRatings', () => {
  it('has no rating at all when there are no reviews', () => {
    const summary = summarizeRatings([]);
    expect(summary.average).toBeNull();
    expect(summary.count).toBe(0);
    expect(summary.distribution).toEqual({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 });
  });

  it('counts every bucket and fills the missing stars with zero', () => {
    const summary = summarizeRatings([
      { rating: 5, count: 3 },
      { rating: 3, count: 1 },
    ]);
    expect(summary.count).toBe(4);
    expect(summary.distribution).toEqual({ 1: 0, 2: 0, 3: 1, 4: 0, 5: 3 });
    // (5+5+5+3)/4 = 4.5
    expect(summary.average).toBe(4.5);
  });

  it('rounds to one decimal, halves away from zero', () => {
    // (4+4+4+5)/4 = 4.25 -> 4.3, not 4.2 (banker's rounding would say 4.2).
    expect(summarizeRatings([{ rating: 4, count: 3 }, { rating: 5, count: 1 }]).average).toBe(4.3);
    // (1+2)/2 = 1.5 exactly.
    expect(summarizeRatings([{ rating: 1, count: 1 }, { rating: 2, count: 1 }]).average).toBe(1.5);
    // 10/3 = 3.333… -> 3.3
    expect(summarizeRatings([{ rating: 3, count: 2 }, { rating: 4, count: 1 }]).average).toBe(3.3);
  });

  it('only shows 5,0 when every single rating is a 5', () => {
    expect(summarizeRatings([{ rating: 5, count: 4 }]).average).toBe(5);
    // 20 fives and one four averages 4.952 — which rounds to 5.0 and would
    // print a perfect score over a review that is visibly not perfect.
    expect(summarizeRatings([{ rating: 5, count: 20 }, { rating: 4, count: 1 }]).average).toBe(4.9);
  });

  it('only shows 1,0 when every single rating is a 1', () => {
    expect(summarizeRatings([{ rating: 1, count: 3 }]).average).toBe(1);
    // 20 ones and one two averages 1.0476 -> 1.0 unclamped.
    expect(summarizeRatings([{ rating: 1, count: 20 }, { rating: 2, count: 1 }]).average).toBe(1.1);
  });

  it('ignores impossible rows instead of poisoning the whole average', () => {
    const summary = summarizeRatings([
      { rating: 5, count: 2 },
      { rating: 9, count: 100 },
      { rating: 0, count: 100 },
      { rating: 4.5, count: 100 },
      { rating: 3, count: -5 },
      { rating: 3, count: Number.NaN },
    ]);
    expect(summary.count).toBe(2);
    expect(summary.average).toBe(5);
  });
});

describe('reviewAuthorLabel', () => {
  it('abbreviates to the first name plus the initial of the last token', () => {
    expect(reviewAuthorLabel('Ana Gómez')).toBe('Ana G.');
    expect(reviewAuthorLabel('Ana María Gómez Ruiz')).toBe('Ana R.');
    expect(reviewAuthorLabel('  ana   gómez  ')).toBe('ana G.');
  });

  it('leaves a single-token name alone', () => {
    expect(reviewAuthorLabel('Ana')).toBe('Ana');
  });

  it('says "cliente verificado" rather than "anónimo" when there is no name', () => {
    expect(reviewAuthorLabel(null)).toBe(ANONYMOUS_REVIEWER_LABEL);
    expect(reviewAuthorLabel(undefined)).toBe(ANONYMOUS_REVIEWER_LABEL);
    expect(reviewAuthorLabel('   ')).toBe(ANONYMOUS_REVIEWER_LABEL);
  });
});
