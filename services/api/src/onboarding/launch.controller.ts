import { Controller, HttpCode, Inject, Post, Req, UseGuards } from '@nestjs/common';
import { AdminSessionGuard, type RequestWithAdminSession } from '../admin/admin-session.guard';
import { AdminSession, Roles, type AdminSessionContext } from '../admin/roles.decorator';
import { OnboardingService } from './onboarding.service';

// @Roles('owner'): launch is the one wizard action that commits the tenant
// to going live, so — unlike GET/PATCH /v1/admin/onboarding's owner+staff
// split — staff sessions get 403 FORBIDDEN_ROLE before the handler runs.
@Controller('v1/admin/launch')
@UseGuards(AdminSessionGuard)
@Roles('owner')
export class LaunchController {
  constructor(@Inject(OnboardingService) private readonly onboarding: OnboardingService) {}

  @Post()
  @HttpCode(200)
  async launch(@AdminSession() session: AdminSessionContext, @Req() req: RequestWithAdminSession) {
    return this.onboarding.launch(session, req.emailVerified ?? false);
  }
}
