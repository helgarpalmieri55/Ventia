import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module';
import { ShippingService } from '../checkout/shipping.service';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';

// ShippingService is also provided by CheckoutModule (which doesn't export
// it) — registered here too rather than importing that whole module, since
// ShippingService has no constructor dependencies of its own and Nest is
// fine instantiating a second, independent instance of a stateless service.
@Module({
  imports: [AdminModule],
  controllers: [OrdersController],
  providers: [OrdersService, ShippingService],
})
export class OrdersModule {}
