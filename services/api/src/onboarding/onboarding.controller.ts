import { Body, Controller, Get, Inject, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { AdminSessionGuard, type RequestWithAdminSession } from '../admin/admin-session.guard';
import { AuthenticatedGuard, type RequestWithSession } from '../admin/authenticated.guard';
import { AdminSession, Roles, type AdminSessionContext } from '../admin/roles.decorator';
import { OnboardingService } from './onboarding.service';

@Controller('v1/admin/onboarding')
export class OnboardingController {
  constructor(@Inject(OnboardingService) private readonly onboarding: OnboardingService) {}

  // AuthenticatedGuard, not AdminSessionGuard: this is the one admin-portal
  // action a signed-in user with NO tenant/membership yet must be allowed to
  // call (see authenticated.guard.ts's doc comment for why a separate guard
  // rather than an option on AdminSessionGuard).
  @Post('tenant')
  @UseGuards(AuthenticatedGuard)
  async provisionTenant(@Req() req: RequestWithSession, @Body() body: unknown) {
    // AuthenticatedGuard always sets req.session before canActivate returns
    // true, so this is never actually undefined here.
    return this.onboarding.provisionTenant(req.session!, body);
  }

  @Get()
  @UseGuards(AdminSessionGuard)
  async get(@AdminSession() session: AdminSessionContext, @Req() req: RequestWithAdminSession) {
    return this.onboarding.getOnboarding(session, req.emailVerified ?? false);
  }

  @Patch()
  @UseGuards(AdminSessionGuard)
  @Roles('owner')
  async patch(@AdminSession() session: AdminSessionContext, @Body() body: unknown) {
    return this.onboarding.patchOnboarding(session, body);
  }
}
