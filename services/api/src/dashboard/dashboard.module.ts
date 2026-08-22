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
})
export class DashboardModule {}
