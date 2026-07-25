import { vi } from 'vitest';

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
