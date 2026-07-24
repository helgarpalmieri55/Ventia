import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module';
import { StaffAcceptController } from './staff-accept.controller';
import { StaffController } from './staff.controller';
import { StaffService } from './staff.service';

// MailerModule is not imported here: it's @Global (see mailer.module.ts's
// doc comment) and already imported once by AdminModule, so StaffService's
// @Inject(MAILER) resolves without a direct import edge.
@Module({
  imports: [AdminModule],
  controllers: [StaffController, StaffAcceptController],
  providers: [StaffService],
})
export class StaffModule {}
