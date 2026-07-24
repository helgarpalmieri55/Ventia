import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, UseGuards } from '@nestjs/common';
import { AdminSessionGuard } from '../admin/admin-session.guard';
import { AdminSession, Roles, type AdminSessionContext } from '../admin/roles.decorator';
import { StaffService } from './staff.service';

/**
 * Owner-only: every route here sits behind both AdminSessionGuard and
 * @Roles('owner') at the controller level, same shape as
 * settings.controller.ts — staff sessions get 403 FORBIDDEN_ROLE before any
 * handler runs.
 *
 * Route registration order matters: `invites/:id` is declared before the
 * bare `:userId` route so Express doesn't match "invites" itself as a
 * userId on a DELETE to /v1/admin/staff/invites/<id>.
 */
@Controller('v1/admin/staff')
@UseGuards(AdminSessionGuard)
@Roles('owner')
export class StaffController {
  // Explicit @Inject: esbuild (vitest's default TS transform) does not emit
  // TypeScript's `design:paramtypes` decorator metadata, so Nest's implicit
  // constructor-injection cannot resolve StaffService by type alone (same
  // caution as AdminSessionGuard's constructor).
  constructor(@Inject(StaffService) private readonly staff: StaffService) {}

  @Post('invites')
  async invite(@AdminSession() session: AdminSessionContext, @Body() body: unknown) {
    return this.staff.createInvite(session, body);
  }

  @Get()
  async list(@AdminSession() session: AdminSessionContext) {
    return this.staff.listStaff(session);
  }

  @Delete('invites/:id')
  @HttpCode(204)
  async revokeInvite(@AdminSession() session: AdminSessionContext, @Param('id') id: string) {
    await this.staff.revokeInvite(session, id);
  }

  @Delete(':userId')
  @HttpCode(204)
  async remove(@AdminSession() session: AdminSessionContext, @Param('userId') userId: string) {
    await this.staff.removeStaff(session, userId);
  }
}
