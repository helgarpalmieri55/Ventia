import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import {
  assignPlanSchema,
  platformTenantIdSchema,
  platformTenantListQuerySchema,
  reactivateTenantSchema,
  suspendTenantSchema,
} from '@ventia/core';
import { parseOr400 } from '../catalog/parse';
import { PlatformAdminGuard } from './platform-admin.guard';
import { PlatformOperator, type PlatformOperatorContext } from './platform-operator.decorator';
import { PlatformService } from './platform.service';

/**
 * Ventia's own back office (docs/SPEC.md §6 M9, phase P6): the operator's
 * view ACROSS merchants, as opposed to `/v1/admin/*`, which is one merchant's
 * view of themselves.
 *
 * The route prefix is `v1/platform`, disjoint from `v1/admin`, and the guard
 * is `PlatformAdminGuard`, which shares nothing with `AdminSessionGuard` —
 * not the session shape, not the role model, not the failure modes. That
 * separation is deliberate and load-bearing: there is no combination of
 * merchant-grantable state that turns an `/v1/admin` session into an
 * `/v1/platform` one. See `platform-admin.guard.ts` for the full argument.
 *
 * ## Impersonation is deliberately NOT here
 *
 * SPEC §6 M9 also lists "impersonate (banner shown, every action audit-
 * logged)", with an acceptance criterion that such sessions expire in 30
 * minutes. It is out of scope for this change on purpose. Impersonation means
 * minting a session that a merchant's own guards accept, which is a new
 * credential type with its own expiry, its own revocation, its own audit
 * semantics, and its own blast radius if the mint is reachable by anything
 * other than a verified operator — the exact class of design that should not
 * be smuggled in alongside a CRUD surface. It needs its own design review.
 * Everything M9 lists for READ-ONLY diagnosis (plan, status, GMV, AI usage,
 * limits drift) is here, which covers most of what an operator opens an
 * impersonated session to find out.
 */
@Controller('v1/platform')
@UseGuards(PlatformAdminGuard)
export class PlatformController {
  // Explicit @Inject: esbuild does not emit `design:paramtypes`.
  constructor(@Inject(PlatformService) private readonly platform: PlatformService) {}

  /** List + search + filter + page. Each row carries plan, status, GMV and
   * month-to-date AI usage, so the operator's first screen answers "who is
   * big, who is stuck, who is burning budget" without a detail click. */
  @Get('tenants')
  listTenants(@Query() query: Record<string, unknown>) {
    return this.platform.listTenants(parseOr400(platformTenantListQuerySchema, query));
  }

  @Get('tenants/:id')
  getTenant(@Param('id') id: string) {
    return this.platform.getTenant(parseOr400(platformTenantIdSchema, id));
  }

  /** Assigns a plan AND rewrites `TenantLimits` to match, in one transaction
   * — see `PlatformService#assignPlan` for why the two can never be allowed
   * to diverge. */
  @Patch('tenants/:id/plan')
  assignPlan(
    @Param('id') id: string,
    @Body() body: unknown,
    @PlatformOperator() operator: PlatformOperatorContext,
  ) {
    const tenantId = parseOr400(platformTenantIdSchema, id);
    const { plan, note } = parseOr400(assignPlanSchema, body);
    return this.platform.assignPlan(tenantId, plan, note, operator);
  }

  /** 200 rather than 201: this changes an existing tenant, it does not create
   * a resource. POST rather than PATCH because "suspend" is an action with
   * side effects beyond the field it sets (it clears the storefront's
   * resolver cache), not a field assignment. */
  @Post('tenants/:id/suspend')
  @HttpCode(200)
  suspend(
    @Param('id') id: string,
    @Body() body: unknown,
    @PlatformOperator() operator: PlatformOperatorContext,
  ) {
    const tenantId = parseOr400(platformTenantIdSchema, id);
    const { reason } = parseOr400(suspendTenantSchema, body);
    return this.platform.suspend(tenantId, reason, operator);
  }

  @Post('tenants/:id/reactivate')
  @HttpCode(200)
  reactivate(
    @Param('id') id: string,
    @Body() body: unknown,
    @PlatformOperator() operator: PlatformOperatorContext,
  ) {
    const tenantId = parseOr400(platformTenantIdSchema, id);
    // Body is optional on this route — an empty POST is a perfectly good
    // "undo the suspension", unlike suspending, which requires a reason.
    const { note } = parseOr400(reactivateTenantSchema, body ?? {});
    return this.platform.reactivate(tenantId, note, operator);
  }
}
