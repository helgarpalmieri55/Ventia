import { Body, Controller, Get, HttpCode, HttpException, Inject, Patch, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { tenantDb } from '@ventia/db';
import {
  shopperConsumeTokenSchema,
  shopperEmailRequestSchema,
  shopperPasswordResetSchema,
  shopperProfileUpdateSchema,
  shopperRegisterSchema,
  shopperSignInSchema,
} from '@ventia/core';
import { parseOr400 } from '../catalog/parse';
import { PublicTenantGuard } from '../storefront/public-tenant.guard';
import { StorefrontTenantDomain, StorefrontTenantId } from '../storefront/storefront-tenant.decorator';
import { tenantStorefrontBaseUrl } from '../tenants/tenant-public-url';
import { CartService } from '../checkout/cart.service';
import { ShopperAuthService, type IssuedSession, type ShopperIdentity } from './shopper-auth.service';
import { SHOPPER_COOKIE_NAME, Shopper, ShopperSessionGuard, readShopperCookie } from './shopper-session.guard';

/** The cart cookie, read here so signing in can merge the basket the browser
 * is holding. Same name the cart controller sets — one constant would be
 * better, but it lives in a module this one must not import for a single
 * string. */
const CART_COOKIE_NAME = 'ventia_cart';
const CART_COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60_000;

/**
 * A shopper's own account at one store.
 *
 * ## Guest checkout is untouched
 *
 * Nothing here is required to buy. That was an explicit product decision:
 * requiring an account before a first purchase costs measurable conversion,
 * and for a small Colombian store that is the difference between a sale and
 * none. An account is a convenience — saved details, order history — offered
 * to people who want it.
 *
 * ## Signing in never costs the shopper their basket
 *
 * Every route that establishes a session merges the guest cart into the
 * account's (see `CartService.mergeOnSignIn`) and re-sets `ventia_cart`. The
 * requirement it serves is narrow and important: a shopper who reaches the
 * payment step, remembers they have an account, signs in, and finds an empty
 * cart has been handed a reason to abandon at the last screen.
 */
@Controller('v1/storefront/account')
@UseGuards(PublicTenantGuard)
export class ShopperController {
  // Explicit @Inject: esbuild (vitest's transform) emits no `design:paramtypes`.
  constructor(
    @Inject(ShopperAuthService) private readonly auth: ShopperAuthService,
    @Inject(CartService) private readonly carts: CartService,
  ) {}

  /**
   * 202, not 201: the account may or may not have been created, and this
   * endpoint deliberately does not say which. An address that is already
   * registered gets its OWNER an email instead — see `ShopperAuthService`.
   */
  @Post('register')
  @HttpCode(202)
  async register(
    @StorefrontTenantId() tenantId: string,
    @StorefrontTenantDomain() domain: string,
    @Body() body: unknown,
  ) {
    const input = parseOr400(shopperRegisterSchema, body);
    await this.auth.register(tenantId, input, tenantStorefrontBaseUrl(domain));
    return { ok: true };
  }

  @Post('sign-in')
  @HttpCode(200)
  async signIn(
    @StorefrontTenantId() tenantId: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const input = parseOr400(shopperSignInSchema, body);
    const result = await this.auth.signInWithPassword(tenantId, input);
    // One error for a wrong address and a wrong password alike. Distinguishing
    // them tells anyone which addresses shop here.
    if (!result.ok || !result.session || !result.identity) {
      throw new HttpException({ error: 'INVALID_CREDENTIALS' }, 401);
    }
    return this.establish(tenantId, result.identity, result.session, req, res);
  }

  /** Sends a sign-in link. Always 202, whether or not the address is
   * registered. */
  @Post('magic-link')
  @HttpCode(202)
  async magicLink(
    @StorefrontTenantId() tenantId: string,
    @StorefrontTenantDomain() domain: string,
    @Body() body: unknown,
  ) {
    const input = parseOr400(shopperEmailRequestSchema, body);
    await this.auth.requestMagicLink(tenantId, input.email, tenantStorefrontBaseUrl(domain));
    return { ok: true };
  }

  @Post('magic-link/consume')
  @HttpCode(200)
  async consumeMagicLink(
    @StorefrontTenantId() tenantId: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const input = parseOr400(shopperConsumeTokenSchema, body);
    const result = await this.auth.consumeMagicLink(tenantId, input.token);
    if (!result.ok || !result.session || !result.identity) {
      throw new HttpException({ error: 'LINK_INVALID' }, 400);
    }
    return this.establish(tenantId, result.identity, result.session, req, res);
  }

  /** Confirms an address. Does NOT sign the shopper in: a verification link is
   * proof of inbox access, and the click may well happen on a different device
   * from the one they registered on. */
  @Post('verify-email')
  @HttpCode(200)
  async verifyEmail(@StorefrontTenantId() tenantId: string, @Body() body: unknown) {
    const input = parseOr400(shopperConsumeTokenSchema, body);
    const verified = await this.auth.verifyEmail(tenantId, input.token);
    if (!verified) throw new HttpException({ error: 'LINK_INVALID' }, 400);
    return { ok: true };
  }

  @Post('password-reset')
  @HttpCode(202)
  async requestPasswordReset(
    @StorefrontTenantId() tenantId: string,
    @StorefrontTenantDomain() domain: string,
    @Body() body: unknown,
  ) {
    const input = parseOr400(shopperEmailRequestSchema, body);
    await this.auth.requestPasswordReset(tenantId, input.email, tenantStorefrontBaseUrl(domain));
    return { ok: true };
  }

  @Post('password-reset/consume')
  @HttpCode(200)
  async consumePasswordReset(
    @StorefrontTenantId() tenantId: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const input = parseOr400(shopperPasswordResetSchema, body);
    const result = await this.auth.consumePasswordReset(tenantId, input.token, input.password);
    if (!result.ok || !result.session || !result.identity) {
      throw new HttpException({ error: 'LINK_INVALID' }, 400);
    }
    return this.establish(tenantId, result.identity, result.session, req, res);
  }

  /** Always 204, even with no session or an expired one: the desired state is
   * "not signed in", and it has been reached either way. */
  @Post('sign-out')
  @HttpCode(204)
  async signOut(
    @StorefrontTenantId() tenantId: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const secret = readShopperCookie(req);
    if (secret) await this.auth.signOut(tenantId, secret);
    res.clearCookie(SHOPPER_COOKIE_NAME, { httpOnly: true, sameSite: 'lax' });
  }

  @Get('me')
  @UseGuards(ShopperSessionGuard)
  me(@Shopper() shopper: ShopperIdentity) {
    return publicIdentity(shopper);
  }

  @Patch('me')
  @UseGuards(ShopperSessionGuard)
  async updateMe(
    @StorefrontTenantId() tenantId: string,
    @Shopper() shopper: ShopperIdentity,
    @Body() body: unknown,
  ) {
    const input = parseOr400(shopperProfileUpdateSchema, body);
    const updated = await this.auth.updateProfile(tenantId, shopper.accountId, input.name);
    return publicIdentity(updated);
  }

  /**
   * The shopper's own orders.
   *
   * Gated on a VERIFIED address, not merely a session. The account is linked to
   * a `Customer` at registration by matching email, and that match is not proof
   * of anything on its own — anyone can register with someone else's address.
   * Requiring verification means the person reading a stranger's order history
   * would first have to read the stranger's email, at which point the order
   * history is the smaller problem.
   */
  @Get('orders')
  @UseGuards(ShopperSessionGuard)
  async orders(@StorefrontTenantId() tenantId: string, @Shopper() shopper: ShopperIdentity) {
    if (!shopper.emailVerified) throw new HttpException({ error: 'EMAIL_NOT_VERIFIED' }, 403);
    if (!shopper.customerId) return { orders: [] };

    const orders = await tenantDb(tenantId).order.findMany({
      where: { tenantId, customerId: shopper.customerId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true,
        number: true,
        status: true,
        paymentStatus: true,
        totalCents: true,
        createdAt: true,
      },
    });
    return { orders };
  }

  /**
   * Sets the session cookie and reconciles the cart, the two things every
   * successful sign-in path has to do identically.
   *
   * `secure` follows the resolved scheme rather than being hardcoded: the dev
   * stack serves `*.ventia.localhost` over plain HTTP, and a `secure` cookie
   * there is silently dropped by the browser — which looks exactly like a
   * broken login and is very hard to diagnose.
   */
  private async establish(
    tenantId: string,
    identity: ShopperIdentity,
    session: IssuedSession,
    req: Request,
    res: Response,
  ) {
    const guestCartKey = (req.cookies as Record<string, unknown> | undefined)?.[CART_COOKIE_NAME];
    const cartKey = await this.carts.mergeOnSignIn(
      tenantId,
      identity.accountId,
      typeof guestCartKey === 'string' && guestCartKey.length > 0 ? guestCartKey : null,
    );

    res.cookie(SHOPPER_COOKIE_NAME, session.secret, {
      httpOnly: true,
      sameSite: 'lax',
      secure: req.protocol === 'https',
      expires: session.expiresAt,
    });
    if (cartKey) {
      res.cookie(CART_COOKIE_NAME, cartKey, {
        httpOnly: true,
        sameSite: 'lax',
        maxAge: CART_COOKIE_MAX_AGE_MS,
      });
    }

    return { shopper: publicIdentity(identity), cart: await this.carts.getOrEmpty(tenantId, cartKey) };
  }
}

/** What the storefront may see. `accountId` and `customerId` are internal ids
 * with no use in a browser, and `tenantId` is already implied by the host. */
function publicIdentity(shopper: ShopperIdentity) {
  return { email: shopper.email, name: shopper.name, emailVerified: shopper.emailVerified };
}
