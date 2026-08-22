import { describe, expect, it } from 'vitest';
import { INSTAGRAM_MAX_CHARS } from '@ventia/instagram';
import { renderForInstagram } from '../src/instagram/instagram-render';
import { renderForWhatsApp, type WhatsAppRenderInput } from '../src/agent/whatsapp-render';

/**
 * El renderizador de Instagram, movido como la función pura que es — sin grafo
 * de Nest, sin base de datos, sin proveedor.
 *
 * Lo que tiene de propio frente al de WhatsApp es un solo número: 1000
 * caracteres por mensaje en vez de 4096. Y ese número no es cosmético — Meta
 * rechaza el mensaje ENTERO si se pasa, así que el comprador no recibe la
 * mitad, no recibe nada.
 *
 * La propiedad heredada, y la que no puede perderse al cambiar de canal, es
 * que lo que lee un comprador sale del RESULTADO DE LA HERRAMIENTA y nunca de
 * la prosa del modelo. Por eso el modelo está escrito aquí como un mentiroso.
 */

const BASE = 'https://demo-moda.ventia.co';

const CAMISA = {
  product_id: 'p-camisa',
  name: 'Camisa Lino Blanca',
  price_cents: 12_000_000,
  in_stock: true,
  url: '/producto/camisa-lino-blanca',
};

function searchResult(...items: unknown[]) {
  return { name: 'search_products', result: { ok: true, data: { items, total_found: items.length } } };
}

function reply(overrides: Partial<WhatsAppRenderInput> = {}): WhatsAppRenderInput {
  return { text: '', toolResults: [], budgetExhausted: false, throttled: false, ...overrides };
}

describe('renderForInstagram — el límite de 1000 caracteres', () => {
  it('deja intacto un mensaje que cabe', () => {
    const messages = renderForInstagram(reply({ text: 'Sí, nos queda en talla M.' }), BASE);
    expect(messages).toEqual(['Sí, nos queda en talla M.']);
  });

  it('parte un texto largo en trozos de 1000 caracteres o menos', () => {
    // 40 párrafos de 120 caracteres: 4800 caracteres, que en WhatsApp cabrían
    // en un solo mensaje y aquí no.
    const parrafos = Array.from({ length: 40 }, (_, i) => `Párrafo ${i} `.padEnd(120, 'x'));
    const largo = parrafos.join('\n\n');

    const messages = renderForInstagram(reply({ text: largo }), BASE);

    expect(messages.length).toBeGreaterThan(1);
    for (const message of messages) expect(message.length).toBeLessThanOrEqual(INSTAGRAM_MAX_CHARS);
    // Nada se pierde por el camino: partir, nunca truncar.
    expect(messages.join(' ').replace(/\s+/g, ' ')).toBe(largo.replace(/\s+/g, ' '));
  });

  it('parte donde WhatsApp no habría partido', () => {
    // La misma entrada, los dos canales: un solo mensaje allí, varios aquí. Es
    // la prueba de que el límite se está aplicando de verdad y no se coló el
    // de 4096.
    const largo = Array.from({ length: 30 }, (_, i) => `Línea ${i} `.padEnd(100, 'y')).join('\n');
    expect(renderForWhatsApp(reply({ text: largo }), BASE)).toHaveLength(1);
    expect(renderForInstagram(reply({ text: largo }), BASE).length).toBeGreaterThan(1);
  });

  it('corta duro una palabra imposible antes que rebasar el límite', () => {
    // No hay separador que valga: o se parte por la mitad o Meta lo rechaza.
    const messages = renderForInstagram(reply({ text: 'z'.repeat(2_500) }), BASE);
    for (const message of messages) expect(message.length).toBeLessThanOrEqual(INSTAGRAM_MAX_CHARS);
    expect(messages.join('')).toBe('z'.repeat(2_500));
  });
});

describe('renderForInstagram — los hechos salen de la herramienta', () => {
  it('muestra el precio de la herramienta y no el que escribió el modelo', () => {
    const messages = renderForInstagram(
      reply({
        text: 'La camisa vale $ 50.000 y se llama Camisa Roja.',
        toolResults: [searchResult(CAMISA)],
      }),
      BASE,
    );

    // La prosa del modelo pasa tal cual, como conversación que es; lo que
    // NUNCA sale de ella es el catálogo. Así que se mira el mensaje de la
    // lista numerada, que es lo que el comprador va a leer como hecho.
    const lista = messages.filter((message) => /^\d+\. /m.test(message)).join('\n');
    expect(lista).toContain('Camisa Lino Blanca');
    expect(lista).toContain('$ 120.000');
    expect(lista).not.toContain('$ 50.000');
    expect(lista).not.toContain('Camisa Roja');
  });

  it('vuelve absolutos los enlaces contra la tienda del inquilino', () => {
    // Un `/producto/...` relativo no significa nada dentro de un mensaje
    // directo: no hay página respecto a la cual sea relativo.
    const messages = renderForInstagram(reply({ toolResults: [searchResult(CAMISA)] }), BASE);
    expect(messages.join('\n')).toContain(`${BASE}/producto/camisa-lino-blanca`);
  });

  it('no devuelve nada cuando el turno no produjo ni texto ni resultados', () => {
    expect(renderForInstagram(reply(), BASE)).toEqual([]);
  });
});
