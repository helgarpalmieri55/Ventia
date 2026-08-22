import { Controller, Get, Inject, Query, UseGuards } from '@nestjs/common';
import { dashboardQuerySchema } from '@ventia/core';
import { AdminSessionGuard } from '../admin/admin-session.guard';
import { AdminSession, type AdminSessionContext } from '../admin/roles.decorator';
import { parseOr400 } from '../catalog/parse';
import { DashboardService } from './dashboard.service';

/**
 * `GET /v1/admin/dashboard` — the tablero of docs/design-gap.md §5, limited to
 * what today's schema can honestly answer.
 *
 * No `@Roles('owner')`, matching orders and payment alerts rather than
 * settings and staff. The tile that looks most like an owner-only fact —
 * total sales — is a sum over orders every staff member can already open one
 * by one on `/pedidos`, so gating this would hide the summary of information
 * the same session is free to page through. Nothing here is account
 * administration.
 */
@Controller('v1/admin/dashboard')
@UseGuards(AdminSessionGuard)
export class DashboardController {
  // Explicit @Inject: esbuild (vitest's default TS transform) does not emit
  // TypeScript's `design:paramtypes` metadata, so Nest cannot resolve
  // DashboardService by type alone — same caution as every other controller here.
  constructor(@Inject(DashboardService) private readonly dashboard: DashboardService) {}

  @Get()
  async summary(@AdminSession() session: AdminSessionContext, @Query() query: unknown) {
    // Parsed, not read field by field: an unparseable `from` must be a 400
    // rather than a window silently starting at the Unix epoch.
    return this.dashboard.summary(session.tenantId, parseOr400(dashboardQuerySchema, query));
  }
}
