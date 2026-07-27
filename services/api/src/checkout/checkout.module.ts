import { Module } from '@nestjs/common';
import { CartController } from './cart.controller';
import { CartCookieGuard } from './cart-cookie.guard';
import { CartService } from './cart.service';
import { CheckoutController, OrderTrackingController } from './checkout.controller';
import { CheckoutService } from './checkout.service';
import { ShippingService } from './shipping.service';

@Module({
  controllers: [CartController, CheckoutController, OrderTrackingController],
  providers: [CartCookieGuard, CartService, ShippingService, CheckoutService],
})
export class CheckoutModule {}
