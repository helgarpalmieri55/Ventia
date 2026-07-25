import { describe, expect, it, vi } from 'vitest';
import { fetchStorefront, fetchStorefrontOrNull, StorefrontApiError } from '../lib/storefront-api';

describe('fetchStorefront', () => {
  it('returns parsed json on 2xx', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    expect(await fetchStorefront('demo.ventia.localhost', '/v1/storefront/categories', fetchImpl)).toEqual({
      ok: true,
    });
  });

  it('returns null on 404', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{}', { status: 404 }));
    expect(await fetchStorefront('demo.ventia.localhost', '/v1/storefront/content/faq', fetchImpl)).toBeNull();
  });

  it('throws StorefrontApiError with the status on other non-2xx', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{}', { status: 503 }));
    await expect(fetchStorefront('demo.ventia.localhost', '/v1/storefront/categories', fetchImpl)).rejects.toThrow(
      StorefrontApiError,
    );
  });
});

describe('fetchStorefrontOrNull', () => {
  it('degrades a StorefrontApiError to null', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{}', { status: 503 }));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await fetchStorefrontOrNull('demo.ventia.localhost', '/v1/storefront/categories', fetchImpl)).toBeNull();
    errorSpy.mockRestore();
  });

  it('still returns real data on success', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify([{ slug: 'ropa' }]), { status: 200 }));
    expect(await fetchStorefrontOrNull('demo.ventia.localhost', '/v1/storefront/categories', fetchImpl)).toEqual([
      { slug: 'ropa' },
    ]);
  });
});
