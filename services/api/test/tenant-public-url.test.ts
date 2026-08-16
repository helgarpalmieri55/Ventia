import { describe, expect, it } from 'vitest';
import { requireStorefrontBaseUrl } from '@ventia/payments';
import {
  STOREFRONT_SCHEME_ENV_VAR,
  resolveStorefrontScheme,
  tenantStorefrontBaseUrl,
} from '../src/tenants/tenant-public-url';

/** Unit coverage for the API half of the payment-redirect multi-tenancy fix:
 * turning a resolved `TenantDomain.domain` into the tenant's own public
 * storefront base URL, and making the http-vs-https choice an explicit,
 * testable rule instead of whatever someone typed into a global env var. */
describe('resolveStorefrontScheme', () => {
  it('infers http for this repo’s dev hosts (Caddy serves http://*.ventia.localhost)', () => {
    expect(resolveStorefrontScheme('demo-moda.ventia.localhost', {})).toBe('http');
    expect(resolveStorefrontScheme('ventia.localhost', {})).toBe('http');
    expect(resolveStorefrontScheme('localhost', {})).toBe('http');
    expect(resolveStorefrontScheme('127.0.0.1', {})).toBe('http');
    expect(resolveStorefrontScheme('mac-mini.local', {})).toBe('http');
    expect(resolveStorefrontScheme('shop.test', {})).toBe('http');
  });

  it('defaults a REAL registered domain to https — forgetting to configure anything cannot downgrade production', () => {
    expect(resolveStorefrontScheme('tienda.example.com', {})).toBe('https');
    expect(resolveStorefrontScheme('demo-moda.ventia.co', {})).toBe('https');
  });

  it('is case-insensitive about the host', () => {
    expect(resolveStorefrontScheme('Demo.Ventia.LOCALHOST', {})).toBe('http');
    expect(resolveStorefrontScheme('Tienda.Example.COM', {})).toBe('https');
  });

  it('lets the explicit env override win in BOTH directions', () => {
    // A real domain forced to plaintext (internal staging behind a proxy)...
    expect(
      resolveStorefrontScheme('staging.example.com', { [STOREFRONT_SCHEME_ENV_VAR]: 'http' }),
    ).toBe('http');
    // ...and a local-looking host forced to https.
    expect(
      resolveStorefrontScheme('shop.localhost', { [STOREFRONT_SCHEME_ENV_VAR]: 'https' }),
    ).toBe('https');
  });

  it('throws on a typo’d override rather than silently ignoring it', () => {
    expect(() => resolveStorefrontScheme('tienda.example.com', { [STOREFRONT_SCHEME_ENV_VAR]: 'htp' })).toThrow(
      /must be exactly 'http' or 'https'/,
    );
    expect(() =>
      resolveStorefrontScheme('tienda.example.com', { [STOREFRONT_SCHEME_ENV_VAR]: 'https://x' }),
    ).toThrow(/must be exactly 'http' or 'https'/);
  });

  it('treats an empty/whitespace override as unset and falls through to inference', () => {
    expect(resolveStorefrontScheme('tienda.example.com', { [STOREFRONT_SCHEME_ENV_VAR]: '' })).toBe('https');
    expect(resolveStorefrontScheme('tienda.example.com', { [STOREFRONT_SCHEME_ENV_VAR]: '   ' })).toBe('https');
  });
});

describe('tenantStorefrontBaseUrl', () => {
  it('builds an origin-only base URL with no trailing slash', () => {
    expect(tenantStorefrontBaseUrl('tienda.example.com', {})).toBe('https://tienda.example.com');
    expect(tenantStorefrontBaseUrl('demo-moda.ventia.localhost', {})).toBe(
      'http://demo-moda.ventia.localhost',
    );
  });

  // ==== THE multi-tenancy property, at the API layer. ====
  //
  // Two tenants must produce two different base URLs — including when one owns
  // a fully custom domain that no `PLATFORM_ROOT_DOMAIN` rule could derive.
  it('gives two different tenant domains two different base URLs', () => {
    const a = tenantStorefrontBaseUrl('demo-moda.ventia.localhost', {});
    const b = tenantStorefrontBaseUrl('tienda-de-luisa.com', {});
    expect(a).toBe('http://demo-moda.ventia.localhost');
    expect(b).toBe('https://tienda-de-luisa.com');
    expect(a).not.toBe(b);
  });

  it('keeps an explicit port', () => {
    expect(tenantStorefrontBaseUrl('localhost:3000', {})).toBe('http://localhost:3000');
  });

  it('throws for a missing/blank domain instead of producing http://undefined', () => {
    expect(() => tenantStorefrontBaseUrl(undefined, {})).toThrow(/tenant domain is required/);
    expect(() => tenantStorefrontBaseUrl(null, {})).toThrow(/tenant domain is required/);
    expect(() => tenantStorefrontBaseUrl('', {})).toThrow(/tenant domain is required/);
    expect(() => tenantStorefrontBaseUrl('   ', {})).toThrow(/tenant domain is required/);
  });

  it('throws for anything that is not a bare host', () => {
    for (const bad of [
      'https://tienda.example.com',
      'tienda.example.com/pago',
      'tienda.example.com?a=1',
      'user@tienda.example.com',
      'tienda example.com',
      'tienda.example.com#x',
      'tienda.example.com\\evil.com',
    ]) {
      expect(() => tenantStorefrontBaseUrl(bad, {})).toThrow(/must be a bare host/);
    }
  });

  // Validation is a URL round trip, NOT a `[a-z0-9.-]` allowlist: an allowlist
  // tight enough to be meaningful also rejects domains a merchant can really
  // own, and rejecting one would 500 their whole checkout.
  it('accepts a legitimately-registrable host an ASCII allowlist would have rejected', () => {
    // Internationalized domain stored in raw Unicode — normalized to the
    // punycode form a payment gateway actually wants.
    expect(tenantStorefrontBaseUrl('tiendañ.com', {})).toBe('https://xn--tienda-1wa.com');
    // Underscore: not RFC 1123, but seen in practice and harmless in an origin.
    expect(tenantStorefrontBaseUrl('mi_tienda.example.com', {})).toBe('https://mi_tienda.example.com');
  });

  it('drops a redundant default port', () => {
    expect(tenantStorefrontBaseUrl('tienda.example.com:443', {})).toBe('https://tienda.example.com');
    expect(tenantStorefrontBaseUrl('demo.ventia.localhost:80', {})).toBe('http://demo.ventia.localhost');
  });

  it('produces a value the payments package’s own validator accepts', () => {
    // Cross-package contract check: this is the exact string that lands on
    // `OrderForPayment.storefrontBaseUrl`, and `requireStorefrontBaseUrl` is
    // what every adapter runs it through before building a redirect.
    expect(requireStorefrontBaseUrl(tenantStorefrontBaseUrl('tienda.example.com', {}), 'wompi')).toBe(
      'https://tienda.example.com',
    );
    expect(
      requireStorefrontBaseUrl(tenantStorefrontBaseUrl('demo-moda.ventia.localhost', {}), 'epayco'),
    ).toBe('http://demo-moda.ventia.localhost');
  });
});
