import { Injectable, HttpException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { tenantDb, type TaxRate as PrismaTaxRate } from '@ventia/db';
import type { TaxRateValue } from '@ventia/core';

// Same DB-enum-to-human-string translation as catalog/products.service.ts's
// TAX_RATE_FROM_DB (duplicated locally, matching this codebase's established
// per-module-copy convention for this exact 4-line map — see also
// storefront/products.service.ts's own copy).
const TAX_RATE_FROM_DB: Record<PrismaTaxRate, TaxRateValue> = {
  ZERO: '0',
  FIVE: '5',
  NINETEEN: '19',
  EXCLUIDO: 'excluido',
};

// Decimal form of each human-facing rate, used only for the tax-portion
// math below. 'excluido' behaves like 0 — no tax portion.
const TAX_RATE_DECIMAL: Record<TaxRateValue, number> = {
  '0': 0,
  '5': 0.05,
  '19': 0.19,
  excluido: 0,
};

export interface CartLineDto {
  id: string;
  productId: string;
  variantId: string | null;
  qty: number;
  name: string;
  priceCents: number;
  taxRate: TaxRateValue;
  lineSubtotalCents: number;
  lineTaxCents: number;
}

export interface CartDto {
  cookieKey: string | null;
  lines: CartLineDto[];
  subtotalCents: number;
  taxCents: number;
}

const EMPTY_CART: CartDto = { cookieKey: null, lines: [], subtotalCents: 0, taxCents: 0 };

interface CartItemRow {
  id: string;
  productId: string;
  variantId: string | null;
  qty: number;
}

@Injectable()
export class CartService {
  async getOrEmpty(tenantId: string, cookieKey: string | null): Promise<CartDto> {
    if (!cookieKey) return EMPTY_CART;
    const db = tenantDb(tenantId);
    const cart = await db.cart.findFirst({ where: { tenantId, cookieKey }, include: { items: true } });
    if (!cart) return EMPTY_CART;
    return this.buildDto(tenantId, cart.cookieKey, cart.items);
  }

  /**
   * Hands the shopper a cart the AGENT built, so the `/carrito?c=…` link
   * `create_cart_link` returns actually opens something.
   *
   * ## Why only `source: 'agent'` carts can be adopted this way
   *
   * A cookie key IS the bearer token for a cart — that is what the
   * `ventia_cart` cookie holds — so adopting one by URL is no weaker than
   * having the cookie. But a URL is far more likely to leak than an HttpOnly
   * cookie: it lands in browser history, in a shared WhatsApp message, in a
   * referrer header. Restricting adoption to carts the agent itself created
   * means a key that escapes some OTHER way (a log line, a copied cookie)
   * still cannot be turned into a working link. Nothing is lost by the
   * restriction: agent carts are the only ones a link is ever emitted for.
   *
   * Returns `null` when there is nothing to adopt — a stale link, a key from
   * another store, or a shopper's own web cart. The caller renders that as
   * "this link expired" rather than an error, and importantly does NOT clear
   * whatever cart the shopper already had.
   */
  async adopt(tenantId: string, cookieKey: string): Promise<CartDto | null> {
    const db = tenantDb(tenantId);
    const cart = await db.cart.findFirst({
      where: { tenantId, cookieKey, source: 'agent' },
      include: { items: true },
    });
    if (!cart) return null;
    return this.buildDto(tenantId, cart.cookieKey, cart.items);
  }

  async addItem(
    tenantId: string,
    cookieKey: string | null,
    productId: string,
    variantId: string | null,
    qty: number,
  ): Promise<CartDto & { cookieKey: string }> {
    const db = tenantDb(tenantId);

    const product = await db.product.findFirst({ where: { id: productId, status: 'active' } });
    if (!product) throw new HttpException({ error: 'PRODUCT_NOT_FOUND' }, 404);
    if (variantId) {
      // Must belong to THIS product — a variant id from a different product
      // must 404, not silently succeed.
      const variant = await db.productVariant.findFirst({ where: { id: variantId, productId } });
      if (!variant) throw new HttpException({ error: 'PRODUCT_NOT_FOUND' }, 404);
    }

    // Cart is created lazily here (not by the guard) — only the first item
    // add ever writes a Cart row for a given cookie.
    let cart = cookieKey ? await db.cart.findFirst({ where: { tenantId, cookieKey } }) : null;
    if (!cart) {
      cart = await db.cart.create({
        // `source: 'web'` (a human built it) and `channel: 'web'` (they were on
        // the storefront) are both the column default; spelled out because this
        // is the site the other two cart creators are read against.
        data: { tenantId, cookieKey: randomUUID(), source: 'web', channel: 'web' },
      });
    }

    const existingLine = await db.cartItem.findFirst({
      where: { cartId: cart.id, productId, variantId },
    });
    if (existingLine) {
      await db.cartItem.update({ where: { id: existingLine.id }, data: { qty: existingLine.qty + qty } });
    } else {
      await db.cartItem.create({ data: { tenantId, cartId: cart.id, productId, variantId, qty } });
    }

    const items = await db.cartItem.findMany({ where: { cartId: cart.id } });
    const dto = await this.buildDto(tenantId, cart.cookieKey, items);
    return { ...dto, cookieKey: cart.cookieKey };
  }

  async updateItem(tenantId: string, cookieKey: string, itemId: string, qty: number): Promise<CartDto> {
    const db = tenantDb(tenantId);
    const cart = await db.cart.findFirst({ where: { tenantId, cookieKey } });
    if (!cart) throw new HttpException({ error: 'NOT_FOUND' }, 404);
    // Explicit cartId match — never let one cart mutate another's items even
    // if an item id from elsewhere is guessed (tenantDb's scoping already
    // prevents cross-TENANT reach; this additionally prevents cross-CART
    // reach within the same tenant).
    const item = await db.cartItem.findFirst({ where: { id: itemId, cartId: cart.id } });
    if (!item) throw new HttpException({ error: 'NOT_FOUND' }, 404);
    await db.cartItem.update({ where: { id: itemId }, data: { qty } });
    return this.getOrEmpty(tenantId, cookieKey);
  }

  async removeItem(tenantId: string, cookieKey: string, itemId: string): Promise<CartDto> {
    const db = tenantDb(tenantId);
    const cart = await db.cart.findFirst({ where: { tenantId, cookieKey } });
    if (!cart) throw new HttpException({ error: 'NOT_FOUND' }, 404);
    const item = await db.cartItem.findFirst({ where: { id: itemId, cartId: cart.id } });
    if (!item) throw new HttpException({ error: 'NOT_FOUND' }, 404);
    await db.cartItem.delete({ where: { id: itemId } });
    return this.getOrEmpty(tenantId, cookieKey);
  }

  private async buildDto(tenantId: string, cookieKey: string, items: CartItemRow[]): Promise<CartDto> {
    if (items.length === 0) return { cookieKey, lines: [], subtotalCents: 0, taxCents: 0 };

    const db = tenantDb(tenantId);
    const productIds = [...new Set(items.map((i) => i.productId))];
    const variantIds = [...new Set(items.map((i) => i.variantId).filter((v): v is string => v !== null))];

    const [products, variants] = await Promise.all([
      db.product.findMany({ where: { id: { in: productIds } } }),
      variantIds.length
        ? db.productVariant.findMany({ where: { id: { in: variantIds } } })
        : Promise.resolve([]),
    ]);
    const productById = new Map(products.map((p) => [p.id, p]));
    const variantById = new Map(variants.map((v) => [v.id, v]));

    let subtotalCents = 0;
    let taxCents = 0;
    const lines: CartLineDto[] = [];
    for (const item of items) {
      const product = productById.get(item.productId);
      // Product was deleted/archived (or otherwise no longer visible) since
      // it was added to this cart — skip rather than crash the cart read;
      // checkout re-validates every line's current state independently.
      if (!product) continue;
      const variant = item.variantId ? variantById.get(item.variantId) : undefined;
      const priceCents = variant?.priceCents ?? product.priceCents;
      const taxRate = TAX_RATE_FROM_DB[product.taxRate];
      const lineSubtotalCents = priceCents * item.qty;
      const rateDecimal = TAX_RATE_DECIMAL[taxRate];
      const lineTaxCents = lineSubtotalCents - Math.round(lineSubtotalCents / (1 + rateDecimal));
      subtotalCents += lineSubtotalCents;
      taxCents += lineTaxCents;
      lines.push({
        id: item.id,
        productId: item.productId,
        variantId: item.variantId,
        qty: item.qty,
        name: product.name,
        priceCents,
        taxRate,
        lineSubtotalCents,
        lineTaxCents,
      });
    }
    return { cookieKey, lines, subtotalCents, taxCents };
  }
}
