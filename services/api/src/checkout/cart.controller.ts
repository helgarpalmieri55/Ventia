import { Body, Controller, Delete, Get, HttpException, Inject, Param, Patch, Post, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { PublicTenantGuard } from '../storefront/public-tenant.guard';
import { StorefrontTenantId } from '../storefront/storefront-tenant.decorator';
import { CartCookieGuard } from './cart-cookie.guard';
import { CartCookieKey } from './cart-cookie.decorator';
import { CartService } from './cart.service';

const CART_COOKIE_NAME = 'ventia_cart';
const CART_COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days, a typical guest-cart lifetime

// Small hand-rolled validators for these two request-body shapes rather than
// a zod schema: this codebase deliberately avoids a direct `zod` dependency
// in @ventia/api (see catalog/parse.ts's ParsableSchema doc comment — adding
// `zod` directly here would shift pnpm's peer resolution for better-auth's
// zod v4 peer down to v3). Every zod schema this app parses against instead
// comes from @ventia/core, which isn't warranted for these two
// controller-local shapes.
interface AddItemInput {
  productId: string;
  variantId: string | null;
  qty: number;
}

function parseAddItemBody(body: unknown): AddItemInput {
  const b = (body ?? {}) as Record<string, unknown>;
  const details: Record<string, string> = {};
  if (typeof b.productId !== 'string' || b.productId.length === 0) {
    details.productId = 'productId es requerido';
  }
  if (b.variantId !== undefined && b.variantId !== null && typeof b.variantId !== 'string') {
    details.variantId = 'variantId inválido';
  }
  if (typeof b.qty !== 'number' || !Number.isInteger(b.qty) || b.qty <= 0) {
    details.qty = 'qty debe ser un entero positivo';
  }
  if (Object.keys(details).length > 0) {
    throw new HttpException({ error: 'VALIDATION_FAILED', details }, 400);
  }
  return {
    productId: b.productId as string,
    variantId: (b.variantId as string | undefined) ?? null,
    qty: b.qty as number,
  };
}

function parseUpdateItemBody(body: unknown): { qty: number } {
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.qty !== 'number' || !Number.isInteger(b.qty) || b.qty <= 0) {
    throw new HttpException({ error: 'VALIDATION_FAILED', details: { qty: 'qty debe ser un entero positivo' } }, 400);
  }
  return { qty: b.qty };
}

@Controller('v1/storefront/cart')
@UseGuards(PublicTenantGuard, CartCookieGuard)
export class CartController {
  // Explicit @Inject: esbuild (vitest's default TS transform) does not emit
  // TypeScript's `design:paramtypes` decorator metadata, so Nest's implicit
  // constructor-injection cannot resolve CartService by type alone (same
  // caution as every other controller in this codebase — see e.g.
  // catalog/products.controller.ts).
  constructor(@Inject(CartService) private readonly cartService: CartService) {}

  @Get()
  async getCart(@StorefrontTenantId() tenantId: string, @CartCookieKey() cookieKey: string | null) {
    return this.cartService.getOrEmpty(tenantId, cookieKey);
  }

  @Post('items')
  async addItem(
    @StorefrontTenantId() tenantId: string,
    @CartCookieKey() cookieKey: string | null,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const input = parseAddItemBody(body);
    const cart = await this.cartService.addItem(tenantId, cookieKey, input.productId, input.variantId, input.qty);
    // A cart is only just-created when the incoming cookie was null (a
    // brand-new cart always gets a fresh cookie value) — an existing cart
    // being added to again keeps its already-set cookie, no need to re-set it.
    if (cookieKey === null) {
      res.cookie(CART_COOKIE_NAME, cart.cookieKey, {
        httpOnly: true,
        sameSite: 'lax',
        maxAge: CART_COOKIE_MAX_AGE_MS,
      });
    }
    return cart;
  }

  /**
   * Adopts the cart behind an agent's `/carrito?c=<key>` link: the shopper
   * follows the link, the storefront posts the key here, and the response
   * sets `ventia_cart` to it so every later cart call — read, update,
   * checkout — sees the agent's basket.
   *
   * Deliberately NOT a GET: it changes which cart the browser owns, and a GET
   * that mutates state gets prefetched by browsers and link previewers. The
   * key travels in the body for the same reason the route is a POST.
   *
   * `CartCookieKey` is ignored here — that is the point. A shopper who
   * already has a cart and opens an agent link ends up on the agent's cart;
   * their previous one is left intact in the database rather than merged or
   * deleted, so nothing they built is destroyed by clicking a link.
   */
  @Post('adopt')
  async adopt(
    @StorefrontTenantId() tenantId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const b = (body ?? {}) as Record<string, unknown>;
    if (typeof b.cookieKey !== 'string' || b.cookieKey.length === 0) {
      throw new HttpException(
        { error: 'VALIDATION_FAILED', details: { cookieKey: 'cookieKey es requerido' } },
        400,
      );
    }

    const cart = await this.cartService.adopt(tenantId, b.cookieKey);
    // A stale or foreign key is a 404, the same answer as a link to a cart
    // that never existed — a caller must not be able to probe which keys are
    // real for this store.
    if (!cart) throw new HttpException({ error: 'CART_NOT_FOUND' }, 404);

    res.cookie(CART_COOKIE_NAME, b.cookieKey, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: CART_COOKIE_MAX_AGE_MS,
    });
    return cart;
  }

  @Patch('items/:id')
  async updateItem(
    @StorefrontTenantId() tenantId: string,
    @CartCookieKey() cookieKey: string | null,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    if (!cookieKey) throw new HttpException({ error: 'NOT_FOUND' }, 404);
    const input = parseUpdateItemBody(body);
    return this.cartService.updateItem(tenantId, cookieKey, id, input.qty);
  }

  @Delete('items/:id')
  async removeItem(
    @StorefrontTenantId() tenantId: string,
    @CartCookieKey() cookieKey: string | null,
    @Param('id') id: string,
  ) {
    if (!cookieKey) throw new HttpException({ error: 'NOT_FOUND' }, 404);
    return this.cartService.removeItem(tenantId, cookieKey, id);
  }
}
