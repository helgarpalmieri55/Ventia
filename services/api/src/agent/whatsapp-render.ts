import type { AgentReply } from './agent.service';

/**
 * Renders one agent turn as WhatsApp-ready plain text
 * (docs/superpowers/specs/2026-08-18-p5-whatsapp-design.md §3, SPEC.md §7:
 * *"Same agent core, text-first rendering (product lists as numbered text +
 * short links)"*).
 *
 * ## The property this module exists to preserve
 *
 * The web widget renders product cards from `AgentReply.toolResults`, never
 * from the model's prose, so that a hallucinated price cannot reach a shopper
 * even if prompt rule 1 ("precios... SOLO provienen de tus herramientas")
 * fails. That guarantee is a property of the RENDERER, not of the channel, and
 * it has to survive the channel change — otherwise WhatsApp becomes the one
 * surface where the model's own sentence about a price is what a shopper acts
 * on. So every name, price, availability flag and link below is read out of a
 * tool result. The model's text is passed through as conversation and is never
 * parsed for facts.
 *
 * ## Pure by construction
 *
 * No Nest, no I/O, no `process.env` — the only import is a type. The transport
 * (P5b's inbound webhook) calls this and sends what comes back, which is what
 * lets the whole rendering contract be tested without a database, a Meta app
 * or an Evolution instance.
 *
 * ## Why the extraction mirrors `apps/storefront/lib/agent-api.ts`
 *
 * `productsFromTool` / `cartLinkFromTool` there do the same narrowing for the
 * widget, with the same defensive shape checks. Deliberately duplicated rather
 * than shared: `services/api` cannot import from `apps/`, and the two consume
 * the same JSON contract at opposite ends of the wire. If the tool result
 * shape in `agent-tools.service.ts` changes, BOTH have to move.
 */

/** WhatsApp's per-message body limit (Cloud API `text.body` and Evolution's
 * `text` alike). Messages are SPLIT at this boundary, never truncated — a
 * shopper silently missing the second half of a price list is the failure this
 * whole module is written to avoid. */
export const WHATSAPP_MAX_CHARS = 4096;

// A local copy of `services/api/src/mailer/order-emails.ts`'s `formatCOP`,
// which is itself a copy of the two app-side ones — this repo's established
// per-module-copy convention for this 4-line formatter, not a new pattern.
const copFormatter = new Intl.NumberFormat('es-CO', {
  style: 'currency',
  currency: 'COP',
  maximumFractionDigits: 0,
});
// U+00A0 NO-BREAK SPACE: what Intl inserts between the symbol and the digits.
// Normalized to a plain space so the output is `$ 120.000` — WhatsApp bodies
// travel through gateways and clients that treat NBSP inconsistently, and the
// rest of the codebase already shows shoppers this exact spacing.
const NBSP = '\u00a0';

function formatCOP(cents: number): string {
  const pesos = Math.round(cents / 100);
  return copFormatter.format(pesos).replaceAll(NBSP, ' ');
}

/**
 * What the renderer needs from a turn.
 *
 * A `Pick` of the real `AgentReply` rather than a hand-written duplicate: it
 * stays typed against the actual contract (a field renamed there breaks the
 * build here) while leaving out `conversationId`, which this module has no use
 * for and which callers and tests would otherwise have to invent.
 */
export type WhatsAppRenderInput = Pick<AgentReply, 'text' | 'toolResults' | 'budgetExhausted' | 'throttled'>;

/** The tool envelope every executor in `agent-tools.service.ts` returns. */
interface ToolEnvelope {
  ok: boolean;
  error?: string;
  data?: unknown;
}

/** One product as this renderer needs it — the subset of the tool's item that
 * survives into text. `thumbnail_url` is dropped: WhatsApp images are a
 * separate media message, out of scope for the text-first slice. */
interface RenderableProduct {
  productId: string;
  name: string;
  priceCents: number;
  inStock: boolean;
  /** Relative, exactly as the tool produced it. Absolutized at render time. */
  path: string | null;
}

interface RenderableCart {
  path: string;
  subtotalCents: number;
  itemCount: number;
}

function asEnvelope(result: unknown): ToolEnvelope | null {
  if (typeof result !== 'object' || result === null) return null;
  const envelope = result as ToolEnvelope;
  return typeof envelope.ok === 'boolean' ? envelope : null;
}

function asProduct(raw: unknown): RenderableProduct | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const item = raw as Record<string, unknown>;
  // Every one of these is load-bearing in the rendered line, so a shape that
  // is missing any of them is dropped whole rather than rendered with a hole
  // in it — "Camisa — $ NaN" is worse than one fewer product.
  if (typeof item.product_id !== 'string' || typeof item.name !== 'string' || typeof item.price_cents !== 'number') {
    return null;
  }
  if (!Number.isFinite(item.price_cents)) return null;
  return {
    productId: item.product_id,
    name: item.name,
    priceCents: item.price_cents,
    // Availability is only ever claimed when the tool actually said so. An
    // absent flag is treated as "in stock unknown", which renders as no claim
    // at all rather than as an optimistic one.
    inStock: item.in_stock !== false,
    path: typeof item.url === 'string' ? item.url : null,
  };
}

/**
 * Products carried by one tool result, or `[]` for anything else.
 *
 * `get_product` is included alongside the two list tools even though it
 * returns a single product: it carries the same name/price/stock fields, and
 * leaving it out would mean the one flow where a shopper asks about a specific
 * item is also the one flow where the price they read came from the model's
 * sentence instead of the database.
 *
 * A failed result (`ok: false`) yields nothing. The model has already been
 * told to explain the failure in its own words (the executors return errors
 * rather than throwing precisely so it can); appending a rendered error blob
 * would show the shopper the same problem twice, in machine language.
 */
function productsFromTool(name: string, result: unknown): RenderableProduct[] {
  const envelope = asEnvelope(result);
  if (!envelope?.ok) return [];
  const data = envelope.data;
  if (typeof data !== 'object' || data === null) return [];

  if (name === 'search_products' || name === 'recommend_products') {
    const items = (data as { items?: unknown }).items;
    if (!Array.isArray(items)) return [];
    return items.map(asProduct).filter((product): product is RenderableProduct => product !== null);
  }
  if (name === 'get_product') {
    const product = asProduct(data);
    return product ? [product] : [];
  }
  return [];
}

/** The cart link carried by a `create_cart_link` result, or `null`. */
function cartLinkFromTool(name: string, result: unknown): RenderableCart | null {
  if (name !== 'create_cart_link') return null;
  const envelope = asEnvelope(result);
  if (!envelope?.ok) return null;
  const data = envelope.data as Partial<{ cart_url: string; subtotal_cents: number; item_count: number }> | undefined;
  if (!data || typeof data.cart_url !== 'string') return null;
  return {
    path: data.cart_url,
    subtotalCents: typeof data.subtotal_cents === 'number' ? data.subtotal_cents : 0,
    itemCount: typeof data.item_count === 'number' ? data.item_count : 0,
  };
}

/**
 * Resolves a tool's RELATIVE path (`/producto/camisa`, `/carrito?c=KEY` —
 * relative because only the caller knows the tenant's public origin) against
 * the storefront base URL.
 *
 * Returns `null` for anything that does not resolve to a link on that same
 * origin. A path is server-built today, but a chat message is the one place
 * where a link is the thing the shopper taps, and a store's own agent handing
 * out an off-origin (or `javascript:`/`mailto:`) URL is never a rendering this
 * module should be capable of producing. The caller drops the link line and
 * still shows the name and price.
 */
function absoluteUrl(path: string, base: URL): string | null {
  let resolved: URL;
  try {
    resolved = new URL(path, base);
  } catch {
    return null;
  }
  return resolved.origin === base.origin ? resolved.toString() : null;
}

/**
 * Splits `text` to fit `limit`, preferring the earliest separator that works.
 *
 * Tried in order: blank line (keeps a numbered entry glued to its link line),
 * newline, space, then a hard slice. The hard slice only ever runs for a
 * single token longer than a whole message — pathological, but it must not
 * lose characters, because the alternative to splitting here is truncating,
 * and a truncated price line is a wrong price line.
 */
function chunkText(text: string, limit: number, separators: readonly string[]): string[] {
  if (text.length <= limit) return [text];

  const [separator, ...rest] = separators;
  if (separator === undefined) {
    const slices: string[] = [];
    for (let index = 0; index < text.length; index += limit) slices.push(text.slice(index, index + limit));
    return slices;
  }

  const chunks: string[] = [];
  let current = '';
  for (const piece of text.split(separator)) {
    const candidate = current === '' ? piece : `${current}${separator}${piece}`;
    if (candidate.length <= limit) {
      current = candidate;
      continue;
    }
    if (current !== '') {
      chunks.push(current);
      current = '';
    }
    // The piece alone may still be too long: fall to the next separator, and
    // keep its tail open so the following piece can share that last chunk.
    const sub = chunkText(piece, limit, rest);
    chunks.push(...sub.slice(0, -1));
    current = sub[sub.length - 1] ?? '';
  }
  if (current !== '') chunks.push(current);
  return chunks;
}

const SEPARATORS = ['\n\n', '\n', ' '] as const;

function toMessages(body: string): string[] {
  const trimmed = body.trim();
  if (trimmed.length === 0) return [];
  return chunkText(trimmed, WHATSAPP_MAX_CHARS, SEPARATORS)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0);
}

/**
 * Turns one agent turn into the WhatsApp message bodies to send, in order.
 *
 * Three messages at most before splitting — the model's prose, the product
 * list, the cart link — rather than one long body. Prompt rule 6 ("mensajes
 * cortos, máximo un producto destacado por mensaje") bounds what the model
 * SAYS; the numbered list is this channel's structured rendering of the tool
 * results and belongs in its own message, so the conversational half stays
 * short and the shopper's tap target is not buried in a paragraph.
 *
 * Returns `[]` when the turn produced neither text nor renderable tool
 * results. That is an explicit "nothing to send" for the transport to log —
 * both providers reject an empty body anyway, and inventing filler here would
 * hide a broken turn behind a polite sentence.
 *
 * @param storefrontBaseUrl the tenant's public storefront origin, as built by
 *   `tenantStorefrontBaseUrl`. Throws if it is not a usable absolute URL:
 *   every link in this reply would otherwise be dropped, and a price list with
 *   no way to buy anything is a misconfiguration worth failing loudly on
 *   rather than delivering.
 */
export function renderForWhatsApp(reply: WhatsAppRenderInput, storefrontBaseUrl: string): string[] {
  let base: URL;
  try {
    base = new URL(storefrontBaseUrl);
  } catch {
    throw new Error(`renderForWhatsApp: storefrontBaseUrl must be an absolute URL, got ${JSON.stringify(storefrontBaseUrl)}`);
  }

  const messages: string[] = [...toMessages(reply.text ?? '')];

  // The budget and throttle paths never carry tool results, but they are also
  // the two paths where the text is a fixed sentence the merchant is not
  // paying for — rendering anything else alongside them would be rendering
  // state from a turn that did not happen.
  if (reply.budgetExhausted || reply.throttled) return messages;

  const products: RenderableProduct[] = [];
  const seen = new Set<string>();
  let cart: RenderableCart | null = null;

  for (const { name, result } of reply.toolResults ?? []) {
    for (const product of productsFromTool(name, result)) {
      // A turn commonly runs `search_products` and then `recommend_products`
      // over the same catalog, so the same shirt arrives twice. Listing it as
      // items 1 and 4 makes the store look broken and spends the character
      // budget on a repeat.
      if (seen.has(product.productId)) continue;
      seen.add(product.productId);
      products.push(product);
    }
    // Last cart wins: if the model rebuilt the cart mid-turn, the earlier link
    // points at a basket the shopper no longer asked for.
    cart = cartLinkFromTool(name, result) ?? cart;
  }

  if (products.length > 0) {
    const entries = products.map((product, index) => {
      // Numbered per the design doc, and numbered ONCE here so the numbers
      // stay continuous across whatever the splitter does below.
      const stock = product.inStock ? '' : ' (agotado)';
      // Said, not omitted: dropping a sold-out product the shopper explicitly
      // asked about reads as the store not having it at all, and the model has
      // usually just mentioned it by name.
      const heading = `${index + 1}. ${product.name} — ${formatCOP(product.priceCents)}${stock}`;
      const link = product.path ? absoluteUrl(product.path, base) : null;
      return link ? `${heading}\n${link}` : heading;
    });
    messages.push(...toMessages(entries.join('\n\n')));
  }

  if (cart) {
    const link = absoluteUrl(cart.path, base);
    if (link) {
      const units = cart.itemCount === 1 ? '1 producto' : `${cart.itemCount} productos`;
      messages.push(...toMessages(`Tu carrito (${units}): ${formatCOP(cart.subtotalCents)}\n${link}`));
    }
  }

  return messages;
}
