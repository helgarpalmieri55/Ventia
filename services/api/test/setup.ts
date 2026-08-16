import { vi } from 'vitest';

/**
 * Raise the rate limits for the suite.
 *
 * Every request in every test originates from 127.0.0.1, so the whole suite
 * shares ONE bucket per limiter — which the production defaults (sized for
 * real shoppers behind carrier-grade NAT, see src/common/rate-limit.ts) are
 * nowhere near. Without this, tests that legitimately make dozens of checkout
 * or auth calls start getting 429s that have nothing to do with what they are
 * asserting; that is exactly what happened when the limiter was first wired up.
 *
 * This does NOT leave the limiter untested. `test/rate-limit.test.ts` drives
 * the middleware directly with its own small limits, and
 * `test/rate-limit-wiring.test.ts` sets these vars LOW before building the app,
 * so the routes really are proven to be limited.
 *
 * Set only when absent, so a test file that wants its own values can export
 * them before this runs.
 */
for (const name of ['AUTH', 'CHECKOUT', 'WEBHOOKS']) {
  const key = `RATE_LIMIT_${name}_PER_MINUTE`;
  process.env[key] ??= '100000';
}

/**
 * Global test setup: stub fetch for /api/revalidate calls to prevent
 * real network requests during tests (especially from revalidateStorefrontTag).
 * This only affects calls to URLs containing /api/revalidate; all other
 * fetch usage delegates to the real implementation.
 */
const originalFetch = global.fetch;

const stubFetch = vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  let url: string;
  if (typeof input === 'string') {
    url = input;
  } else if (input instanceof URL) {
    url = input.toString();
  } else {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    url = (input as any).url;
  }

  // Stub /api/revalidate calls: resolve immediately without hitting the network
  if (url.includes('/api/revalidate')) {
    return Promise.resolve(new Response(null, { status: 200 }));
  }

  // Delegate all other fetch calls to the real implementation
  return originalFetch(input, init);
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
global.fetch = stubFetch as any;
