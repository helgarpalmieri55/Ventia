import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

export const StorefrontTenantId = createParamDecorator((_: unknown, ctx: ExecutionContext): string => {
  const req = ctx.switchToHttp().getRequest<Request>();
  return req.storefrontTenantId as string;
});

/** The PUBLIC domain this request's tenant was resolved through — the
 * `TenantDomain.domain` row `DomainResolver` matched, set by
 * `PublicTenantGuard` right beside `storefrontTenantId`.
 *
 * Same non-null contract as `StorefrontTenantId` above and for the same
 * reason: both are only ever read on routes behind `PublicTenantGuard`, which
 * throws before the handler runs if no tenant resolved.
 *
 * Used by the checkout route to build the tenant's own public storefront base
 * URL (`tenants/tenant-public-url.ts`), which the Wompi/ePayco adapters need
 * so a shopper is returned to the storefront they actually checked out on. */
export const StorefrontTenantDomain = createParamDecorator((_: unknown, ctx: ExecutionContext): string => {
  const req = ctx.switchToHttp().getRequest<Request>();
  return req.storefrontTenantDomain as string;
});
