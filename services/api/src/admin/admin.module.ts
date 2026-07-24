import { Controller, Get, Module, UseGuards } from '@nestjs/common';
import { platformDb } from '@ventia/db';
import { createAuth } from '../auth/auth';
import { AdminSessionGuard } from './admin-session.guard';
import { AdminSession, type AdminSessionContext } from './roles.decorator';
import { AUTH_INSTANCE } from './auth-instance';

export { AUTH_INSTANCE };

@Controller('v1/admin/me')
@UseGuards(AdminSessionGuard)
export class AdminMeController {
  @Get()
  me(@AdminSession() session: AdminSessionContext): AdminSessionContext {
    return session;
  }
}

@Module({
  controllers: [AdminMeController],
  providers: [
    {
      provide: AUTH_INSTANCE,
      useFactory: () =>
        createAuth(platformDb, {
          secret: process.env.AUTH_SECRET ?? 'dev-secret-change-me',
          baseURL: process.env.API_URL ?? 'http://api.ventia.localhost',
        }),
    },
    AdminSessionGuard,
  ],
  exports: [AUTH_INSTANCE, AdminSessionGuard],
})
export class AdminModule {}
