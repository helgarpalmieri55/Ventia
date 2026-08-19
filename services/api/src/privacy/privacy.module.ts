import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module';
import { PrivacyController } from './privacy.controller';
import { PrivacyService } from './privacy.service';

/** SPEC §9 (Ley 1581 — Habeas Data): the customer data deletion flow.
 * Imports AdminModule for AdminSessionGuard, same as StaffModule. */
@Module({
  imports: [AdminModule],
  controllers: [PrivacyController],
  providers: [PrivacyService],
})
export class PrivacyModule {}
