import { Global, Module } from '@nestjs/common';
import { Resend } from 'resend';
import { ConsoleMailer, MAILER, type Mailer } from './mailer';
import { ResendMailer } from './resend-mailer';

/**
 * Provides the app-wide MAILER token. Marked @Global so any module can
 * `@Inject(MAILER)` without importing this module directly, as long as it's
 * imported once somewhere in the graph. Today that single import lives in
 * AdminModule (whose AUTH_INSTANCE factory is the one concrete consumer);
 * AppModule does NOT import it directly.
 *
 * `useFactory`, not a static `useClass`: which Mailer implementation backs
 * MAILER is an environment decision, made once at module-init time —
 * `RESEND_API_KEY` set means a real tenant-facing deploy, wired to
 * ResendMailer; unset (every dev/test environment today) falls back to
 * ConsoleMailer, exactly as before this task.
 *
 * Deliberately reads `process.env` directly here instead of `@ventia/core`'s
 * `loadEnv()`: `loadEnv()` validates the WHOLE env schema (including
 * required-with-no-default fields like `AUTH_SECRET`) and throws if anything
 * is missing. This factory runs on every single app bootstrap — including
 * every test file's `createApp()` — and no test in this suite sets
 * `AUTH_SECRET`, so a `loadEnv()` call here would throw at module-init time
 * and take down the ENTIRE test suite, not just mailer-specific tests. This
 * mirrors `admin/admin.module.ts`'s AUTH_INSTANCE factory, which reads
 * `process.env.AUTH_SECRET ?? 'dev-secret-change-me'` directly for the exact
 * same reason rather than going through `loadEnv()`. The default below
 * (`pedidos@ventia.localhost`) matches `@ventia/core`'s `RESEND_FROM_EMAIL`
 * schema default, which real deploys (whose bootstrap DOES call `loadEnv()`
 * successfully, since every required var is actually set there) validate.
 */
@Global()
@Module({
  providers: [
    {
      provide: MAILER,
      useFactory: (): Mailer => {
        const apiKey = process.env.RESEND_API_KEY;
        const fromEmail = process.env.RESEND_FROM_EMAIL ?? 'pedidos@ventia.localhost';
        return apiKey ? new ResendMailer(new Resend(apiKey), fromEmail) : new ConsoleMailer();
      },
    },
  ],
  exports: [MAILER],
})
export class MailerModule {}
