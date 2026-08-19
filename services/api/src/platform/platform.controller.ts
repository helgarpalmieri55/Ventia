import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  assignPlanSchema,
  impersonateTenantSchema,
  platformTenantIdSchema,
  platformTenantListQuerySchema,
  reactivateTenantSchema,
  recordSubscriptionSchema,
  suspendTenantSchema,
} from '@ventia/core';
import { parseOr400 } from '../catalog/parse';
import { IMPERSONATION_COOKIE, impersonationCookieOptions } from '../auth/impersonation';
import { ImpersonationService } from './impersonation.service';
import { PlatformAdminGuard } from './platform-admin.guard';
import { PlatformOperator, type PlatformOperatorContext } from './platform-operator.decorator';
import { PlatformService } from './platform.service';
import { SubscriptionService } from './subscription.service';

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
 * ## Impersonation
 *
 * Now here, designed rather than discovered:
 * docs/superpowers/specs/2026-08-19-impersonation-design.md. The earlier
 * version of this comment said impersonation "means minting a session that a
 * merchant's own guards accept" — that is exactly the option the design
 * REJECTED, and rejecting it is what made the feature buildable. Nothing is
 * minted for the merchant: the operator's own session is never replaced, and
 * `POST tenants/:id/impersonate` hands back a signed, self-expiring, operator-
 * bound SCOPE instead of a credential. `getSessionContext` keeps returning
 * the operator's `userId`, so every audit row written during an impersonation
 * names the operator, with no change to any call site.
 *
 * Everything M9 lists for READ-ONLY diagnosis (plan, status, GMV, AI usage,
 * limits drift) is still here too, and still covers most of what an operator
 * would otherwise open an impersonated session to find out — which is why the
 * write allow-list inside an impersonated session can start empty (design §4).
 */
@Controller('v1/platform')
@UseGuards(PlatformAdminGuard)
export class PlatformController {
  // Explicit @Inject: esbuild does not emit `design:paramtypes`.
  constructor(
    @Inject(PlatformService) private readonly platform: PlatformService,
    @Inject(SubscriptionService) private readonly subscriptions: SubscriptionService,
    @Inject(ImpersonationService) private readonly impersonation: ImpersonationService,
  ) {}

  /**
   * Who the operator is, from `PlatformAdminGuard`'s own context.
   *
   * It exists because `/v1/admin/me` is the wrong question on this surface: a
   * Ventia operator with no store of their own has no `Membership`, so
   * `AdminSessionGuard` answers `NO_TENANT` 403 and the console header has
   * nothing to render. "Which account am I acting as" matters most precisely
   * here, on the surface where the actions land on other companies.
   *
   * `{ userId, email }` and nothing else — the same two fields the guard
   * already proved. No plan, no tenant, no membership: this endpoint must not
   * become a place where platform authority acquires shape it did not have.
   */
  @Get('me')
  me(@PlatformOperator() operator: PlatformOperatorContext): PlatformOperatorContext {
    return { userId: operator.userId, email: operator.email };
  }

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

  // ---- subscription tracking (SPEC §6 M9, v1 manual) --------------------

  /** The subscription panel on its own. 200 with `subscription: null` when
   * nothing has been recorded — see `SubscriptionService.get`. */
  @Get('tenants/:id/subscription')
  getSubscription(@Param('id') id: string) {
    return this.subscriptions.get(parseOr400(platformTenantIdSchema, id));
  }

  /**
   * Record or update the tenant's subscription — plan, price, paid-until,
   * notes (SPEC §6 M9). There is no payment processor behind this: an operator
   * saw the transfer land and is writing down until when the merchant is paid
   * up. That date is what the auto-suspend sweep enforces.
   *
   * PUT rather than PATCH, and rather than POST: exactly one subscription
   * exists per tenant, the body describes all of it, and sending the same body
   * twice leaves the same state — which is the definition of PUT and a
   * property worth having on a surface where a retried request must not create
   * a second billing record. See `recordSubscriptionSchema` for why a partial
   * update would be dangerous on this particular resource.
   */
  @Put('tenants/:id/subscription')
  recordSubscription(
    @Param('id') id: string,
    @Body() body: unknown,
    @PlatformOperator() operator: PlatformOperatorContext,
  ) {
    const tenantId = parseOr400(platformTenantIdSchema, id);
    const input = parseOr400(recordSubscriptionSchema, body);
    return this.subscriptions.record(tenantId, input, operator);
  }

  // ---- impersonation (SPEC §6 M9; design doc 2026-08-19) -----------------

  /**
   * Begin acting inside a merchant's store.
   *
   * 200, not 201: nothing is created that has a URL. The response body is the
   * banner's first render (design §5) and the `Set-Cookie` is the grant.
   *
   * The cookie is set HERE rather than in the service so the service stays a
   * pure "audit then sign" step with no HTTP in it, and so the attributes
   * (`HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` outside dev — see
   * `impersonationCookieOptions`) sit next to the only other place cookies are
   * written in this codebase's controllers.
   */
  @Post('tenants/:id/impersonate')
  @HttpCode(200)
  async impersonate(
    @Param('id') id: string,
    @Body() body: unknown,
    @PlatformOperator() operator: PlatformOperatorContext,
    @Res({ passthrough: true }) res: Response,
  ) {
    const tenantId = parseOr400(platformTenantIdSchema, id);
    const { reason } = parseOr400(impersonateTenantSchema, body ?? {});
    const { token, maxAgeMs, impersonation } = await this.impersonation.start(tenantId, reason, operator);
    res.cookie(IMPERSONATION_COOKIE, token, impersonationCookieOptions(maxAgeMs));
    return { impersonation };
  }

  /**
   * Stop. The UI calls this on *Salir*; the token expiring on its own is the
   * backstop rather than the mechanism (design §3).
   *
   * Idempotent, and deliberately does not require that a grant currently
   * exists: "make sure I am not impersonating" must always succeed, including
   * from a tab whose grant already expired.
   */
  @Delete('tenants/:id/impersonate')
  @HttpCode(200)
  async endImpersonation(
    @Param('id') id: string,
    @PlatformOperator() operator: PlatformOperatorContext,
    @Res({ passthrough: true }) res: Response,
  ) {
    const tenantId = parseOr400(platformTenantIdSchema, id);
    // Same attributes as the `Set-Cookie` that created it. A `clearCookie`
    // whose Path or SameSite differs from the original does not clear
    // anything — the browser treats it as a different cookie — which would
    // leave the operator inside the store while the UI showed them out.
    res.clearCookie(IMPERSONATION_COOKIE, impersonationCookieOptions());
    return this.impersonation.end(tenantId, operator);
  }
}
