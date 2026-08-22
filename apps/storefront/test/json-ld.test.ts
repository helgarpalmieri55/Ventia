import { describe, expect, it } from 'vitest';
import { jsonLdScript } from '../lib/json-ld';

describe('jsonLdScript', () => {
  it('escapes a closing script tag so it cannot terminate the element', () => {
    const out = jsonLdScript({ name: '</script><img src=x onerror=alert(1)>' });
    // The literal sequence the HTML parser scans for must not survive.
    expect(out).not.toContain('</script');
    expect(out).not.toContain('<');
    expect(out).not.toContain('>');
  });

  it('escapes an ampersand, which HTML would otherwise treat as an entity start', () => {
    expect(jsonLdScript({ name: 'Café & Té' })).not.toContain('&');
  });

  it('escapes U+2028 and U+2029, legal in JSON but line terminators in JS', () => {
    const out = jsonLdScript({ a: '\u2028', b: '\u2029' });
    expect(out).not.toContain('\u2028');
    expect(out).not.toContain('\u2029');
    expect(out).toContain('\\u2028');
    expect(out).toContain('\\u2029');
  });

  it('round-trips: a consumer parses back exactly the original value', () => {
    const value = {
      '@context': 'https://schema.org',
      name: 'Vestido <b>rojo</b> & azul',
      description: 'Talla S\u2028M',
      offers: { price: '45900', nested: ['</script>', 1, true, null] },
    };
    expect(JSON.parse(jsonLdScript(value))).toEqual(value);
  });

  it('leaves a payload with none of those characters byte-identical to JSON.stringify', () => {
    const value = { name: 'Camisa blanca', price: '39900', count: 12 };
    expect(jsonLdScript(value)).toBe(JSON.stringify(value));
  });
});
