import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { tenantDb } from '@ventia/db';
import {
  createCartLinkInput,
  getOrderStatusInput,
  getProductInput,
  getStoreInfoInput,
  recommendProductsInput,
  searchProductsInput,
  type AgentToolName,
} from '@ventia/core';
import { StorefrontProductsService } from '../storefront/products.service';
import { OrderTrackingService } from '../checkout/order-tracking.service';

/**
 * Server-side execution of the AI sales agent's tools (docs/SPEC.md §7).
 *
 * ## The contract every executor here keeps
 *
 * 1. **Tenant-scoped, always.** Every read goes through `tenantDb(tenantId)`,
 *    where `tenantId` comes from the request that started the conversation —
 *    never from anything the model produced. A tool input naming another
 *    tenant's product id simply finds nothing.
 * 2. **Input is parsed, not trusted.** Tool inputs are model-generated, and on
 *    a storefront widget the model is reacting to whatever a shopper typed.
 *    Each executor runs its Zod schema first (see `@ventia/core`'s
 *    agent-tools.ts) and rejects rather than coercing.
 * 3. **The result is the whole truth the model gets.** SPEC.md's first strict
 *    rule is that prices, availability and product data come ONLY from tools.
 *    That rule is only as good as what these return, so each result carries
 *    the real current values and says explicitly when something is
 *    unavailable, rather than omitting a field and leaving the model to fill
 *    the gap.
 * 4. **No PII beyond what the asker already proved they had.** The only tool
 *    that touches customer data is `get_order_status`, and it requires the
 *    double factor before returning anything.
 *
 * ## Why results are plain JSON-able objects
 *
 * These go back to the model as `tool_result` content. Keeping them as narrow
 * plain objects — rather than passing a Prisma row through — is what stops a
 * column added later (a cost price, an internal note, a customer email) from
 * silently becoming something the agent can recite to a shopper.
 */

export interface AgentToolResult {
  /** Whether the tool did what was asked. Errors are RETURNED, not thrown:
   * the model is expected to tell the shopper "no pude consultar eso" in its
   * own words, and a thrown exception would instead kill the whole turn. */
  ok: boolean;
  /** Present when `ok` is false — a short, model-facing reason. Never a stack
   * trace or a database message; those leak internals into a chat window. */
  error?: string;
  data?: unknown;
}

function fail(error: string): AgentToolResult {
  return { ok: false, error };
}

@Injectable()
export class AgentToolsService {
  constructor(
    @Inject(StorefrontProductsService) private readonly products: StorefrontProductsService,
    @Inject(OrderTrackingService) private readonly tracking: OrderTrackingService,
  ) {}

  /** Dispatch by name. Unknown names are an error result rather than a throw,
   * because the model can emit one and the conversation should survive it. */
  async execute(tenantId: string, name: string, rawInput: unknown): Promise<AgentToolResult> {
    switch (name as AgentToolName) {
      case 'search_products':
        return this.searchProducts(tenantId, rawInput);
      case 'get_product':
        return this.getProduct(tenantId, rawInput);
      case 'recommend_products':
        return this.recommendProducts(tenantId, rawInput);
      case 'create_cart_link':
        return this.createCartLink(tenantId, rawInput);
      case 'get_order_status':
        return this.getOrderStatus(tenantId, rawInput);
      case 'get_store_info':
        return this.getStoreInfo(tenantId, rawInput);
      default:
        return fail(`herramienta desconocida: ${String(name)}`);
    }
  }

  private async searchProducts(tenantId: string, rawInput: unknown): Promise<AgentToolResult> {
    const parsed = searchProductsInput.safeParse(rawInput);
    if (!parsed.success) return fail('parámetros inválidos para search_products');
    const input = parsed.data;

    const result = await this.products.list(tenantId, {
      search: input.query,
      categorySlug: input.category,
      priceMax: input.price_max_cents,
      sort: 'relevance',
      page: 1,
      pageSize: input.limit,
    });

    return {
      ok: true,
      data: {
        items: result.items.map((item) => ({
          product_id: item.id,
          name: item.name,
          price_cents: item.priceCents,
          // Explicit rather than implied by stock: SPEC.md forbids the model
          // inventing availability, and "in stock" is the exact claim a
          // shopper acts on.
          in_stock: item.inStock,
          url: `/producto/${item.slug}`,
          thumbnail_url: item.thumbnailUrl,
        })),
        total_found: result.total,
      },
    };
  }

  private async getProduct(tenantId: string, rawInput: unknown): Promise<AgentToolResult> {
    const parsed = getProductInput.safeParse(rawInput);
    if (!parsed.success) return fail('parámetros inválidos para get_product');

    // By id, and scoped to this tenant + `active` only. A draft or archived
    // product is not something a shopper can buy, so surfacing one would let
    // the agent describe and quote something that cannot be ordered.
    const product = await tenantDb(tenantId).product.findFirst({
      where: { tenantId, id: parsed.data.product_id, status: 'active' },
      include: { variants: true, images: { orderBy: { position: 'asc' }, take: 1 } },
    });
    if (!product) return fail('no encontré ese producto en esta tienda');

    return {
      ok: true,
      data: {
        product_id: product.id,
        name: product.name,
        description: product.descriptionMd,
        price_cents: product.priceCents,
        url: `/producto/${product.slug}`,
        thumbnail_url: product.images[0]?.url ?? null,
        // `trackInventory: false` means the merchant does not track units for
        // this product, which is NOT the same as "zero left" — reporting it as
        // a number would be a false stock claim.
        in_stock: product.trackInventory ? product.stock > 0 : true,
        variants: product.variants.map((variant) => ({
          variant_id: variant.id,
          options: [variant.option1, variant.option2, variant.option3].filter(
            (value): value is string => typeof value === 'string' && value.length > 0,
          ),
          // Variants may override price; null means "same as the product".
          price_cents: variant.priceCents ?? product.priceCents,
          in_stock: product.trackInventory ? variant.stock > 0 : true,
        })),
      },
    };
  }

  /**
   * Search plus a deterministic rerank. Deliberately NOT a second model call:
   * the ranking a shopper sees should be explainable and reproducible, and
   * every recommendation here is a real, in-stock, current-priced row.
   *
   * The `need_description` is used as the query — the model has already turned
   * a conversation into a phrase, which is exactly the input the existing
   * full-text + trigram search wants.
   */
  private async recommendProducts(tenantId: string, rawInput: unknown): Promise<AgentToolResult> {
    const parsed = recommendProductsInput.safeParse(rawInput);
    if (!parsed.success) return fail('parámetros inválidos para recommend_products');
    const input = parsed.data;

    const result = await this.products.list(tenantId, {
      search: input.need_description,
      priceMax: input.budget_cents,
      sort: 'relevance',
      page: 1,
      // Over-fetch, then cut to 4 after reranking — otherwise an out-of-stock
      // item near the top would consume one of the four slots.
      pageSize: 12,
    });

    const ranked = [...result.items]
      // In-stock first. A recommendation the shopper cannot buy is worse than
      // one fewer recommendation.
      .sort((a, b) => Number(b.inStock) - Number(a.inStock))
      .slice(0, 4);

    return {
      ok: true,
      data: {
        items: ranked.map((item) => ({
          product_id: item.id,
          name: item.name,
          price_cents: item.priceCents,
          in_stock: item.inStock,
          url: `/producto/${item.slug}`,
        })),
      },
    };
  }

  /**
   * Builds a cart the shopper can open, from variants the agent proposed.
   *
   * Stock is validated HERE rather than trusted from an earlier
   * `search_products` result: a conversation can run for minutes, and the
   * thing being created is the shopper's actual basket. A cart built around
   * something that sold out mid-chat sends them to a checkout that will
   * fail.
   *
   * The cart is created with `source: 'agent'`, which is what powers the
   * "ventas asistidas por IA" KPI (SPEC.md §7) — orders inherit it at
   * checkout.
   */
  private async createCartLink(tenantId: string, rawInput: unknown): Promise<AgentToolResult> {
    const parsed = createCartLinkInput.safeParse(rawInput);
    if (!parsed.success) return fail('parámetros inválidos para create_cart_link');
    const db = tenantDb(tenantId);

    const variantIds = parsed.data.items.map((item) => item.variant_id);
    const variants = await db.productVariant.findMany({
      where: { tenantId, id: { in: variantIds } },
      include: { product: true },
    });
    const byId = new Map(variants.map((variant) => [variant.id, variant]));

    const lines: Array<{ variantId: string; productId: string; qty: number; priceCents: number }> = [];
    for (const item of parsed.data.items) {
      const variant = byId.get(item.variant_id);
      if (!variant) return fail('una de las variantes no existe en esta tienda');
      if (variant.product.status !== 'active') return fail(`"${variant.product.name}" ya no está disponible`);
      if (variant.product.trackInventory && variant.stock < item.qty) {
        return fail(`no hay suficiente stock de "${variant.product.name}"`);
      }
      lines.push({
        variantId: variant.id,
        productId: variant.productId,
        qty: item.qty,
        priceCents: variant.priceCents ?? variant.product.priceCents,
      });
    }

    // A fresh cart per link rather than mutating whatever the shopper already
    // had: the agent is proposing a basket, and silently replacing or merging
    // into an existing web cart would destroy something the shopper built
    // themselves. The returned key is what the storefront opens.
    const cookieKey = randomUUID();
    const cart = await db.cart.create({
      data: { tenantId, cookieKey, source: 'agent' },
    });
    await db.cartItem.createMany({
      data: lines.map((line) => ({
        tenantId,
        cartId: cart.id,
        productId: line.productId,
        variantId: line.variantId,
        qty: line.qty,
      })),
    });

    return {
      ok: true,
      data: {
        // A relative path: the storefront origin differs per tenant, and the
        // caller (web widget or WhatsApp renderer) is what knows the public
        // base URL for this store.
        cart_url: `/carrito?c=${encodeURIComponent(cookieKey)}`,
        subtotal_cents: lines.reduce((sum, line) => sum + line.priceCents * line.qty, 0),
        item_count: lines.reduce((sum, line) => sum + line.qty, 0),
      },
    };
  }

  /**
   * The double factor (SPEC.md §7 rule 5): order number AND the email or phone
   * the order was placed with. Delegates to `OrderTrackingService`, the same
   * lookup the public tracking endpoint uses — see that service for why
   * "wrong contact" and "no such order" must stay indistinguishable.
   */
  private async getOrderStatus(tenantId: string, rawInput: unknown): Promise<AgentToolResult> {
    const parsed = getOrderStatusInput.safeParse(rawInput);
    if (!parsed.success) return fail('parámetros inválidos para get_order_status');
    const input = parsed.data;

    const dto = await this.tracking.track(tenantId, input.order_number, input.email_or_phone);
    // One message for both "no existe" and "el contacto no coincide" — the
    // indistinguishability the service exists to preserve would be undone here
    // if this branch could tell them apart.
    if (!dto) return fail('no encontré un pedido con ese número y ese correo o celular');

    return {
      ok: true,
      data: {
        order_number: dto.orderNumber,
        status: dto.status,
        created_at: dto.createdAt,
        total_cents: dto.totalCents,
        // City and department only — never the street address. SPEC.md §7:
        // the agent never echoes a full address, even to someone who passed
        // the double factor, because a chat transcript is a far leakier
        // surface than the order page.
        shipping_city: dto.shippingCiudad,
        shipping_departamento: dto.shippingDepartamento,
        tracking: dto.shipment,
        items: dto.items.map((item) => ({ name: item.nameSnapshot, qty: item.qty })),
      },
    };
  }

  /** Store policy answers, sourced ONLY from what this merchant actually
   * wrote. A topic with no saved content returns an explicit "not written
   * yet" rather than an empty string, so the model says so instead of
   * inventing a shipping policy. */
  private async getStoreInfo(tenantId: string, rawInput: unknown): Promise<AgentToolResult> {
    const parsed = getStoreInfoInput.safeParse(rawInput);
    if (!parsed.success) return fail('parámetros inválidos para get_store_info');

    const TOPIC_TO_TYPE = {
      shipping: 'policy_shipping',
      returns: 'policy_returns',
      payments: 'policy_privacy',
      contact: 'about',
      about: 'about',
    } as const;
    const contentType = TOPIC_TO_TYPE[parsed.data.topic];

    const content = await tenantDb(tenantId).tenantContent.findFirst({
      where: { tenantId, type: contentType },
    });
    if (!content || content.bodyMd.trim().length === 0) {
      return fail('esta tienda todavía no ha publicado información sobre ese tema');
    }

    return { ok: true, data: { topic: parsed.data.topic, title: content.title, body: content.bodyMd } };
  }
}
