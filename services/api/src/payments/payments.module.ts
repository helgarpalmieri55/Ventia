import { Module } from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { WebhooksController } from './webhooks.controller';

// Not @Global(): MailerModule is Global because a single MAILER token/factory
// needs to be reachable from anywhere in the graph without every consumer
// re-declaring it. PaymentsService has no such single-factory-token shape —
// it's an ordinary injectable, and this codebase's established convention for
// an ordinary cross-module service is an explicit `imports: [PaymentsModule]`
// in each consuming module (mirrors how OrdersModule imports AdminModule
// rather than something being marked Global for it). SettingsModule already
// does this; checkout's wompi branch (Task 5) will do the same.
//
// WebhooksController (Task 4) is declared directly on THIS module, not a
// separate WebhooksModule — Nest registers a module's `controllers` as long
// as that module is reachable anywhere in the import graph from AppModule,
// regardless of depth, and PaymentsModule already is (via SettingsModule's
// `imports: [PaymentsModule]`), so no change to app.module.ts is needed for
// this route to be picked up.
@Module({
  controllers: [WebhooksController],
  providers: [PaymentsService],
  exports: [PaymentsService],
})
export class PaymentsModule {}
