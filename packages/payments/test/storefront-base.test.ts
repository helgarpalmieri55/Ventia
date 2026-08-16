import { describe, expect, it } from 'vitest';
import { requireStorefrontBaseUrl } from '../src/storefront-base';

/** Unit tests for the per-tenant storefront base URL validator that replaced
 * the old single-global `PAYMENTS_STOREFRONT_BASE_URL` resolution.
 *
 * The behavioral contract that matters here is "throw, never substitute":
 * every rejected shape below used to be either impossible to express (there
 * was one global value) or would now silently produce a redirect pointing
 * somewhere other than the tenant's own storefront. */
describe('requireStorefrontBaseUrl', () => {
  it('accepts a plain https origin and returns it unchanged', () => {
    expect(requireStorefrontBaseUrl('https://tienda.example.com', 'wompi')).toBe(
      'https://tienda.example.com',
    );
  });

  it('accepts the http dev origin shape this repo actually runs on', () => {
    expect(requireStorefrontBaseUrl('http://demo-moda.ventia.localhost', 'wompi')).toBe(
      'http://demo-moda.ventia.localhost',
    );
  });

  it('strips a trailing slash so callers can concatenate `/pago/...` cleanly', () => {
    expect(requireStorefrontBaseUrl('https://tienda.example.com/', 'wompi')).toBe(
      'https://tienda.example.com',
    );
    expect(requireStorefrontBaseUrl('https://tienda.example.com/co/', 'wompi')).toBe(
      'https://tienda.example.com/co',
    );
  });

  it('keeps an explicit non-default port', () => {
    expect(requireStorefrontBaseUrl('http://localhost:3000', 'epayco')).toBe('http://localhost:3000');
  });

  it('trims surrounding whitespace', () => {
    expect(requireStorefrontBaseUrl('  https://tienda.example.com  ', 'wompi')).toBe(
      'https://tienda.example.com',
    );
  });

  for (const [label, value] of [
    ['undefined', undefined],
    ['null', null],
    ['empty string', ''],
    ['whitespace only', '   '],
  ] as const) {
    it(`throws for ${label} instead of falling back to any global default`, () => {
      expect(() => requireStorefrontBaseUrl(value, 'wompi')).toThrow(/storefrontBaseUrl is required/);
    });
  }

  it('throws for a relative path (would produce a redirect the gateway cannot use)', () => {
    expect(() => requireStorefrontBaseUrl('/pago', 'wompi')).toThrow(/absolute http\(s\) URL/);
  });

  it('throws for a scheme-relative URL', () => {
    expect(() => requireStorefrontBaseUrl('//evil.example', 'wompi')).toThrow(/absolute http\(s\) URL/);
  });

  it('throws for a non-navigational scheme', () => {
    expect(() => requireStorefrontBaseUrl('javascript:alert(1)', 'wompi')).toThrow(/must use http: or https:/);
    expect(() => requireStorefrontBaseUrl('file:///etc/passwd', 'epayco')).toThrow(/must use http: or https:/);
  });

  it('throws for a base carrying a query string — it would swallow the gateway-appended param', () => {
    // The exact ambiguity `wompi.ts`'s path-segment order number exists to
    // avoid: Wompi appends `?id=`, ePayco appends `?ref_payco=`.
    expect(() => requireStorefrontBaseUrl('https://tienda.example.com/?a=1', 'wompi')).toThrow(
      /query string or fragment/,
    );
  });

  it('throws for a base carrying a fragment', () => {
    expect(() => requireStorefrontBaseUrl('https://tienda.example.com/#x', 'wompi')).toThrow(
      /query string or fragment/,
    );
  });

  it('throws for userinfo credentials in the authority', () => {
    expect(() => requireStorefrontBaseUrl('https://user:pass@tienda.example.com', 'wompi')).toThrow(
      /userinfo credentials/,
    );
  });

  it('names the rejecting provider in the error message', () => {
    expect(() => requireStorefrontBaseUrl('', 'epayco')).toThrow(/^epayco:/);
    expect(() => requireStorefrontBaseUrl('', 'wompi')).toThrow(/^wompi:/);
  });
});
