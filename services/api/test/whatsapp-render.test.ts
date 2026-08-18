import { describe, expect, it } from 'vitest';
import { renderForWhatsApp, WHATSAPP_MAX_CHARS, type WhatsAppRenderInput } from '../src/agent/whatsapp-render';

/**
 * The WhatsApp renderer, driven as the pure function it is — no Nest graph, no
 * database, no provider.
 *
 * The suite is organised around the one property that matters (P5 design doc
 * §3): **what a shopper reads comes from the tool result, never from the
 * model's prose.** The model here is deliberately written as a liar — its text
 * quotes prices and names that do not exist — so that any regression which
 * starts sourcing a rendered fact from `reply.text` fails loudly instead of
 * shipping a hallucinated price to a real customer.
 */

const BASE = 'https://demo-moda.ventia.co';

/** The truth, as `agent-tools.service.ts` returns it: cents, a relative url. */
const CAMISA = {
  product_id: 'p-camisa',
  name: 'Camisa Lino Blanca',
  price_cents: 12_000_000,
  in_stock: true,
  url: '/producto/camisa-lino-blanca',
  thumbnail_url: 'https://cdn.example.com/camisa.jpg',
};

const GORRA = {
  product_id: 'p-gorra',
  name: 'Gorra Negra',
  price_cents: 4_500_000,
  in_stock: false,
  url: '/producto/gorra-negra',
};

function searchResult(...items: unknown[]) {
  return { name: 'search_products', result: { ok: true, data: { items, total_found: items.length } } };
}

function reply(overrides: Partial<WhatsAppRenderInput> = {}): WhatsAppRenderInput {
  return {
    text: '',
    toolResults: [],
    budgetExhausted: false,
    throttled: false,
    ...overrides,
  };
}

/** The messages that carry the numbered catalogue, i.e. everything the model
 * did not write. */
function productMessages(messages: string[]): string[] {
  return messages.filter((message) => /^\d+\. /m.test(message));
}

describe('renderForWhatsApp — prices and names come from the tool result', () => {
  it('renders the tool price, not the price the model wrote in its prose', () => {
    const messages = renderForWhatsApp(
      reply({
        // A model that broke prompt rule 1: the sentence quotes a price and a
        // name that appear in no tool result.
        text: 'Te recomiendo la Camisa Premium Importada por $ 999.000, ¡una ganga!',
        toolResults: [searchResult(CAMISA)],
      }),
      BASE,
    );

    const catalogue = productMessages(messages).join('\n');
    expect(catalogue).toContain('Camisa Lino Blanca');
    expect(catalogue).toContain('$ 120.000');
    // The invented price and name never make it into the rendered listing.
    expect(catalogue).not.toContain('999.000');
    expect(catalogue).not.toContain('Camisa Premium Importada');
  });

  it('renders nothing at all from prose when no tool ran (no price can be conjured)', () => {
    const messages = renderForWhatsApp(reply({ text: 'La Camisa Lino Blanca cuesta $ 120.000.' }), BASE);

    // One message: the model's own sentence, passed through as conversation.
    // No numbered listing, because no tool produced one.
    expect(messages).toEqual(['La Camisa Lino Blanca cuesta $ 120.000.']);
    expect(productMessages(messages)).toEqual([]);
  });

  it('formats cents as es-CO pesos with the codebase-wide "$ 120.000" convention', () => {
    const messages = renderForWhatsApp(reply({ toolResults: [searchResult({ ...CAMISA, price_cents: 4_590_000 })] }), BASE);

    expect(productMessages(messages)[0]).toContain('$ 45.900');
    // A no-break space here would render inconsistently across WhatsApp
    // clients; order-emails.ts normalizes it for the same reason.
    expect(productMessages(messages)[0]).not.toContain('\u00a0');
  });
});

describe('renderForWhatsApp — list format and links', () => {
  it('numbers each product and puts the absolute link on its own line', () => {
    const messages = renderForWhatsApp(reply({ toolResults: [searchResult(CAMISA, { ...GORRA, in_stock: true })] }), BASE);

    expect(productMessages(messages)).toEqual([
      [
        '1. Camisa Lino Blanca — $ 120.000',
        'https://demo-moda.ventia.co/producto/camisa-lino-blanca',
        '',
        '2. Gorra Negra — $ 45.000',
        'https://demo-moda.ventia.co/producto/gorra-negra',
      ].join('\n'),
    ]);
  });

  it('absolutizes the tool\'s relative path — a bare /producto/... is useless in WhatsApp', () => {
    const messages = renderForWhatsApp(reply({ toolResults: [searchResult(CAMISA)] }), BASE);
    const catalogue = productMessages(messages).join('\n');

    expect(catalogue).toContain('https://demo-moda.ventia.co/producto/camisa-lino-blanca');
    // No line is left as the raw relative path the tool returned.
    expect(catalogue.split('\n')).not.toContain('/producto/camisa-lino-blanca');
  });

  it('absolutizes against a base URL that carries a trailing slash', () => {
    const messages = renderForWhatsApp(reply({ toolResults: [searchResult(CAMISA)] }), `${BASE}/`);

    expect(productMessages(messages).join('\n')).toContain('https://demo-moda.ventia.co/producto/camisa-lino-blanca');
  });

  it('drops a link that would leave the store\'s own origin, keeping name and price', () => {
    const messages = renderForWhatsApp(
      reply({ toolResults: [searchResult({ ...CAMISA, url: 'https://evil.example.com/phish' })] }),
      BASE,
    );
    const catalogue = productMessages(messages).join('\n');

    expect(catalogue).toContain('1. Camisa Lino Blanca — $ 120.000');
    expect(catalogue).not.toContain('evil.example.com');
  });

  it('throws rather than silently emitting a price list with no buyable links', () => {
    expect(() => renderForWhatsApp(reply({ toolResults: [searchResult(CAMISA)] }), 'demo-moda.ventia.co')).toThrow(
      /storefrontBaseUrl/,
    );
  });

  it('says "agotado" instead of hiding a sold-out product', () => {
    const messages = renderForWhatsApp(reply({ toolResults: [searchResult(CAMISA, GORRA)] }), BASE);
    const catalogue = productMessages(messages).join('\n');

    expect(catalogue).toContain('2. Gorra Negra — $ 45.000 (agotado)');
    expect(catalogue).toContain('1. Camisa Lino Blanca — $ 120.000\n');
    expect(catalogue).not.toContain('Camisa Lino Blanca — $ 120.000 (agotado)');
  });

  it('renders a single-product get_product result too', () => {
    const messages = renderForWhatsApp(
      reply({
        text: 'Sí, la tenemos.',
        toolResults: [{ name: 'get_product', result: { ok: true, data: { ...CAMISA, variants: [] } } }],
      }),
      BASE,
    );

    expect(productMessages(messages)[0]).toBe(
      '1. Camisa Lino Blanca — $ 120.000\nhttps://demo-moda.ventia.co/producto/camisa-lino-blanca',
    );
  });

  it('lists each product once when search and recommend return the same catalogue', () => {
    const messages = renderForWhatsApp(
      reply({
        toolResults: [
          searchResult(CAMISA, GORRA),
          { name: 'recommend_products', result: { ok: true, data: { items: [CAMISA] } } },
        ],
      }),
      BASE,
    );
    const catalogue = productMessages(messages).join('\n');

    expect(catalogue.match(/Camisa Lino Blanca/g)).toHaveLength(1);
    expect(catalogue).not.toContain('3.');
  });
});

describe('renderForWhatsApp — cart link', () => {
  it('renders the tool\'s subtotal and an absolute cart url', () => {
    const messages = renderForWhatsApp(
      reply({
        text: 'Listo, te armé el carrito.',
        toolResults: [
          {
            name: 'create_cart_link',
            result: { ok: true, data: { cart_url: '/carrito?c=abc%20123', subtotal_cents: 16_500_000, item_count: 2 } },
          },
        ],
      }),
      BASE,
    );

    expect(messages).toHaveLength(2);
    expect(messages[1]).toBe('Tu carrito (2 productos): $ 165.000\nhttps://demo-moda.ventia.co/carrito?c=abc%20123');
  });

  it('says "1 producto" in the singular', () => {
    const messages = renderForWhatsApp(
      reply({
        toolResults: [
          { name: 'create_cart_link', result: { ok: true, data: { cart_url: '/carrito?c=k', subtotal_cents: 4_500_000, item_count: 1 } } },
        ],
      }),
      BASE,
    );

    expect(messages[0]).toContain('Tu carrito (1 producto): $ 45.000');
  });

  it('keeps only the last cart when the model rebuilt it mid-turn', () => {
    const messages = renderForWhatsApp(
      reply({
        toolResults: [
          { name: 'create_cart_link', result: { ok: true, data: { cart_url: '/carrito?c=old', subtotal_cents: 1_000_000, item_count: 1 } } },
          { name: 'create_cart_link', result: { ok: true, data: { cart_url: '/carrito?c=new', subtotal_cents: 2_000_000, item_count: 2 } } },
        ],
      }),
      BASE,
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('c=new');
    expect(messages[0]).not.toContain('c=old');
  });
});

describe('renderForWhatsApp — results that must render nothing', () => {
  const NOTHING: Array<[string, { name: string; result: unknown }]> = [
    ['a failed search', { name: 'search_products', result: { ok: false, error: 'no pude consultar el catálogo' } }],
    [
      'a failed search that still carries a payload',
      { name: 'search_products', result: { ok: false, error: 'catálogo desactualizado', data: { items: [CAMISA] } } },
    ],
    ['a failed cart link', { name: 'create_cart_link', result: { ok: false, error: 'sin stock' } }],
    [
      'a failed cart link that still carries a payload',
      {
        name: 'create_cart_link',
        result: { ok: false, error: 'sin stock', data: { cart_url: '/carrito?c=k', subtotal_cents: 1, item_count: 1 } },
      },
    ],
    ['a tool with no rendering', { name: 'get_store_info', result: { ok: true, data: { topic: 'envios', body: 'x' } } }],
    ['a malformed payload', { name: 'search_products', result: { ok: true, data: { items: 'nope' } } }],
    ['an item missing its price', { name: 'search_products', result: { ok: true, data: { items: [{ product_id: 'p', name: 'X' }] } } }],
    ['a non-object result', { name: 'search_products', result: 'boom' }],
  ];

  it.each(NOTHING)('renders only the model\'s sentence for %s', (_label, toolResult) => {
    const messages = renderForWhatsApp(reply({ text: 'Ay, no pude consultar eso ahora.', toolResults: [toolResult] }), BASE);

    // Never an error blob, never "ok:false" — the model already explained it.
    expect(messages).toEqual(['Ay, no pude consultar eso ahora.']);
  });

  it('drops only the malformed item and still renders its valid neighbour', () => {
    const messages = renderForWhatsApp(reply({ toolResults: [searchResult({ product_id: 'p', name: 'Rota' }, CAMISA)] }), BASE);

    expect(productMessages(messages)[0]).toContain('1. Camisa Lino Blanca');
    expect(productMessages(messages)[0]).not.toContain('Rota');
  });

  it('returns no messages at all when the turn produced neither text nor renderable results', () => {
    expect(renderForWhatsApp(reply({ text: '   ' }), BASE)).toEqual([]);
  });

  it('renders only the fixed sentence when the budget is exhausted', () => {
    const messages = renderForWhatsApp(
      reply({ text: 'Volvemos pronto.', budgetExhausted: true, toolResults: [searchResult(CAMISA)] }),
      BASE,
    );

    expect(messages).toEqual(['Volvemos pronto.']);
  });

  it('renders only the fixed sentence when the turn was throttled', () => {
    const messages = renderForWhatsApp(
      reply({ text: 'Un momentico.', throttled: true, toolResults: [searchResult(CAMISA)] }),
      BASE,
    );

    expect(messages).toEqual(['Un momentico.']);
  });
});

describe('renderForWhatsApp — splitting, never truncating', () => {
  const many = Array.from({ length: 120 }, (_, index) => ({
    product_id: `p-${index}`,
    name: `Camiseta de algodón peinado edición ${index}`,
    price_cents: 5_000_000 + index,
    in_stock: true,
    url: `/producto/camiseta-de-algodon-peinado-edicion-${index}`,
  }));

  it('splits a long catalogue across several messages, all within the WhatsApp limit', () => {
    const messages = renderForWhatsApp(reply({ text: 'Esto es lo que tengo:', toolResults: [searchResult(...many)] }), BASE);
    const catalogue = productMessages(messages);

    expect(catalogue.length).toBeGreaterThan(1);
    expect(messages.every((message) => message.length <= WHATSAPP_MAX_CHARS)).toBe(true);
  });

  it('loses no product and never separates a product from its link', () => {
    const messages = productMessages(
      renderForWhatsApp(reply({ toolResults: [searchResult(...many)] }), BASE),
    );

    for (const message of messages) {
      const lines = message.split('\n').filter((line) => line.length > 0);
      // Every heading is immediately followed by its own link line.
      expect(lines.length % 2).toBe(0);
      for (let index = 0; index < lines.length; index += 2) {
        expect(lines[index]).toMatch(/^\d+\. Camiseta de algodón peinado edición \d+ — \$ /);
        expect(lines[index + 1]).toMatch(/^https:\/\/demo-moda\.ventia\.co\/producto\//);
      }
    }

    // Rejoining the messages reproduces the whole list, numbered 1..120 with
    // no gap — the numbers are assigned before the split, so they stay
    // continuous across it.
    const rejoined = messages.join('\n\n');
    for (let index = 0; index < many.length; index += 1) {
      expect(rejoined).toContain(`${index + 1}. Camiseta de algodón peinado edición ${index} — `);
    }
    expect(rejoined.match(/^\d+\. /gm)).toHaveLength(many.length);
  });

  it('splits an unbroken wall of prose instead of cutting it short', () => {
    const wall = 'a'.repeat(WHATSAPP_MAX_CHARS * 2 + 17);

    const messages = renderForWhatsApp(reply({ text: wall }), BASE);

    expect(messages.every((message) => message.length <= WHATSAPP_MAX_CHARS)).toBe(true);
    expect(messages.join('')).toBe(wall);
  });

  it('never emits an empty or whitespace-only message body', () => {
    const messages = renderForWhatsApp(
      reply({
        text: '\n\n  Hola  \n\n',
        toolResults: [searchResult(...many), { name: 'create_cart_link', result: { ok: true, data: { cart_url: '/carrito?c=k', subtotal_cents: 1, item_count: 1 } } }],
      }),
      BASE,
    );

    expect(messages.every((message) => message.trim().length > 0)).toBe(true);
    expect(messages[0]).toBe('Hola');
  });
});
