import { describe, expect, it, vi } from 'vitest';
import {
  AgentApiError,
  adoptCart,
  cartLinkFromTool,
  productsFromTool,
  streamAgentMessage,
  type AgentStreamEvent,
} from '../lib/agent-api';

/**
 * The widget's read of the agent stream.
 *
 * The interesting part is not the happy path — it is that an SSE body arrives
 * in arbitrary chunks that have nothing to do with event boundaries. A reader
 * that assumes one chunk is one event works perfectly against a fast local
 * API and drops events the moment there is real latency, which is the kind of
 * bug that only ever reproduces in production.
 */

/** Builds a Response whose body streams `chunks` one at a time. */
function sseResponse(chunks: string[], status = 200): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status, headers: { 'content-type': 'text/event-stream' } });
}

function frame(event: AgentStreamEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

async function collect(res: Response): Promise<AgentStreamEvent[]> {
  const fetchImpl = vi.fn().mockResolvedValue(res);
  const events: AgentStreamEvent[] = [];
  for await (const event of streamAgentMessage({ message: 'hola' }, fetchImpl)) events.push(event);
  return events;
}

describe('streamAgentMessage', () => {
  it('posts the message to the same-origin proxy', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(sseResponse([frame({ type: 'message', text: 'hola' })]));
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of streamAgentMessage({ message: 'hola', conversationId: 'c1' }, fetchImpl));

    expect(fetchImpl).toHaveBeenCalledWith('/api/agent/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hola', conversationId: 'c1' }),
      signal: undefined,
    });
  });

  it('yields each event in order', async () => {
    const events = await collect(
      sseResponse([
        frame({ type: 'conversation', conversationId: 'c1' }),
        frame({ type: 'tool', name: 'search_products', result: { ok: true, data: { items: [] } } }),
        frame({ type: 'message', text: 'listo' }),
      ]),
    );

    expect(events.map((e) => e.type)).toEqual(['conversation', 'tool', 'message']);
  });

  it('reassembles an event split across chunks', async () => {
    // The failure this guards: a chunk boundary landing mid-JSON. A reader
    // that parses per-chunk silently loses this event entirely.
    const whole = frame({ type: 'message', text: 'Tenemos la Camisa Loop' });
    const events = await collect(sseResponse([whole.slice(0, 20), whole.slice(20)]));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'message', text: 'Tenemos la Camisa Loop' });
  });

  it('emits both events when two arrive in one chunk', async () => {
    const events = await collect(
      sseResponse([frame({ type: 'conversation', conversationId: 'c1' }) + frame({ type: 'message', text: 'ok' })]),
    );

    expect(events.map((e) => e.type)).toEqual(['conversation', 'message']);
  });

  it('drops an unparseable frame without killing the conversation', async () => {
    const events = await collect(
      sseResponse(['event: message\ndata: {not json\n\n', frame({ type: 'message', text: 'sigo aquí' })]),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ text: 'sigo aquí' });
  });

  it('throws AgentApiError for a non-2xx, which never carries a stream', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{"error":"TOO_MANY_REQUESTS"}', { status: 429 }));
    const iterator = streamAgentMessage({ message: 'hola' }, fetchImpl);
    await expect(iterator.next()).rejects.toThrow(AgentApiError);
  });
});

describe('productsFromTool', () => {
  const items = [{ product_id: 'p1', name: 'Camisa', price_cents: 80_000, in_stock: true, url: '/producto/camisa' }];

  it('extracts items from a successful search', () => {
    expect(productsFromTool('search_products', { ok: true, data: { items } })).toHaveLength(1);
  });

  it('extracts items from a recommendation too', () => {
    expect(productsFromTool('recommend_products', { ok: true, data: { items } })).toHaveLength(1);
  });

  it('returns nothing for a FAILED tool, so an error never renders as a product', () => {
    expect(productsFromTool('search_products', { ok: false, error: 'x', data: { items } })).toEqual([]);
  });

  it('returns nothing for an unrelated tool', () => {
    expect(productsFromTool('get_store_info', { ok: true, data: { items } })).toEqual([]);
  });

  it('skips an item missing the fields the card renders', () => {
    // Everything here goes straight into a shopper's chat window; a card with
    // an undefined price is worse than no card.
    const result = productsFromTool('search_products', {
      ok: true,
      data: { items: [...items, { product_id: 'p2', name: 'Sin precio' }] },
    });
    expect(result).toHaveLength(1);
    expect(result[0].product_id).toBe('p1');
  });

  it('survives a result whose shape is nothing like expected', () => {
    expect(productsFromTool('search_products', { ok: true, data: 'no soy un objeto' })).toEqual([]);
    expect(productsFromTool('search_products', { ok: true })).toEqual([]);
  });
});

describe('cartLinkFromTool', () => {
  it('extracts the url the tool returned', () => {
    const link = cartLinkFromTool('create_cart_link', {
      ok: true,
      data: { cart_url: '/carrito?c=abc', subtotal_cents: 80_000, item_count: 1 },
    });
    expect(link?.cart_url).toBe('/carrito?c=abc');
  });

  it('returns null for a failed call or another tool', () => {
    expect(cartLinkFromTool('create_cart_link', { ok: false, error: 'sin stock' })).toBeNull();
    expect(cartLinkFromTool('search_products', { ok: true, data: { cart_url: '/carrito?c=abc' } })).toBeNull();
  });

  it('defaults the totals rather than rendering undefined at a shopper', () => {
    const link = cartLinkFromTool('create_cart_link', { ok: true, data: { cart_url: '/carrito?c=abc' } });
    expect(link).toEqual({ cart_url: '/carrito?c=abc', subtotal_cents: 0, item_count: 0 });
  });
});

describe('adoptCart', () => {
  it('posts the key to the cart proxy', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{}', { status: 201 }));
    await expect(adoptCart('key-1', fetchImpl)).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith('/api/cart/adopt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cookieKey: 'key-1' }),
    });
  });

  it('reports a stale link as false rather than throwing', async () => {
    // The caller renders "este enlace ya no está disponible" — a 404 here is
    // an expected outcome, not an exception.
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{"error":"CART_NOT_FOUND"}', { status: 404 }));
    await expect(adoptCart('stale', fetchImpl)).resolves.toBe(false);
  });
});
