import { z } from 'zod';

/**
 * Product reviews: what a shopper may send, what a merchant may send back, and
 * the one piece of arithmetic both the storefront and the admin have to agree
 * on.
 *
 * The model's own doc comment (`Review` in schema.prisma) carries the design
 * decision these schemas serve: a review requires a real purchase, and that
 * requirement REPLACES moderation. Nothing here has a `pending` state, an
 * `approve` action, or a way for the merchant to alter a shopper's words —
 * adding any of them would quietly turn "published unless hidden" back into
 * "invisible until someone gets round to it", which is the failure the whole
 * design exists to avoid.
 */

/** The only ratings that exist. A star bar, an average and a distribution all
 * key off this, so it is one list rather than three. */
export const RATING_VALUES = [1, 2, 3, 4, 5] as const;
export type RatingValue = (typeof RATING_VALUES)[number];

/** A headline is optional and short — it is a phrase ("Quedó perfecta"), not a
 * second body. */
export const REVIEW_TITLE_MAX = 120;

/**
 * Body length cap.
 *
 * Generous on purpose: the reviews worth having are the long ones, and a
 * shopper who has typed four paragraphs into a phone and is told "máximo 500
 * caracteres" simply abandons. The cap exists only so a single row cannot be
 * used to store a novel.
 */
export const REVIEW_BODY_MAX = 4000;

/** The merchant's answer. Same ceiling as a body: a reply to a long complaint
 * is often longer than the complaint. */
export const REVIEW_REPLY_MAX = 4000;

/**
 * What a shopper posts.
 *
 * There is deliberately NO `orderId` here. The order that entitles someone to
 * review is resolved server-side from their session (`ReviewsService`), and
 * accepting one from the client would hand an attacker the exact field the
 * purchase requirement rests on — "review any product by naming any order id"
 * is not a hole this design survives, since the purchase requirement is doing
 * the work a moderation queue would otherwise do.
 */
export const reviewCreateSchema = z.object({
  productId: z.string().uuid(),
  /** `z.number().int()` and not a coerced string: a rating arriving as `"5"`
   * from a form that forgot to parse it should be a 400, not a silent cast
   * that ends up in an average. */
  rating: z
    .number()
    .int()
    .min(1)
    .max(5),
  title: z.string().trim().min(1).max(REVIEW_TITLE_MAX).optional(),
  /** Optional, defaulting to empty. A rating with no text is a real review and
   * the most common one people will leave from a phone; demanding prose would
   * trade most of the volume for a little more depth. */
  bodyMd: z.string().trim().max(REVIEW_BODY_MAX).default(''),
});

export type ReviewCreateInput = z.infer<typeof reviewCreateSchema>;

export const REVIEW_STATUSES = ['published', 'hidden'] as const;
export type ReviewStatusValue = (typeof REVIEW_STATUSES)[number];

/**
 * What the merchant may change about a review: whether it is visible, and
 * their own reply. Never the rating, the title or the body — a merchant who
 * could edit a shopper's words would make every review on the store worthless,
 * including the good ones.
 *
 * `replyMd: null` DELETES the reply (and clears `repliedAt`). That is a
 * deliberate capability, not an accident of nullability: a reply is the
 * merchant's own public speech, written in a hurry at the moment they were
 * most annoyed, and a platform that made it permanent would be inviting a
 * small business to leave a bad-tempered paragraph under a bad review forever.
 * The shopper's half is immutable; the merchant's half is theirs to withdraw.
 *
 * At least one field must be present, so an empty PATCH is a 400 rather than a
 * write that silently does nothing and answers 200.
 */
export const reviewModerationSchema = z
  .object({
    status: z.enum(REVIEW_STATUSES).optional(),
    replyMd: z.string().trim().min(1).max(REVIEW_REPLY_MAX).nullable().optional(),
  })
  .refine((value) => value.status !== undefined || value.replyMd !== undefined, {
    message: 'Nada que actualizar',
  });

export type ReviewModerationInput = z.infer<typeof reviewModerationSchema>;

/** One rating and how many reviews carry it — the shape a `GROUP BY rating`
 * comes back as, and the only input {@link summarizeRatings} needs. */
export interface RatingBucket {
  rating: number;
  count: number;
}

export interface RatingSummary {
  /**
   * One decimal, or `null` when there is nothing to average.
   *
   * `null` and not `0`: a product with no reviews has no rating, and a `0`
   * would render as the worst score on the page — the opposite of "we don't
   * know yet", and a lie told about every new product in the store.
   */
  average: number | null;
  count: number;
  /** How many reviews at each star, `'1'`..`'5'`, always all five keys so the
   * bar chart has no holes to special-case. */
  distribution: Record<`${RatingValue}`, number>;
}

function emptyDistribution(): Record<`${RatingValue}`, number> {
  return { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
}

/**
 * The number a shopper actually acts on.
 *
 * ## Computed from integers, rounded once
 *
 * `Math.round((total * 10) / count) / 10` — the sum and the count are both
 * integers, so there is exactly ONE floating-point division and exactly one
 * rounding step. Averaging first and multiplying afterwards accumulates error
 * and can land a genuine 4.45 on either side of 4.4/4.5 depending on the order
 * the rows came back in, which is not a property anyone wants in a number
 * printed next to a price.
 *
 * Halves round AWAY from zero (4.25 → 4.3), which is what a shopper checking
 * the arithmetic by hand expects. Banker's rounding would send 4.25 to 4.2 and
 * 4.35 to 4.4 and look like a bug to the one merchant who checks.
 *
 * ## 5,0 means every single review is a 5
 *
 * Twenty 5s and one 4 average 4.952, which rounds to 5.0 — a perfect score
 * printed over a review that is visibly not perfect. A shopper reads "5,0" as
 * "nobody has ever complained", so the display is clamped to 4.9 unless every
 * rating really is a 5 (and, symmetrically, to 1.1 unless every rating is a 1).
 * The clamp only ever moves the number one tenth, and only ever away from a
 * claim the reviews do not support.
 *
 * ## Hidden reviews are not this function's problem
 *
 * It averages exactly the buckets it is handed. The caller decides which rows
 * those are, and every caller in this codebase passes PUBLISHED ones only —
 * see `ReviewsService.summaryFor` for why.
 */
export function summarizeRatings(buckets: Iterable<RatingBucket>): RatingSummary {
  const distribution = emptyDistribution();
  let count = 0;
  let total = 0;

  for (const bucket of buckets) {
    // A rating outside 1..5 cannot exist — a CHECK constraint in the migration
    // says so — but this function is also handed data by tests and by clients
    // of `@ventia/core`, and one impossible row must not be able to poison a
    // whole store's average. Skipped rather than thrown on: a summary is a
    // read on a hot path, and refusing to render a product page over one bad
    // row is a worse outcome than an average computed from the sane ones.
    if (!Number.isInteger(bucket.rating) || bucket.rating < 1 || bucket.rating > 5) continue;
    const n = Number.isFinite(bucket.count) ? Math.max(0, Math.trunc(bucket.count)) : 0;
    if (n === 0) continue;
    distribution[String(bucket.rating) as `${RatingValue}`] += n;
    count += n;
    total += bucket.rating * n;
  }

  if (count === 0) return { average: null, count: 0, distribution };

  let average = Math.round((total * 10) / count) / 10;
  if (average >= 5 && distribution['5'] !== count) average = 4.9;
  if (average <= 1 && distribution['1'] !== count) average = 1.1;

  return { average, count, distribution };
}

/** What replaces a name nobody gave. Says the thing that matters about the
 * author — that the purchase is real — rather than "Anónimo", which reads as
 * "unverified" and undersells the one property this whole feature is built on. */
export const ANONYMOUS_REVIEWER_LABEL = 'Cliente verificado';

/**
 * How a reviewer is named in public.
 *
 * The shopper gave their name to buy something, not to have it published under
 * a product with their opinion attached, so the full name is never printed:
 * the first token in full plus the initial of the LAST token ("Ana Gómez Ruiz"
 * → "Ana R."). The last token is used because in a Colombian full name the
 * trailing tokens are apellidos, whereas an initial taken from the second
 * token would often just abbreviate a segundo nombre and tell the reader
 * nothing.
 *
 * This is an initial, deliberately, and not a claim about which apellido is
 * the primer apellido — "Ana María Gómez Ruiz" is one person's name written
 * four different ways depending on who is asking, and no heuristic parses it
 * reliably. An initial is the honest amount of precision.
 *
 * Never falls back to the email address. An address is the single most
 * identifying thing on the account and would be published next to a purchase
 * history — see {@link ANONYMOUS_REVIEWER_LABEL}.
 */
export function reviewAuthorLabel(name: string | null | undefined): string {
  const tokens = (name ?? '').trim().split(/\s+/).filter((token) => token.length > 0);
  if (tokens.length === 0) return ANONYMOUS_REVIEWER_LABEL;
  if (tokens.length === 1) return tokens[0];
  const last = tokens[tokens.length - 1];
  return `${tokens[0]} ${last.slice(0, 1).toUpperCase()}.`;
}
