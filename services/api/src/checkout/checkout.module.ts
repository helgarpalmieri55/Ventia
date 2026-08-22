import { Module } from '@nestjs/common';
import { PaymentsModule } from '../payments/payments.module';
import { CartController } from './cart.controller';
import { CartCookieGuard } from './cart-cookie.guard';
import { CartService } from './cart.service';
import { CheckoutController } from './checkout.controller';
import { CheckoutService } from './checkout.service';
import { OrderTrackingController } from './order-tracking.controller';
import { OrderTrackingService } from './order-tracking.service';
import { ShippingService } from './shipping.service';

// PaymentsModule is NOT @Global() (see payments.module.ts's own doc comment)
// — CheckoutService's new `wompi` branch (Task 5) needs PaymentsService
// (getTenantProviderConfig) and the provider registry's getProvider(), so
// this module imports PaymentsModule the same way SettingsModule already
// does for its own admin-credentials UI.
@Module({
  imports: [PaymentsModule],
  controllers: [CartController, CheckoutController, OrderTrackingController],
  providers: [CartCookieGuard, CartService, ShippingService, CheckoutService, OrderTrackingService],
  // Exported for the agent's `get_order_status` tool — one implementation of
  // the double-factor lookup, shared with the public tracking endpoint.
  // `CartService` is exported for `ShopperModule`: signing in merges the
  // shopper's basket, and that logic belongs with the cart rather than being
  // written a second time in the accounts module.
  exports: [OrderTrackingService, CartService],
})
export class CheckoutModule {}
