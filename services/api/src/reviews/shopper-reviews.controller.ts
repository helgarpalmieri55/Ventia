import { Body, Controller, Get, HttpCode, Inject, Post, Query, UseGuards } from '@nestjs/common';
import { reviewCreateSchema } from '@ventia/core';
import { parseOr400 } from '../catalog/parse';
import { assertUuidOr404 } from '../catalog/uuid';
import { PublicTenantGuard } from '../storefront/public-tenant.guard';
import { StorefrontTenantId } from '../storefront/storefront-tenant.decorator';
import { Shopper, ShopperSessionGuard } from '../shopper/shopper-session.guard';
import type { ShopperIdentity } from '../shopper/shopper-auth.service';
import { ReviewsService } from './reviews.service';

/**
 * A shopper's own review: may I write one, and here is one.
 *
 * ## Why this lives under `/account` and not under the product
 *
 * Both routes need the `ventia_shopper` session cookie, and in the browser
 * that cookie only reaches the API through the storefront's own
 * `/api/account/*` Route Handler proxy (see that file: an HttpOnly cookie set
 * by a cross-origin API response is scoped to the API's domain and never comes
 * back). Mounting these two handlers on the account prefix means they travel
 * that existing, tested path instead of needing a second proxy that would have
 * to get the same cookie round-trip right a second time.
 *
 * `ShopperSessionGuard` is reused as-is — it resolves the session against the
 * store this request resolved to, which is the property that stops a session
 * from one tenant being presented at another. Writing a second guard here
 * would mean two places to get that wrong.
 */
@Controller('v1/storefront/account/reviews')
@UseGuards(PublicTenantGuard, ShopperSessionGuard)
export class ShopperReviewsController {
  // Explicit @Inject: esbuild (vitest's transform) emits no `design:paramtypes`.
  constructor(@Inject(ReviewsService) private readonly reviews: ReviewsService) {}

  /**
   * What the product page should offer this shopper for this product.
   *
   * A 401 (no session) is left to the guard and is a perfectly ordinary answer
   * — most people reading a product page are not signed in — which the
   * storefront turns into "inicia sesión para escribir una reseña" rather than
   * an error.
   */
  @Get()
  async mine(
    @StorefrontTenantId() tenantId: string,
    @Shopper() shopper: ShopperIdentity,
    @Query('productId') productId?: string,
  ) {
    // A malformed id gets the same 404 a nonexistent one would (see
    // `assertUuidOr404`) instead of a Prisma P2023 surfacing as a 500.
    assertUuidOr404(productId ?? '');
    return this.reviews.eligibility(tenantId, shopper, productId as string);
  }

  /** 201 and the review, live. There is no approval step to wait for — see the
   * `Review` model's doc comment for why that is the design and not an
   * omission. */
  @Post()
  @HttpCode(201)
  async create(
    @StorefrontTenantId() tenantId: string,
    @Shopper() shopper: ShopperIdentity,
    @Body() body: unknown,
  ) {
    const input = parseOr400(reviewCreateSchema, body);
    const review = await this.reviews.create(tenantId, shopper, input);
    return { review };
  }
}
