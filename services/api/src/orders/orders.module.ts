import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';

@Module({
  imports: [AdminModule],
  controllers: [OrdersController],
  providers: [OrdersService],
})
export class OrdersModule {}
