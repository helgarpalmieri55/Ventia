import { HttpException, Inject, Injectable } from '@nestjs/common';
import { Prisma, tenantDb } from '@ventia/db';
import {
  type RatingSummary,
  type ReviewCreateInput,
  type ReviewModerationInput,
  reviewAuthorLabel,
  summarizeRatings,
} from '@ventia/core';
import { MAILER, type Mailer } from '../mailer/mailer';
import { sendNewReviewEmail } from '../mailer/review-emails';

/**
 * Reviews, on both sides of the counter.
 *
 * ## The purchase check is the whole feature
 *
 * `Review.orderId` is NOT NULL and the model's doc comment explains why: a
 * required purchase does the work a moderation queue would, without leaving a
 * small merchant's real reviews unpublished for the four days between admin
 * logins. Everything in this service exists to make that requirement true in
 * fact rather than on paper — which means the entitling order is resolved HERE,
 * from the session, and never read from the request body. A client-supplied
 * `orderId` would reduce the requirement to "name any order id", and with no
 * moderation queue behind it there is nothing else standing in the way.
 *
 * ## Nothing here can put a review into a pending state
 *
 * There is no `approve`, no `pending`, and no code path that creates a review
 * with a status other than the column default (`published`). The merchant's
 * only lever is hiding one after the fact — which is exactly why `create`
 * emails them: the review is live from the instant it is written, so the
 * window to answer a complaint publicly opens then, not the next time they
 * happen to log in.
 */
@Injectable()
export class ReviewsService {
  // Explicit @Inject: esbuild (vitest's transform) emits no `design:paramtypes`,
  // so Nest cannot infer this from the parameter type — same reason every
  // controller in this module injects its dependencies by token.
  constructor(@Inject(MAILER) private readonly mailer: Mailer) {}

  /**
   * Order states that count as a purchase.
   *
   * NOT simply "an order exists". A COD checkout costs the shopper nothing but
   * a form submission, so if a `PENDING` order entitled its author to review,
   * the purchase requirement would collapse into "fill in the checkout page" —
   * free, repeatable, and available to anyone including a competitor. Since the
   * requirement is what replaces moderation here, that collapse would leave the
   * store with no protection at all.
   *
   * So the bar is evidence that the sale is real: either the money arrived
   * (`paymentStatus: PAID`), or the MERCHANT moved the order out of PENDING,
   * which is them vouching for it — the normal path for cash on delivery, where
   * `paymentStatus` stays `COD` until the courier is paid and no PAID row ever
   * appears.
   */
  private static readonly ACCEPTED_ORDER_STATUSES = ['CONFIRMED', 'PREPARING', 'SHIPPED', 'DELIVERED'] as const;

  /**
   * The product a public reviews URL names, or null.
   *
   * `active` only, matching `GET /v1/storefront/products/:slug` — a draft or
   * archived product 404s there, and a reviews endpoint that answered for one
   * anyway would be a way to read (and write) against products the merchant
   * has taken off the store.
   */
  async resolveVisibleProduct(tenantId: string, slug: string): Promise<{ id: string } | null> {
    return tenantDb(tenantId).product.findFirst({ where: { slug, status: 'active' }, select: { id: true } });
  }

  /**
   * The published ratings for one product, summarized.
   *
   * ## Hidden reviews are excluded, deliberately
   *
   * The average has to be an average OF THE REVIEWS ON THE PAGE. A shopper who
   * counts the stars in the list must be able to arrive at the number in the
   * header; an average that folds in rows nobody can see is unauditable, and
   * the first support message it produces is "¿por qué dice 4,2 si todas las
   * reseñas son de 5 estrellas?" — which the merchant cannot answer without
   * admitting they hid one.
   *
   * The obvious objection is that this lets a merchant lift their own average
   * by hiding every 1-star review. True, and not solved by averaging invisible
   * rows either — that version simply moves the dishonesty from a number the
   * shopper can check to one they cannot. What limits it instead is that
   * hiding also drops the COUNT (a store with 200 orders and 3 reviews reads as
   * exactly what it is), that hiding is an audited merchant action, and that
   * the shopper whose review was hidden is told so on the product page.
   */
  async summaryFor(tenantId: string, productId: string): Promise<RatingSummary> {
    const buckets = await tenantDb(tenantId).review.groupBy({
      by: ['rating'],
      where: { productId, status: 'published' },
      _count: { _all: true },
    });
    return summarizeRatings(buckets.map((bucket) => ({ rating: bucket.rating, count: bucket._count._all })));
  }

  /** Published reviews, newest first. Hidden ones are absent from this list for
   * the same reason they are absent from the average — the two must agree. */
  async listPublished(
    tenantId: string,
    productId: string,
    page: number,
    pageSize: number,
  ): Promise<PublicReview[]> {
    const rows = await tenantDb(tenantId).review.findMany({
      where: { productId, status: 'published' },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        rating: true,
        title: true,
        bodyMd: true,
        createdAt: true,
        replyMd: true,
        repliedAt: true,
        // The NAME only. `account.email` is deliberately not selected here at
        // all rather than selected and dropped later: the address is the most
        // identifying thing on the account, this payload is public, and a
        // field that is never loaded cannot be leaked by a later careless
        // spread.
        account: { select: { name: true } },
      },
    });
    return rows.map(toPublicReview);
  }

  /**
   * Whether this shopper may review this product, and their existing review if
   * they have one.
   *
   * Answers with a REASON rather than a boolean because the storefront has a
   * different, useful sentence for each case — "confirma tu correo", "solo
   * quienes compraron pueden reseñar", "ya escribiste tu reseña" — and a bare
   * `false` would force it to guess, or to show a form that fails on submit.
   */
  async eligibility(
    tenantId: string,
    shopper: ReviewerIdentity,
    productId: string,
  ): Promise<{ eligibility: Eligibility; review: OwnReview | null }> {
    const existing = await this.findOwn(tenantId, shopper.accountId, productId);
    if (existing) return { eligibility: 'already_reviewed', review: existing };
    if (!shopper.emailVerified) return { eligibility: 'email_not_verified', review: null };
    const orderId = await this.findEntitlingOrder(tenantId, shopper.customerId, productId);
    return { eligibility: orderId ? 'can_review' : 'not_purchased', review: null };
  }

  /**
   * Posts a review, after proving the purchase server-side.
   *
   * The checks run in a fixed order and each one has its own status code, so
   * the storefront can say the true thing rather than a generic failure. None
   * of them is skippable by anything in the request body.
   */
  async create(tenantId: string, shopper: ReviewerIdentity, input: ReviewCreateInput): Promise<OwnReview> {
    /**
     * Same gate as `GET /v1/storefront/account/orders`, and for a stronger
     * reason than that route has.
     *
     * An account is linked to the merchant's `Customer` row by MATCHING EMAIL
     * at registration, and anyone can register with someone else's address. On
     * the order-history route that mismatch leaks a stranger's purchases; here
     * it would let the impostor publish a review, under the store's own
     * "compra verificada" badge, on the strength of a purchase they did not
     * make. That is worse than the disclosure: the platform would be the one
     * making the false claim, to every future shopper who reads it.
     *
     * So verification is required, and it is required BEFORE the purchase
     * lookup — the lookup itself walks the unverified link, and answering
     * "not_purchased" versus "purchased" off an unverified link would turn this
     * endpoint into an oracle for whether a given address has bought a given
     * product.
     */
    if (!shopper.emailVerified) throw new HttpException({ error: 'EMAIL_NOT_VERIFIED' }, 403);

    const orderId = await this.findEntitlingOrder(tenantId, shopper.customerId, input.productId);
    if (!orderId) throw new HttpException({ error: 'PURCHASE_REQUIRED' }, 403);

    try {
      const created = await tenantDb(tenantId).review.create({
        data: {
          // `tenantId` is passed even though `tenantDb` injects it anyway
          // (and throws `CrossTenantError` if the two disagree) — same as
          // `catalog/categories.controller.ts`. Prisma's generated create
          // type requires it, and the alternative is a cast that would also
          // silence a genuinely missing field.
          tenantId,
          productId: input.productId,
          accountId: shopper.accountId,
          orderId,
          rating: input.rating,
          title: input.title ?? null,
          bodyMd: input.bodyMd,
          // `status` is left to the column default (`published`). Written out
          // nowhere on purpose: the day someone adds `status: 'pending'` here
          // is the day reviews stop appearing, and it should require editing
          // the schema to do it.
        },
        select: OWN_REVIEW_SELECT,
      });

      // Fire-and-forget, and awaited by nothing: the review row is written and
      // already public, so a mail transport that is briefly down must not turn
      // the shopper's successful POST into an error they cannot act on. Same
      // posture as the order emails and the agent handoff notice.
      void this.notifyMerchantOfReview(tenantId, input.productId, shopper.accountId, created).catch(
        (err: unknown) => {
          console.error('[reviews] new-review email failed', {
            tenantId,
            reviewId: created.id,
            error: err instanceof Error ? err.message : String(err),
          });
        },
      );

      return toOwnReview(created);
    } catch (err) {
      // `@@unique([tenantId, productId, accountId])` — one review per shopper
      // per product. Reached by a double-submitted form as easily as by
      // anything malicious, so it is a plain 409 rather than an error page.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new HttpException({ error: 'REVIEW_ALREADY_EXISTS' }, 409);
      }
      throw err;
    }
  }

  /**
   * Tells the merchant a review just landed.
   *
   * Reads the three things the message needs on its own rather than taking
   * them from `create`'s inputs: `create` holds ids, and an email holds names.
   * One extra round trip, off the request's critical path (nothing awaits
   * this), on the rare write that is a shopper posting a review — not on any
   * read.
   *
   * Skipped silently when the merchant never set a contact email in
   * `storeInfo`. No invented fallback address, matching the new-order alert in
   * `order-emails.ts` — the alternative is mail to nobody, or worse, to
   * whatever address happened to be nearest.
   *
   * The author is named the way the STOREFRONT names them
   * (`reviewAuthorLabel`), not by their full identity: see
   * `mailer/review-emails.ts` for why the address in particular stays in the
   * admin.
   */
  private async notifyMerchantOfReview(
    tenantId: string,
    productId: string,
    accountId: string,
    review: { rating: number; title: string | null; bodyMd: string },
  ): Promise<void> {
    const db = tenantDb(tenantId);
    const [tenant, product, account] = await Promise.all([
      db.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { name: true, settings: true } }),
      db.product.findFirstOrThrow({ where: { id: productId }, select: { name: true } }),
      db.shopperAccount.findFirst({ where: { id: accountId }, select: { name: true } }),
    ]);

    const settings = tenant.settings as Record<string, unknown> | null;
    const storeInfo = (settings?.storeInfo ?? {}) as Record<string, unknown>;
    const contactEmail = typeof storeInfo.contactEmail === 'string' ? storeInfo.contactEmail.trim() : '';
    if (contactEmail.length === 0) return;

    await sendNewReviewEmail(this.mailer, {
      merchantContactEmail: contactEmail,
      tenantName: tenant.name,
      productName: product.name,
      rating: review.rating,
      title: review.title,
      bodyMd: review.bodyMd,
      authorLabel: reviewAuthorLabel(account?.name ?? null),
    });
  }

  /** This shopper's own review of this product, hidden ones included — they
   * are the reason the row still exists (see `ReviewStatus.hidden`), and the
   * shopper is told when theirs is not visible. */
  async findOwn(tenantId: string, accountId: string, productId: string): Promise<OwnReview | null> {
    const row = await tenantDb(tenantId).review.findFirst({
      where: { accountId, productId },
      select: OWN_REVIEW_SELECT,
    });
    return row ? toOwnReview(row) : null;
  }

  /**
   * The order that entitles this shopper to review this product: the EARLIEST
   * qualifying one.
   *
   * Earliest rather than latest so the stored `orderId` never changes meaning.
   * A later order cannot retroactively become "the purchase this review is
   * about", and a merchant reading the review months on lands on the order the
   * shopper was actually talking about when they wrote it.
   *
   * Returns null — not an exception — for a shopper whose account has no
   * `Customer` link at all, which is the normal state for someone who
   * registered but has never bought anything.
   */
  private async findEntitlingOrder(
    tenantId: string,
    customerId: string | null,
    productId: string,
  ): Promise<string | null> {
    if (!customerId) return null;
    const order = await tenantDb(tenantId).order.findFirst({
      where: {
        customerId,
        // A cancelled order is not a purchase even when the money briefly
        // moved: it was refunded, and its author has nothing to review. Kept
        // as its own clause rather than folded into the status list, because
        // the PAID branch below would otherwise let a paid-then-cancelled
        // order through.
        status: { not: 'CANCELLED' },
        OR: [
          { paymentStatus: 'PAID' },
          { status: { in: [...ReviewsService.ACCEPTED_ORDER_STATUSES] } },
        ],
        // The product has to be IN the order. `some` on the items is the whole
        // point of the check — an order for something else entitles nobody.
        items: { some: { productId } },
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    return order?.id ?? null;
  }

  // ---- merchant side -----------------------------------------------------

  async listForAdmin(
    tenantId: string,
    query: { status?: 'published' | 'hidden'; productId?: string; page: number; pageSize: number },
  ): Promise<{ items: AdminReview[]; total: number; page: number; pageSize: number }> {
    const where = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.productId ? { productId: query.productId } : {}),
    };
    const db = tenantDb(tenantId);
    const [rows, total] = await Promise.all([
      db.review.findMany({
        where,
        // Newest first: moderation is a "what came in since I last looked"
        // job, not a browse.
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: {
          id: true,
          rating: true,
          title: true,
          bodyMd: true,
          status: true,
          replyMd: true,
          repliedAt: true,
          createdAt: true,
          orderId: true,
          product: { select: { id: true, name: true, slug: true } },
          // The merchant may see the full name and the address: this shopper
          // bought from them, so both are already in their orders list. The
          // abbreviation in `reviewAuthorLabel` protects the shopper from the
          // PUBLIC, not from the person who shipped them a parcel.
          account: { select: { name: true, email: true } },
        },
      }),
      db.review.count({ where }),
    ]);
    return { items: rows.map(toAdminReview), total, page: query.page, pageSize: query.pageSize };
  }

  /**
   * Hide/unhide and reply. The only merchant write there is.
   *
   * `repliedAt` is derived from `replyMd` rather than accepted from the caller:
   * a reply with no timestamp (or a stale one left behind by a deletion) would
   * render as "respondió el —", and the two columns disagreeing is exactly the
   * sort of thing nobody notices until a shopper screenshots it.
   */
  async moderate(tenantId: string, id: string, input: ReviewModerationInput): Promise<AdminReview> {
    const existing = await tenantDb(tenantId).review.findFirst({ where: { id }, select: { id: true } });
    if (!existing) throw new HttpException({ error: 'REVIEW_NOT_FOUND' }, 404);

    const updated = await tenantDb(tenantId).review.update({
      where: { id },
      data: {
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.replyMd !== undefined
          ? { replyMd: input.replyMd, repliedAt: input.replyMd === null ? null : new Date() }
          : {}),
      },
      select: {
        id: true,
        rating: true,
        title: true,
        bodyMd: true,
        status: true,
        replyMd: true,
        repliedAt: true,
        createdAt: true,
        orderId: true,
        product: { select: { id: true, name: true, slug: true } },
        account: { select: { name: true, email: true } },
      },
    });
    return toAdminReview(updated);
  }
}

// ---- shapes --------------------------------------------------------------

/** What a review handler needs to know about the shopper. Structurally the
 * fields of `ShopperIdentity` this service reads — declared here rather than
 * importing the shopper module's type so the dependency runs one way only. */
export interface ReviewerIdentity {
  accountId: string;
  customerId: string | null;
  emailVerified: boolean;
}

export type Eligibility = 'can_review' | 'already_reviewed' | 'not_purchased' | 'email_not_verified';

/** What any visitor may see. No account id, no email, and an abbreviated name. */
export interface PublicReview {
  id: string;
  rating: number;
  title: string | null;
  bodyMd: string;
  authorLabel: string;
  createdAt: Date;
  replyMd: string | null;
  repliedAt: Date | null;
}

/** What the AUTHOR sees of their own review — the same fields plus `status`,
 * so the storefront can tell them their review is currently hidden instead of
 * showing it back to them as if it were live. */
export interface OwnReview extends Omit<PublicReview, 'authorLabel'> {
  status: 'published' | 'hidden';
}

export interface AdminReview {
  id: string;
  rating: number;
  title: string | null;
  bodyMd: string;
  status: 'published' | 'hidden';
  replyMd: string | null;
  repliedAt: Date | null;
  createdAt: Date;
  /** The purchase this review rests on. Surfaced so a merchant reading a
   * complaint can go and look at the actual order. */
  orderId: string;
  product: { id: string; name: string; slug: string };
  author: { name: string | null; email: string };
}

const OWN_REVIEW_SELECT = {
  id: true,
  rating: true,
  title: true,
  bodyMd: true,
  status: true,
  createdAt: true,
  replyMd: true,
  repliedAt: true,
} as const;

function toPublicReview(row: {
  id: string;
  rating: number;
  title: string | null;
  bodyMd: string;
  createdAt: Date;
  replyMd: string | null;
  repliedAt: Date | null;
  account: { name: string | null };
}): PublicReview {
  return {
    id: row.id,
    rating: row.rating,
    title: row.title,
    bodyMd: row.bodyMd,
    authorLabel: reviewAuthorLabel(row.account.name),
    createdAt: row.createdAt,
    replyMd: row.replyMd,
    repliedAt: row.repliedAt,
  };
}

function toOwnReview(row: {
  id: string;
  rating: number;
  title: string | null;
  bodyMd: string;
  status: 'published' | 'hidden';
  createdAt: Date;
  replyMd: string | null;
  repliedAt: Date | null;
}): OwnReview {
  return { ...row };
}

function toAdminReview(row: {
  id: string;
  rating: number;
  title: string | null;
  bodyMd: string;
  status: 'published' | 'hidden';
  replyMd: string | null;
  repliedAt: Date | null;
  createdAt: Date;
  orderId: string;
  product: { id: string; name: string; slug: string };
  account: { name: string | null; email: string };
}): AdminReview {
  const { account, ...rest } = row;
  return { ...rest, author: account };
}
