import { CanActivate, ExecutionContext, HttpException, Inject, Injectable, createParamDecorator } from '@nestjs/common';
import type { Request } from 'express';
import { ShopperAuthService, type ShopperIdentity } from './shopper-auth.service';

/** Name of the shopper's session cookie. Distinct from the merchant session
 * (better-auth's) and from `ventia_cart`: a browser can legitimately hold all
 * three at once — a merchant testing their own store while signed in as a
 * shopper is a real thing people do. */
export const SHOPPER_COOKIE_NAME = 'ventia_shopper';

export type RequestWithShopper = Request & { shopper?: ShopperIdentity; shopperSessionSecret?: string };

/**
 * Requires a signed-in shopper, scoped to the store this request resolved to.
 *
 * Must be used TOGETHER with `PublicTenantGuard`, which is what sets
 * `storefrontTenantId`. The tenant is not optional here: sessions are per
 * store, and resolving one without a tenant would authenticate a shopper at
 * whichever storefront they happened to present the cookie to.
 */
@Injectable()
export class ShopperSessionGuard implements CanActivate {
  // Explicit @Inject: esbuild (vitest's transform) emits no `design:paramtypes`.
  constructor(@Inject(ShopperAuthService) private readonly auth: ShopperAuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithShopper>();
    const tenantId = request.storefrontTenantId;
    const secret = readShopperCookie(request);
    if (typeof tenantId !== 'string' || secret === null) throw unauthorized();

    const shopper = await this.auth.resolveSession(tenantId, secret);
    if (!shopper) throw unauthorized();

    request.shopper = shopper;
    request.shopperSessionSecret = secret;
    return true;
  }
}

/** The session cookie's raw value, or `null`. Exported so the sign-out route —
 * which must work whether or not the session still resolves — can read it
 * without going through the guard. */
export function readShopperCookie(request: Request): string | null {
  const raw = (request.cookies as Record<string, unknown> | undefined)?.[SHOPPER_COOKIE_NAME];
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

/** 401 with no detail. "No session", "expired session" and "session for another
 * store" are deliberately the same answer: the differences are only useful to
 * someone probing. */
function unauthorized(): HttpException {
  return new HttpException({ error: 'SHOPPER_UNAUTHORIZED' }, 401);
}

/** The signed-in shopper on a route behind {@link ShopperSessionGuard}.
 * Non-null by construction — the guard throws before the handler runs. */
export const Shopper = createParamDecorator((_: unknown, ctx: ExecutionContext): ShopperIdentity => {
  return ctx.switchToHttp().getRequest<RequestWithShopper>().shopper as ShopperIdentity;
});
