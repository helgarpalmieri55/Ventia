/** Browser-side client for the AI sales agent, going through the same-origin
 * `/api/agent/*` Route Handler proxy (see that file for why the browser does
 * not call the API directly).
 *
 * `fetchImpl` is threaded through with a `fetch` default, matching
 * `cart-api.ts`'s convention, so the tests below drive real SSE bodies without
 * a network.
 */

/** One event from the agent's stream. Mirrors `AgentEvent` in
 * `services/api/src/agent/agent.service.ts` plus the two terminal events the
 * controller adds. */
export type AgentStreamEvent =
  | { type: 'conversation'; conversationId: string }
  | { type: 'tool'; name: string; result: AgentToolResult }
  | { type: 'message'; text: string }
  | { type: 'done'; conversationId: string; text: string; toolResults: Array<{ name: string; result: AgentToolResult }>; budgetExhausted: boolean; throttled: boolean }
  | { type: 'error'; message: string };

export interface AgentToolResult {
  ok: boolean;
  error?: string;
  data?: unknown;
}

/** What `create_cart_link` returns, narrowed for the widget's cart button. */
export interface CartLinkData {
  cart_url: string;
  subtotal_cents: number;
  item_count: number;
}

/** What `search_products` / `recommend_products` return per item, narrowed for
 * the product cards the widget renders instead of leaving the model to
 * describe them in prose. */
export interface AgentProduct {
  product_id: string;
  name: string;
  price_cents: number;
  in_stock: boolean;
  url: string;
  thumbnail_url?: string | null;
  reason?: string;
}

export class AgentApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`agent api error ${status}: ${body}`);
  }
}

/**
 * Sends one message and yields events as they arrive.
 *
 * An async generator rather than a callback so the caller can `for await` and
 * keep its own state in one place; cancelling is just breaking out of the
 * loop, which releases the reader and lets the connection close.
 */
export async function* streamAgentMessage(
  input: { message: string; conversationId?: string },
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): AsyncGenerator<AgentStreamEvent> {
  const res = await fetchImpl('/api/agent/stream', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
    signal,
  });

  // A non-2xx never carries a stream — it is the guard's 404, the validation
  // 400, or the limiter's 429, all ordinary JSON.
  if (!res.ok || !res.body) {
    throw new AgentApiError(res.status, await res.text().catch(() => ''));
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE frames are separated by a blank line. A chunk can end mid-frame,
      // so the trailing partial stays in the buffer for the next read — the
      // single most common way a hand-rolled SSE reader goes wrong is
      // assuming one chunk is one event.
      let separator = buffer.indexOf('\n\n');
      while (separator !== -1) {
        const frame = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        const event = parseFrame(frame);
        if (event) yield event;
        separator = buffer.indexOf('\n\n');
      }
    }
  } finally {
    // Runs on an early `break` from the consumer too, not just on completion.
    reader.releaseLock();
  }
}

function parseFrame(frame: string): AgentStreamEvent | null {
  const data = /^data: (.*)$/m.exec(frame)?.[1];
  if (!data) return null;
  try {
    return JSON.parse(data) as AgentStreamEvent;
  } catch {
    // A malformed frame is dropped rather than thrown: one bad event must not
    // take down a conversation that is otherwise working.
    console.error('[agent] dropped an unparseable stream frame');
    return null;
  }
}

/** Pulls the products out of a search/recommend tool result, or `[]` for any
 * other tool, a failed one, or a shape that is not what we expect. Defensive
 * because this renders directly into the shopper's chat. */
export function productsFromTool(name: string, result: AgentToolResult): AgentProduct[] {
  if (!result.ok || (name !== 'search_products' && name !== 'recommend_products')) return [];
  const data = result.data as { items?: unknown } | undefined;
  if (!data || !Array.isArray(data.items)) return [];
  return data.items.filter(
    (item): item is AgentProduct =>
      typeof item === 'object' &&
      item !== null &&
      typeof (item as AgentProduct).product_id === 'string' &&
      typeof (item as AgentProduct).name === 'string' &&
      typeof (item as AgentProduct).price_cents === 'number',
  );
}

/** Pulls the cart link out of a `create_cart_link` result, or `null`. */
export function cartLinkFromTool(name: string, result: AgentToolResult): CartLinkData | null {
  if (!result.ok || name !== 'create_cart_link') return null;
  const data = result.data as Partial<CartLinkData> | undefined;
  return data && typeof data.cart_url === 'string'
    ? {
        cart_url: data.cart_url,
        subtotal_cents: typeof data.subtotal_cents === 'number' ? data.subtotal_cents : 0,
        item_count: typeof data.item_count === 'number' ? data.item_count : 0,
      }
    : null;
}

/** Adopts an agent-built cart (`/carrito?c=<key>`) so every later cart call
 * sees it. Returns false when the link is stale or not adoptable — the caller
 * shows "este enlace ya no está disponible" rather than an error. */
export async function adoptCart(cookieKey: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const res = await fetchImpl('/api/cart/adopt', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cookieKey }),
  });
  return res.ok;
}
