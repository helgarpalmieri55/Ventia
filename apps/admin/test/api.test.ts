import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiFetch } from '../lib/api';

describe('apiFetch', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns typed json on a 200 response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: '1', name: 'Demo' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await apiFetch<{ id: string; name: string }>('/products/1');

    expect(result).toEqual({ id: '1', name: 'Demo' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/products/1');
  });

  it('throws an ApiError with the parsed code and details on a non-2xx body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ error: 'PLAN_LIMIT_EXCEEDED', details: { limit: 10, plan: 'basico' } }),
        { status: 402, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(apiFetch('/products')).rejects.toMatchObject({
      status: 402,
      code: 'PLAN_LIMIT_EXCEEDED',
      details: { limit: 10, plan: 'basico' },
    });
  });

  it('falls back to code UNKNOWN when the error body cannot be parsed', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('not json', { status: 500 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(apiFetch('/products')).rejects.toMatchObject({
      status: 500,
      code: 'UNKNOWN',
    });
  });

  it('throws an ApiError with status 0 and code NETWORK when fetch rejects', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(apiFetch('/products')).rejects.toMatchObject({
      status: 0,
      code: 'NETWORK',
    });
  });

  it('ApiError instances carry status/code/details and are real Errors', () => {
    const error = new ApiError(404, 'NOT_FOUND', { id: '1' });
    expect(error).toBeInstanceOf(Error);
    expect(error.status).toBe(404);
    expect(error.code).toBe('NOT_FOUND');
    expect(error.details).toEqual({ id: '1' });
  });
});
