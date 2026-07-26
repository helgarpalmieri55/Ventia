import { Module } from '@nestjs/common';
import { CartController } from './cart.controller';
import { CartCookieGuard } from './cart-cookie.guard';
import { CartService } from './cart.service';
import { CheckoutController } from './checkout.controller';
import { CheckoutService } from './checkout.service';
import { ShippingService } from './shipping.service';

@Module({
  controllers: [CartController, CheckoutController],
  providers: [CartCookieGuard, CartService, ShippingService, CheckoutService],
})
export class CheckoutModule {}
