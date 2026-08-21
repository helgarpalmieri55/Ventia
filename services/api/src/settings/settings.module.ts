import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module';
import { ShippingService } from '../checkout/shipping.service';
import { PaymentsModule } from '../payments/payments.module';
import { AdminContentController } from './content.controller';
import { PrivacyPolicyService } from './privacy-policy.service';
import { SettingsController } from './settings.controller';
import { TermsService } from './terms.service';

// `ShippingService` is provided here rather than imported from CheckoutModule
// (which does not export it): it is stateless — no constructor dependencies,
// no fields — so a second instance is the same object for every purpose, and
// TermsService needs it to quote a store's REAL shipping prices in the
// generated contract rather than parsing `settings.shipping` a second way.
@Module({
  imports: [AdminModule, PaymentsModule],
  controllers: [SettingsController, AdminContentController],
  providers: [PrivacyPolicyService, ShippingService, TermsService],
})
export class SettingsModule {}
