import { describe, expect, it } from 'vitest';
import { isSafeProxyPath } from '../lib/proxy-path';

describe('isSafeProxyPath', () => {
  it('accepts the segments these proxies actually use', () => {
    expect(isSafeProxyPath(undefined)).toBe(true);
    expect(isSafeProxyPath([])).toBe(true);
    expect(isSafeProxyPath(['me'])).toBe(true);
    expect(isSafeProxyPath(['magic-link', 'consume'])).toBe(true);
    expect(isSafeProxyPath(['password-reset', 'consume'])).toBe(true);
    expect(isSafeProxyPath(['addresses', '3f1a2b4c-0000-4000-8000-000000000001', 'default'])).toBe(true);
  });

  it('refuses the dot segments that let a path escape its prefix', () => {
    // `/v1/storefront/account` + these resolves to `/v1/admin/tenants`.
    expect(isSafeProxyPath(['..', '..', '..', 'v1', 'admin', 'tenants'])).toBe(false);
    expect(isSafeProxyPath(['..'])).toBe(false);
    expect(isSafeProxyPath(['.'])).toBe(false);
    expect(isSafeProxyPath(['me', '..', '..', 'ops'])).toBe(false);
  });

  it('refuses a segment carrying its own separator, encoded or not', () => {
    expect(isSafeProxyPath(['a/b'])).toBe(false);
    expect(isSafeProxyPath(['a\\b'])).toBe(false);
    expect(isSafeProxyPath(['%2e%2e'])).toBe(false);
    expect(isSafeProxyPath(['a%2Fb'])).toBe(false);
  });

  it('refuses an empty segment, which would collapse into a double slash', () => {
    expect(isSafeProxyPath([''])).toBe(false);
    expect(isSafeProxyPath(['me', ''])).toBe(false);
  });

  it('refuses a segment that would smuggle a query or a fragment upstream', () => {
    expect(isSafeProxyPath(['me?admin=1'])).toBe(false);
    expect(isSafeProxyPath(['me#x'])).toBe(false);
    expect(isSafeProxyPath(['me one'])).toBe(false);
  });
});
