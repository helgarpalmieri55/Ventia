import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module';
import { PaymentsModule } from '../payments/payments.module';
import { AdminContentController } from './content.controller';
import { PrivacyPolicyService } from './privacy-policy.service';
import { SettingsController } from './settings.controller';

@Module({
  imports: [AdminModule, PaymentsModule],
  controllers: [SettingsController, AdminContentController],
  providers: [PrivacyPolicyService],
})
export class SettingsModule {}
