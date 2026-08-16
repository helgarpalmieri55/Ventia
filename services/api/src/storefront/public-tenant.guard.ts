import { CanActivate, ExecutionContext, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import type { Request } from 'express';

@Injectable()
export class PublicTenantGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    // A missing tenant and a `draft` tenant (mid-onboarding, not yet launched)
    // must be indistinguishable from the outside: both 404 with the same
    // generic error, so an anonymous prober can't learn that a business
    // exists at this domain before its merchant has launched it.
    if (!req.tenant || req.tenant.status === 'draft') {
      throw new NotFoundException({ error: 'TENANT_NOT_FOUND' });
    }
    if (req.tenant.status === 'suspended') {
      throw new HttpException({ error: 'TENANT_SUSPENDED' }, 503);
    }
    req.storefrontTenantId = req.tenant.tenantId;
    // Set alongside the id, from the same already-resolved tenant, so routes
    // that need the tenant's PUBLIC domain (today: checkout, to build the
    // payment adapters' per-tenant browser return URLs) read it through the
    // same guard-then-decorator path as the id rather than re-deriving it from
    // request headers — one resolution mechanism, not two. It is the
    // `TenantDomain.domain` row `DomainResolver` matched, never the raw header.
    req.storefrontTenantDomain = req.tenant.domain;
    return true;
  }
}
