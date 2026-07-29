import { Module } from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { StockReservationWorker } from './stock-reservation.worker';
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
// StockReservationWorker (Task 6) is registered as an ordinary provider
// here too — same non-Global reasoning as PaymentsService above. Registering
// it does NOT start its BullMQ Queue/Worker: that class deliberately
// implements no Nest lifecycle hook that would auto-start anything (see its
// own doc comment for why — `createApp()` runs in every test file's
// `beforeAll`, so anything that started real BullMQ machinery from
// `onModuleInit` would start it in every test run too). `main.ts`'s
// `if (require.main === module)` real-boot block is the ONLY caller of
// `app.get(StockReservationWorker).start()`.
@Module({
  controllers: [WebhooksController],
  providers: [PaymentsService, StockReservationWorker],
  exports: [PaymentsService, StockReservationWorker],
})
export class PaymentsModule {}
