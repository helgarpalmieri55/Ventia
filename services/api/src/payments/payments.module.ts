import { Module } from '@nestjs/common';
import { PaymentsService } from './payments.service';

// Not @Global(): MailerModule is Global because a single MAILER token/factory
// needs to be reachable from anywhere in the graph without every consumer
// re-declaring it. PaymentsService has no such single-factory-token shape —
// it's an ordinary injectable, and this codebase's established convention for
// an ordinary cross-module service is an explicit `imports: [PaymentsModule]`
// in each consuming module (mirrors how OrdersModule imports AdminModule
// rather than something being marked Global for it). SettingsModule (this
// task) imports this; a future webhooks module / checkout's wompi branch
// (Tasks 4-5) will do the same.
@Module({
  providers: [PaymentsService],
  exports: [PaymentsService],
})
export class PaymentsModule {}
