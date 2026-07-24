import { Controller, Get, Module, Req, UseGuards } from '@nestjs/common';
import { platformDb } from '@ventia/db';
import { createAuth } from '../auth/auth';
import { MAILER, type Mailer } from '../mailer/mailer';
import { MailerModule } from '../mailer/mailer.module';
import { AdminSessionGuard, type RequestWithAdminSession } from './admin-session.guard';
import { AdminSession, type AdminSessionContext } from './roles.decorator';
import { AUTH_INSTANCE } from './auth-instance';

export { AUTH_INSTANCE };

@Controller('v1/admin/me')
@UseGuards(AdminSessionGuard)
export class AdminMeController {
  @Get()
  me(
    @AdminSession() session: AdminSessionContext,
    @Req() req: RequestWithAdminSession,
  ): AdminSessionContext & { emailVerified: boolean } {
    // emailVerified deliberately isn't part of AdminSessionContext (see that
    // type's doc comment) — AdminSessionGuard stashes it on the request
    // separately (req.emailVerified), and only this /me response surfaces it.
    return { ...session, emailVerified: req.emailVerified ?? false };
  }
}

@Module({
  imports: [MailerModule],
  controllers: [AdminMeController],
  providers: [
    {
      provide: AUTH_INSTANCE,
      inject: [MAILER],
      useFactory: (mailer: Mailer) =>
        createAuth(platformDb, {
          secret: process.env.AUTH_SECRET ?? 'dev-secret-change-me',
          baseURL: process.env.API_URL ?? 'http://api.ventia.localhost',
          mailer,
        }),
    },
    AdminSessionGuard,
  ],
  exports: [AUTH_INSTANCE, AdminSessionGuard],
})
export class AdminModule {}
