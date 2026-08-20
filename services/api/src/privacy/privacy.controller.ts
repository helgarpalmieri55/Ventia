import { Body, Controller, Get, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import { anonymizeCustomerSchema, customerListQuerySchema } from '@ventia/core';
import { AdminSessionGuard } from '../admin/admin-session.guard';
import { AdminSession, Roles, type AdminSessionContext } from '../admin/roles.decorator';
import { assertUuidOr404 } from '../catalog/uuid';
import { parseOr400 } from '../catalog/parse';
import { PrivacyService } from './privacy.service';

/**
 * Mounted at `/v1/admin/customers` rather than `/v1/admin/privacy` because
 * that is where a merchant looks for a customer: SPEC §6 M8 lists "Customers
 * (auto-created from orders; name, contact, order history)" as a first-class
 * admin section, and the supresión action belongs on the record it destroys,
 * not in a separate compliance corner nobody opens. The MODULE is named for
 * the obligation (Ley 1581, SPEC §9); the ROUTE is named for the noun.
 *
 * Roles: reading the customer list is fulfilment work, so both `owner` and
 * `staff` reach it (same call as `/v1/admin/orders`, which has no `@Roles`).
 * Anonymizing is irreversible, legally consequential, and taken on behalf of
 * the business — `@Roles('owner')` on that handler only. The handler-level
 * decorator wins over the (absent) class-level one via
 * `Reflector.getAllAndOverride([handler, class])` in AdminSessionGuard.
 *
 * `AdminSessionGuard` additionally rejects every non-GET on a suspended
 * tenant, so a suspended store cannot anonymize either — deliberate: the
 * request should be honoured, but a suspended tenant is a frozen tenant, and
 * unfreezing is a support conversation.
 */
@Controller('v1/admin/customers')
@UseGuards(AdminSessionGuard)
export class PrivacyController {
  // Explicit @Inject: esbuild (vitest's TS transform) does not emit
  // `design:paramtypes`, so Nest's implicit constructor injection cannot
  // resolve PrivacyService by type alone — same caution as StaffController.
  constructor(@Inject(PrivacyService) private readonly privacy: PrivacyService) {}

  @Get()
  async list(@AdminSession() session: AdminSessionContext, @Query() query: unknown) {
    return this.privacy.list(session.tenantId, parseOr400(customerListQuerySchema, query));
  }

  @Get(':id')
  async findOne(@AdminSession() session: AdminSessionContext, @Param('id') id: string) {
    assertUuidOr404(id);
    return this.privacy.findOne(session.tenantId, id);
  }

  /**
   * Ley 1581 de 2012 — supresión. Irreversible.
   *
   * POST rather than DELETE: nothing is deleted, and `DELETE /customers/:id`
   * would promise exactly the thing this endpoint refuses to do (the orders
   * and their amounts survive by legal requirement).
   */
  @Post(':id/anonymize')
  @Roles('owner')
  async anonymize(
    @AdminSession() session: AdminSessionContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    assertUuidOr404(id);
    return this.privacy.anonymize(session, id, parseOr400(anonymizeCustomerSchema, body));
  }
}
