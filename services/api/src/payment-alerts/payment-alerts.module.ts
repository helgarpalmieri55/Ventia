import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module';
import { PaymentAlertsController } from './payment-alerts.controller';
import { PaymentAlertsService } from './payment-alerts.service';

/**
 * Its own module rather than a route on `OrdersModule`, and deliberately
 * outside `src/payments/`: this is a read-only reporting surface over the
 * `WebhookEvent` audit trail. Nothing here imports the settle path, and
 * nothing in the settle path imports this — so no future edit to a payment
 * alerts query can reach into the code that moves money.
 */
@Module({
  imports: [AdminModule],
  controllers: [PaymentAlertsController],
  providers: [PaymentAlertsService],
})
export class PaymentAlertsModule {}
