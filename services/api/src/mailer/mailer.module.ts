import { Global, Module } from '@nestjs/common';
import { ConsoleMailer, MAILER } from './mailer';

/**
 * Provides the app-wide MAILER token. Marked @Global so any module can
 * `@Inject(MAILER)` without importing this module directly, as long as it's
 * imported once somewhere in the graph (done in AppModule) — AdminModule
 * also imports it explicitly (harmless when a module is global) since its
 * AUTH_INSTANCE factory is the one concrete consumer today.
 */
@Global()
@Module({
  providers: [{ provide: MAILER, useClass: ConsoleMailer }],
  exports: [MAILER],
})
export class MailerModule {}
