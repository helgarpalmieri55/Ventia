import { Body, Controller, Inject, Post, Req, UseGuards } from '@nestjs/common';
import { AuthenticatedGuard, type RequestWithSession } from '../admin/authenticated.guard';
import { StaffService } from './staff.service';

/**
 * Separate controller (rather than a route on StaffController) because this
 * endpoint sits behind AuthenticatedGuard, not AdminSessionGuard — same
 * reasoning as OnboardingController splitting `POST tenant` off from the
 * @Roles('owner') routes: the caller here has a signed-in session but must
 * NOT be required to already have a tenant/membership (that's exactly what
 * this endpoint grants them).
 */
@Controller('v1/staff')
@UseGuards(AuthenticatedGuard)
export class StaffAcceptController {
  // Explicit @Inject: esbuild (vitest's default TS transform) does not emit
  // TypeScript's `design:paramtypes` decorator metadata, so Nest's implicit
  // constructor-injection cannot resolve StaffService by type alone (same
  // caution as AdminSessionGuard's constructor).
  constructor(@Inject(StaffService) private readonly staff: StaffService) {}

  @Post('accept')
  async accept(@Req() req: RequestWithSession, @Body() body: unknown) {
    // AuthenticatedGuard always sets req.session before canActivate returns
    // true, so this is never actually undefined here (same note as
    // onboarding.controller.ts#provisionTenant).
    return this.staff.acceptInvite(req.session!, body);
  }
}
