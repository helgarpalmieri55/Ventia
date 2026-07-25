import { CanActivate, ExecutionContext, HttpException, Injectable, NotFoundException } from '@nestjs/common';

@Injectable()
export class PublicTenantGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    if (!req.tenant) throw new NotFoundException({ error: 'TENANT_NOT_FOUND' });
    if (req.tenant.status === 'suspended') {
      throw new HttpException({ error: 'TENANT_SUSPENDED' }, 503);
    }
    req.storefrontTenantId = req.tenant.tenantId;
    return true;
  }
}
