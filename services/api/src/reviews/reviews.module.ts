import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module';
import { ShopperModule } from '../shopper/shopper.module';
import { AdminReviewsController } from './admin-reviews.controller';
import { ReviewsService } from './reviews.service';
import { ShopperReviewsController } from './shopper-reviews.controller';
import { StorefrontReviewsController } from './storefront-reviews.controller';

/**
 * Product reviews: the public read, the shopper's write, the merchant's
 * moderation.
 *
 * The two imports are here because a guard is constructed from the injector of
 * the module that declares the CONTROLLER using it, not the one that declares
 * the guard — so both of this module's guarded controllers need their guard's
 * dependencies resolvable from here. `AdminModule` supplies `AUTH_INSTANCE`
 * for `AdminSessionGuard`; `ShopperModule` supplies `ShopperAuthService` for
 * `ShopperSessionGuard`. (`PublicTenantGuard` needs neither an import nor a
 * provider: it injects nothing, so Nest builds it from the `@UseGuards`
 * reference alone.)
 *
 * Reusing `ShopperSessionGuard` rather than writing a second one is deliberate.
 * It resolves a session against the store THIS request resolved to, and a
 * second implementation would be a second place for "sessions belong to one
 * store" to be got subtly wrong.
 */
@Module({
  imports: [AdminModule, ShopperModule],
  controllers: [StorefrontReviewsController, ShopperReviewsController, AdminReviewsController],
  providers: [ReviewsService],
  exports: [ReviewsService],
})
export class ReviewsModule {}
