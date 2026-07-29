import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module';
import { PaymentsModule } from '../payments/payments.module';
import { SettingsController } from './settings.controller';

@Module({
  imports: [AdminModule, PaymentsModule],
  controllers: [SettingsController],
})
export class SettingsModule {}
