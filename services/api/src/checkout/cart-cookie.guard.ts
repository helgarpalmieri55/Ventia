import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { tenantDb } from '@ventia/db';

const CART_COOKIE_NAME = 'ventia_cart';

/**
 * Mirrors PublicTenantGuard's shape but resolves a different piece of
 * request state: whether the `ventia_cart` cookie (if any) points at a real
 * Cart row for THIS tenant. Applied alongside PublicTenantGuard (which must
 * run first — see @UseGuards ordering on CartController) since this guard
 * reads req.storefrontTenantId directly off the request rather than via the
 * @StorefrontTenantId() decorator (that decorator only works as a
 * controller-method parameter, not inside another guard).
 *
 * Never throws: an absent or stale/tampered cookie is normal state, handled
 * per-route (not at the guard level). In particular this guard must never
 * let a cookie value resolve to a DIFFERENT tenant's cart — tenantDb's
 * scoping plus the explicit tenantId in the query below already guarantees
 * that (a cookieKey that's real for tenant A simply doesn't exist in tenant
 * B's row set), but see cart.test.ts for an explicit proof.
 *
 * Never creates a Cart row itself — only CartService.addItem does that, so
 * a GET-only visit never writes to the DB.
 */
@Injectable()
export class CartCookieGuard implements CanActivate {
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const tenantId = req.storefrontTenantId as string;
    const cookieKey = req.cookies?.[CART_COOKIE_NAME] as string | undefined;

    if (!cookieKey) {
      req.cartCookieKey = null;
      return true;
    }

    const cart = await tenantDb(tenantId).cart.findFirst({ where: { tenantId, cookieKey } });
    req.cartCookieKey = cart ? cookieKey : null;
    return true;
  }
}
