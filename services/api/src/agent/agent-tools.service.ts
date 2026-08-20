import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { tenantDb } from '@ventia/db';
import {
  createCartLinkInput,
  escalateToHumanInput,
  getOrderStatusInput,
  getProductInput,
  getStoreInfoInput,
  recommendProductsInput,
  searchProductsInput,
  type AgentToolName,
} from '@ventia/core';
import { StorefrontProductsService } from '../storefront/products.service';
import { OrderTrackingService } from '../checkout/order-tracking.service';
import { MAILER, type Mailer } from '../mailer/mailer';
import { sendHandoffEmail } from '../mailer/agent-emails';
import { createHandoffConversation, isConfigured, type ChatwootConfig } from '../chatwoot/chatwoot.client';

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

/**
 * Everything an executor may know about the turn it is running in.
 *
 * A context object rather than a bare `tenantId` because the set is going to
 * grow — `escalate_to_human` needs the conversation, and P5's WhatsApp channel
 * will need to know which channel it is answering on. `tenantId` is the only
 * field every executor uses, and the only one that must never come from the
 * model.
 */
export interface AgentToolContext {
  tenantId: string;
  /** Absent only where a tool is exercised outside a conversation (tests, and
   * any future non-conversational caller). `escalate_to_human` is the one tool
   * that cannot work without it. */
  conversationId?: string;
  /** Whether this tenant's plan includes human handoff
   * (`TenantLimits.humanHandoff`). Carried in rather than re-read here: the
   * loop has already loaded the plan row for the budget check. */
  handoffEnabled?: boolean;
}

@Injectable()
export class AgentToolsService {
  constructor(
    @Inject(StorefrontProductsService) private readonly products: StorefrontProductsService,
    @Inject(OrderTrackingService) private readonly tracking: OrderTrackingService,
    @Inject(MAILER) private readonly mailer: Mailer,
  ) {}

  /** Dispatch by name. Unknown names are an error result rather than a throw,
   * because the model can emit one and the conversation should survive it. */
  async execute(ctx: AgentToolContext, name: string, rawInput: unknown): Promise<AgentToolResult> {
    const { tenantId } = ctx;
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
      case 'escalate_to_human':
        return this.escalateToHuman(ctx, rawInput);
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

  /**
   * Hands the conversation to a person (SPEC.md §7 rule 7).
   *
   * Three things happen, in this order, and the order is the design:
   *
   *  1. The conversation is marked `escalated` — a durable fact the merchant's
   *     admin reads, independent of whether any notification is delivered.
   *  2. The merchant is emailed. Fire-and-forget: a mail transport that is
   *     briefly down must not become an error the shopper sees, because step 1
   *     already happened and is what the merchant actually works from.
   *  3. The store's own contact details go back to the model, so it can tell
   *     the shopper how to reach a human RIGHT NOW rather than only that
   *     someone will be in touch eventually.
   *
   * Already-escalated conversations return success without re-notifying. A
   * model that calls this twice in one conversation is not a reason to mail a
   * merchant twice about the same customer.
   */
  private async escalateToHuman(ctx: AgentToolContext, rawInput: unknown): Promise<AgentToolResult> {
    // The plan gate. Returned as an ERROR result rather than silently
    // succeeding, because the difference matters to what the model says next:
    // a store without handoff should hear "I can't transfer you" and fall back
    // to offering contact details, not promise a callback nobody will make.
    // The tool is also filtered out of the array for such a store, so reaching
    // this line means the model invented the call.
    if (!ctx.handoffEnabled) {
      return fail('esta tienda no tiene habilitada la atención humana por chat');
    }
    if (!ctx.conversationId) {
      return fail('no hay una conversación activa para escalar');
    }

    const parsed = escalateToHumanInput.safeParse(rawInput);
    if (!parsed.success) return fail('parámetros inválidos para escalate_to_human');

    const db = tenantDb(ctx.tenantId);
    const conversation = await db.conversation.findFirst({
      where: { id: ctx.conversationId, tenantId: ctx.tenantId },
    });
    if (!conversation) return fail('no encontré esa conversación');

    const tenant = await db.tenant.findUniqueOrThrow({ where: { id: ctx.tenantId } });
    const storeInfo = asRecord(asRecord(tenant.settings).storeInfo);
    const contactEmail = typeof storeInfo.contactEmail === 'string' ? storeInfo.contactEmail : null;
    const contactPhone = typeof storeInfo.contactPhone === 'string' ? storeInfo.contactPhone : null;

    const alreadyEscalated = conversation.status === 'escalated';
    if (!alreadyEscalated) {
      await db.conversation.update({ where: { id: conversation.id }, data: { status: 'escalated' } });

      if (contactEmail) {
        void sendHandoffEmail(this.mailer, {
          merchantContactEmail: contactEmail,
          tenantName: tenant.name,
          reason: parsed.data.reason,
          transcriptSummary: parsed.data.transcript_summary,
          shopperRef: conversation.shopperRef,
          conversationId: conversation.id,
        }).catch((err: unknown) => {
          console.error('[agent] handoff email failed', {
            conversationId: conversation.id,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      } else {
        // Worth a log rather than a silent pass: the escalation is recorded and
        // the shopper is told, but nobody was actively told to look.
        console.warn('[agent] escalated with no merchant contact email', { tenantId: ctx.tenantId });
      }

      // Chatwoot, when the tenant has connected one — a SECOND notifier beside
      // the email, not a replacement (SPEC.md §7). Fire-and-forget for the
      // same reason: the conversation is already marked escalated and the
      // merchant already has an email, so a Chatwoot outage must never become
      // a shopper being told nobody can help them.
      const chatwoot = readChatwootConfig(tenant.settings);
      if (isConfigured(chatwoot)) {
        void createHandoffConversation(chatwoot, {
          // The WhatsApp number when we have one, so a returning shopper lands
          // in their existing Chatwoot thread; the conversation id otherwise,
          // which at least keeps one anonymous visitor's escalations together.
          sourceId: conversation.shopperRef ?? conversation.id,
          contactName: conversation.shopperRef ?? 'Cliente del chat web',
          reason: parsed.data.reason,
          transcriptSummary: parsed.data.transcript_summary,
          conversationUrl: `${adminUrl()}/conversaciones?c=${conversation.id}`,
        }).catch((err: unknown) => {
          console.error('[agent] chatwoot handoff failed', {
            conversationId: conversation.id,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    }

    return {
      ok: true,
      data: {
        escalated: true,
        // So the model can say "mientras tanto, escríbenos a…" rather than
        // leaving the shopper with nothing to do.
        contact_email: contactEmail,
        contact_phone: contactPhone,
      },
    };
  }
}

/** The tenant's Chatwoot connection, if any. Read defensively from the
 * loosely-typed `settings` blob: an unconfigured or half-configured tenant is
 * the NORMAL case (most stores will never connect one), so a missing field
 * must yield "not configured" rather than an error. */
function readChatwootConfig(settings: unknown): Partial<ChatwootConfig> {
  const raw = asRecord(asRecord(settings).chatwoot);
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  return {
    baseUrl: str(raw.baseUrl),
    apiToken: str(raw.apiToken),
    accountId: str(raw.accountId),
    inboxId: str(raw.inboxId),
  };
}

/** Same `ADMIN_URL` fallback every merchant-facing link in this codebase
 * uses. */
function adminUrl(): string {
  return (process.env.ADMIN_URL ?? 'http://admin.ventia.localhost').replace(/\/+$/, '');
}

/** Same defensive read of the loosely-typed `settings` JSON as everywhere else
 * that touches it — an absent or malformed shape is "nothing configured". */
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
