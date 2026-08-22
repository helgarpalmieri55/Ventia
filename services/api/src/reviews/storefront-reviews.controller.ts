import { Controller, Get, HttpException, Inject, NotFoundException, Param, Query, UseGuards } from '@nestjs/common';
import { PublicTenantGuard } from '../storefront/public-tenant.guard';
import { StorefrontTenantId } from '../storefront/storefront-tenant.decorator';
import { ReviewsService } from './reviews.service';

const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 50;

/** Same VALIDATION_FAILED shape `parseOr400` produces, for the two numeric
 * query params. Copied from `storefront/products.controller.ts` rather than
 * shared — see that file for this codebase's position on a four-line helper. */
function parsePositiveIntOr400(raw: string | undefined, field: string, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new HttpException({ error: 'VALIDATION_FAILED', details: { [field]: 'debe ser un número válido' } }, 400);
  }
  return value;
}

/**
 * The reviews a shopper reads before deciding, and the number above them.
 *
 * Public and unauthenticated: reviews are the part of this feature that has to
 * be readable by someone who has never signed in, because they are read by
 * exactly the person who has not bought anything yet.
 *
 * Mounted under the product's own URL — one more segment than
 * `GET /v1/storefront/products/:slug`, so the two never collide — because a
 * review has no life of its own outside the product it is about.
 */
@Controller('v1/storefront/products/:slug/reviews')
@UseGuards(PublicTenantGuard)
export class StorefrontReviewsController {
  // Explicit @Inject: esbuild (vitest's transform) emits no `design:paramtypes`.
  constructor(@Inject(ReviewsService) private readonly reviews: ReviewsService) {}

  @Get()
  async list(
    @StorefrontTenantId() tenantId: string,
    @Param('slug') slug: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const product = await this.reviews.resolveVisibleProduct(tenantId, slug);
    // The same 404 the product page itself gives for this slug. A reviews
    // endpoint that answered `{ reviews: [] }` for a draft product would
    // confirm the product exists to anyone who guessed its slug.
    if (!product) throw new NotFoundException({ error: 'PRODUCT_NOT_FOUND' });

    const resolvedPage = parsePositiveIntOr400(page, 'page', 1);
    const resolvedPageSize = Math.min(parsePositiveIntOr400(pageSize, 'pageSize', DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);

    // Summary and page in parallel: they are independent reads, and the
    // summary is the part above the fold.
    const [summary, reviews] = await Promise.all([
      this.reviews.summaryFor(tenantId, product.id),
      this.reviews.listPublished(tenantId, product.id, resolvedPage, resolvedPageSize),
    ]);

    // `summary.count` IS the total — it counts the same published rows this
    // list pages through, so there is no second count that could disagree with
    // the average's denominator.
    return { summary, reviews, page: resolvedPage, pageSize: resolvedPageSize };
  }
}
