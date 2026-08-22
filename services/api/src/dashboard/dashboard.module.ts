import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

/** AdminModule is imported for AdminSessionGuard + AUTH_INSTANCE, same as
 * OrdersModule and every other merchant-facing module. */
@Module({
  imports: [AdminModule],
  controllers: [DashboardController],
  providers: [DashboardService],
  // Exported so the merchant assistant (`agent-command/`) answers from the
  // SAME aggregation this screen renders. A second set of sales figures that
  // could disagree with the merchant's own tablero is the one failure that
  // feature cannot have.
  exports: [DashboardService],
})
export class DashboardModule {}
