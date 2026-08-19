import { Controller, Get, Module, Req, UseGuards } from '@nestjs/common';
import { platformDb } from '@ventia/db';
import type { ImpersonationContext } from '@ventia/core';
import { createAuth } from '../auth/auth';
import { MAILER, type Mailer } from '../mailer/mailer';
import { MailerModule } from '../mailer/mailer.module';
import { AdminSessionGuard, type RequestWithAdminSession } from './admin-session.guard';
import { AuthenticatedGuard } from './authenticated.guard';
import { AdminSession, type AdminSessionContext } from './roles.decorator';
import { AUTH_INSTANCE } from './auth-instance';

export { AUTH_INSTANCE };

/**
 * `GET /v1/admin/me` is also THE source of truth for the impersonation banner
 * (docs/superpowers/specs/2026-08-19-impersonation-design.md §5).
 *
 * The admin shell must render its banner from `impersonation` in this
 * response — never from a client-side flag, a route param, or the presence of
 * a cookie (the grant cookie is HttpOnly and unreadable from JS by design). A
 * UI that decides for itself whether it is impersonating can be wrong; one
 * that reports what the API just told it cannot be more wrong than the API.
 *
 * `impersonation` is `null` — present, explicitly null — rather than absent
 * when nobody is impersonating, so a client that forgets to handle the field
 * fails visibly at the point of use rather than rendering nothing forever.
 */
@Controller('v1/admin/me')
@UseGuards(AdminSessionGuard)
export class AdminMeController {
  @Get()
  me(
    @AdminSession() session: AdminSessionContext,
    @Req() req: RequestWithAdminSession,
  ): AdminSessionContext & { emailVerified: boolean; impersonation: ImpersonationContext | null } {
    // emailVerified deliberately isn't part of AdminSessionContext (see that
    // type's doc comment) — AdminSessionGuard stashes it on the request
    // separately (req.emailVerified), and only this /me response surfaces it.
    // `impersonation` rides along for the identical reason.
    return {
      ...session,
      emailVerified: req.emailVerified ?? false,
      impersonation: req.impersonation ?? null,
    };
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
          // The admin app is the only browser-side caller of these routes
          // (via its own same-origin `/api` proxy — see auth.ts's doc
          // comment on `trustedOrigins`), so its origin is what needs to be
          // trusted here, not the API's own.
          trustedOrigins: [process.env.ADMIN_URL ?? 'http://admin.ventia.localhost'],
        }),
    },
    AdminSessionGuard,
    AuthenticatedGuard,
  ],
  exports: [AUTH_INSTANCE, AdminSessionGuard, AuthenticatedGuard],
})
export class AdminModule {}
