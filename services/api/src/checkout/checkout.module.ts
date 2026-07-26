import { Module } from '@nestjs/common';
import { CartController } from './cart.controller';
import { CartCookieGuard } from './cart-cookie.guard';
import { CartService } from './cart.service';

@Module({
  controllers: [CartController],
  providers: [CartCookieGuard, CartService],
})
export class CheckoutModule {}
