import { describe, expect, it, vi } from 'vitest';
import { fetchGateway, GATEWAY_TIMEOUT_MS } from '../src/http';

/** A fetch that never resolves on its own — it settles only when the signal it
 * was handed aborts. This is the failure this module exists for: not a
 * connection error, but a socket that connects and then goes quiet, which
 * `fetch` alone will wait on forever. */
function stalledFetch(): typeof fetch {
  return vi.fn((_url: string | URL | Request, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return; // no signal => genuinely hangs, and the test times out
      signal.addEventListener('abort', () => reject(signal.reason as Error), { once: true });
    });
  }) as unknown as typeof fetch;
}

function okFetch(): typeof fetch {
  return vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
}

describe('fetchGateway — the bound', () => {
  it('aborts a stalled request instead of waiting forever', async () => {
    const impl = stalledFetch();

    await expect(
      fetchGateway(impl, 'wompi getTransactionStatus', 'https://api.wompi.co/v1/transactions/abc', {}, 20),
    ).rejects.toThrow(/timed out after 20ms/);
  });

  it('names the provider and endpoint, not "The operation was aborted"', async () => {
    // The whole point of rewriting the error. `AbortSignal.timeout` rejects
    // with a bare DOMException whose message identifies nothing — which is
    // what an operator would otherwise find in the logs of a payment that did
    // not go through.
    const impl = stalledFetch();

    const err = await fetchGateway(
      impl,
      'epayco getTransactionStatus',
      'https://secure.epayco.co/validation/v1/reference/ref-1',
      {},
      20,
    ).catch((e: unknown) => e as Error);

    expect(err.message).toContain('epayco getTransactionStatus');
    expect(err.message).toContain('/validation/v1/reference/ref-1');
    expect(err.message).toContain('20ms');
    expect(err.message).not.toContain('The operation was aborted');
  });

  it('drops the query string, keeping the path', async () => {
    const impl = stalledFetch();

    const err = await fetchGateway(
      impl,
      'mercadopago searchByReference',
      'https://api.mercadopago.com/v1/payments/search?external_reference=5001&access_token=SECRET',
      {},
      20,
    ).catch((e: unknown) => e as Error);

    expect(err.message).toContain('/v1/payments/search');
    expect(err.message).not.toContain('SECRET');
    expect(err.message).not.toContain('external_reference=5001');
  });

  it('defaults to the one shared bound', () => {
    // Guards the constant itself: a value low enough to abort healthy calls
    // would turn a working gateway into a broken one, and a value high enough
    // to sit above a typical 30s proxy read timeout would mean something
    // upstream fails first with a generic error instead.
    expect(GATEWAY_TIMEOUT_MS).toBeGreaterThanOrEqual(5_000);
    expect(GATEWAY_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
  });
});

describe('fetchGateway — what it does NOT change', () => {
  it('passes the request through untouched on the happy path', async () => {
    const impl = okFetch();

    const res = await fetchGateway(impl, 'wompi getTransactionStatus', 'https://api.wompi.co/v1/transactions/abc', {
      headers: { Authorization: 'Bearer pub_test_1' },
    });

    expect(res.status).toBe(200);
    const [url, init] = (impl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0];
    expect(url).toBe('https://api.wompi.co/v1/transactions/abc');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer pub_test_1');
    // The signal is added, not substituted for the caller's own init.
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('re-throws a non-timeout failure unchanged', async () => {
    // DNS/connection/TLS errors already say what went wrong. Wrapping them in
    // a timeout message would bury the actual cause.
    const impl = vi.fn(async () => {
      throw new Error('getaddrinfo ENOTFOUND api.wompi.co');
    }) as unknown as typeof fetch;

    await expect(
      fetchGateway(impl, 'wompi getTransactionStatus', 'https://api.wompi.co/v1/transactions/abc'),
    ).rejects.toThrow('getaddrinfo ENOTFOUND api.wompi.co');
  });

  it('does not blame the timeout for a caller-supplied abort', async () => {
    // Both aborts surface here as the same kind of DOMException, so the
    // timeout is identified by its OWN signal rather than by the error's name
    // — otherwise a cancelled request would send someone hunting a slow
    // gateway that was never slow.
    const caller = new AbortController();
    const impl = stalledFetch();

    const promise = fetchGateway(
      impl,
      'wompi getTransactionStatus',
      'https://api.wompi.co/v1/transactions/abc',
      { signal: caller.signal },
      10_000,
    );
    caller.abort(new Error('shutting down'));

    await expect(promise).rejects.toThrow('shutting down');
    await expect(promise).rejects.not.toThrow(/timed out/);
  });

  it('still applies the timeout when the caller supplies its own signal', async () => {
    // The composition has to work in both directions: a caller signal must not
    // silently replace the bound.
    const caller = new AbortController();
    const impl = stalledFetch();

    await expect(
      fetchGateway(
        impl,
        'wompi getTransactionStatus',
        'https://api.wompi.co/v1/transactions/abc',
        { signal: caller.signal },
        20,
      ),
    ).rejects.toThrow(/timed out after 20ms/);
  });
});
