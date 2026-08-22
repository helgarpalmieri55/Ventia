import { Module } from '@nestjs/common';
import { CheckoutModule } from '../checkout/checkout.module';
import { MailerModule } from '../mailer/mailer.module';
import { ShopperAuthService } from './shopper-auth.service';
import { ShopperController } from './shopper.controller';
import { ShopperSessionGuard } from './shopper-session.guard';
import { ShopperSessionCleanupWorker } from './shopper-session.worker';
import { ShopperAddressesService } from './shopper-addresses.service';
import { ShopperWishlistService } from './shopper-wishlist.service';

/**
 * Shopper accounts (per store — see the `ShopperAccount` model).
 *
 * Imports `CheckoutModule` for `CartService`, because signing in has to merge
 * the shopper's basket and that logic belongs with the cart, not duplicated
 * here.
 *
 * `PublicTenantGuard` — which resolves the store every route here is scoped to
 * — needs no import or provider: it injects nothing, so Nest constructs it
 * from the `@UseGuards(PublicTenantGuard)` reference alone, exactly as the
 * storefront's own controllers use it.
 *
 * Registering this module starts nothing.
 */
@Module({
  imports: [MailerModule, CheckoutModule],
  controllers: [ShopperController],
  providers: [
    ShopperAuthService,
    ShopperSessionGuard,
    ShopperSessionCleanupWorker,
    ShopperAddressesService,
    ShopperWishlistService,
  ],
  exports: [ShopperAuthService, ShopperSessionCleanupWorker, ShopperAddressesService],
})
export class ShopperModule {}
