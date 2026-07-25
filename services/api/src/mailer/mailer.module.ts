import { Global, Module } from '@nestjs/common';
import { ConsoleMailer, MAILER } from './mailer';

/**
 * Provides the app-wide MAILER token. Marked @Global so any module can
 * `@Inject(MAILER)` without importing this module directly, as long as it's
 * imported once somewhere in the graph. Today that single import lives in
 * AdminModule (whose AUTH_INSTANCE factory is the one concrete consumer);
 * AppModule does NOT import it directly.
 */
@Global()
@Module({
  providers: [{ provide: MAILER, useClass: ConsoleMailer }],
  exports: [MAILER],
})
export class MailerModule {}
