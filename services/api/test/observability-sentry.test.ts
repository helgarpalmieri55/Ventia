import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  captureError,
  flushSentry,
  initSentry,
  resetSentryForTests,
  sentryStatus,
} from '../src/observability/sentry';
import { REDACTED_EMAIL, REDACTED_ID, REDACTED_PHONE } from '../src/observability/scrub';

/**
 * Sentry wiring (docs/SPEC.md §9).
 *
 * Two things are proven here, and the first matters more:
 *
 * 1. **Unset `SENTRY_DSN` is a clean no-op.** Not "starts and silently
 *    fails" — nothing initializes, nothing is imported, `captureError` is
 *    inert, and none of it throws. That is the state every dev machine and
 *    most deployments run in, so it is the state that must be tested first.
 * 2. **With a DSN, nothing personal leaves the process.** No real DSN exists
 *    for this project, so the proof is built the only honest way available:
 *    the REAL `@sentry/node` client is initialized against a stub transport
 *    that captures the envelope instead of sending it. The scrubbing that is
 *    asserted is therefore the SDK's own `beforeSend` pipeline running, not a
 *    direct call to our function.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));

afterEach(async () => {
  await flushSentry(100);
  resetSentryForTests();
  vi.restoreAllMocks();
});

describe('an unset SENTRY_DSN', () => {
  it('disables reporting cleanly, without throwing', async () => {
    const status = await initSentry({});
    expect(status).toEqual({ enabled: false, reason: 'no-dsn' });
    expect(sentryStatus()).toEqual({ enabled: false, reason: 'no-dsn' });
  });

  it('says nothing on the console — an absent DSN is a choice, not a problem', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await initSentry({ SENTRY_DSN: '   ' }); // blank counts as unset
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('makes captureError and flushSentry inert rather than absent', async () => {
    await initSentry({});
    expect(() => captureError(new Error('boom'), { tenantId: 't1', source: 'http' })).not.toThrow();
    await expect(flushSentry()).resolves.toBeUndefined();
  });
});

describe('refusals', () => {
  it('refuses to initialize in a test process even with a valid DSN', async () => {
    // `process.env` in this suite carries VITEST. This is the second,
    // independent guard: main.ts already only calls initSentry() from its
    // real-boot branch, but a developer with SENTRY_DSN exported in their
    // shell must never have `pnpm test` file their test failures as
    // production incidents.
    expect(process.env.VITEST).toBeTruthy();
    process.env.SENTRY_DSN = 'https://abc123def456@o0.ingest.sentry.io/42';
    try {
      expect(await initSentry()).toEqual({ enabled: false, reason: 'test-environment' });
    } finally {
      delete process.env.SENTRY_DSN;
    }
  });

  it('refuses a malformed DSN loudly, and stays off rather than crashing the process', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const status = await initSentry({ SENTRY_DSN: 'not-a-dsn' });
    expect(status).toEqual({ enabled: false, reason: 'invalid-dsn' });
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[0]).toContain('DISABLED');
  });
});

describe('the SDK is not even loaded until a DSN is found', () => {
  const source = readFileSync(path.resolve(__dirname, '../src/observability/sentry.ts'), 'utf8');

  it('imports @sentry/node at module scope only as a type', () => {
    // A structural assertion, because the behaviour it protects is invisible:
    // a top-level runtime import would drag ~700 OpenTelemetry packages into
    // every boot of a DSN-less deployment and patch `http` for nothing.
    for (const line of source.split('\n')) {
      if (line.includes("from '@sentry/node'") && !line.trimStart().startsWith('import type')) {
        throw new Error(`module-scope runtime import of @sentry/node: ${line}`);
      }
    }
    expect(source).toContain("import type { NodeOptions } from '@sentry/node';");
  });

  it('places the dynamic import after every refusal', () => {
    const dynamicImport = source.indexOf("await import('@sentry/node')");
    expect(dynamicImport).toBeGreaterThan(-1);
    for (const guard of ["reason: 'test-environment'", "reason: 'no-dsn'", "reason: 'invalid-dsn'"]) {
      expect(source.indexOf(guard), guard).toBeLessThan(dynamicImport);
    }
  });
});

describe('with a DSN, against a stub transport (no real project exists)', () => {
  /** Captures what the SDK would have sent. `send` never touches the network:
   * that is the point — this suite proves the shape of an outgoing event
   * without one byte leaving the process. */
  function stubTransport() {
    const events: Array<Record<string, unknown>> = [];
    const transport = () => ({
      send: async (envelope: unknown) => {
        const items = (envelope as [unknown, Array<[unknown, unknown]>])[1];
        for (const [, payload] of items) events.push(payload as Record<string, unknown>);
        return {};
      },
      flush: async () => true,
    });
    return { events, transport };
  }

  async function initWithStub() {
    const { events, transport } = stubTransport();
    const status = await initSentry(
      // A syntactically valid DSN for a project that does not exist. The
      // transport below means it is never dialled.
      { SENTRY_DSN: 'https://abc123def456@o0.ingest.sentry.io/42', SENTRY_ENVIRONMENT: 'test-stub' },
      {
        transport: transport as never,
        // Keep the SDK's global side effects out of the test process: no
        // http patching, no OpenTelemetry, no uncaughtException handlers.
        defaultIntegrations: false,
        skipOpenTelemetrySetup: true,
      },
    );
    expect(status).toEqual({ enabled: true, environment: 'test-stub', host: 'o0.ingest.sentry.io' });
    return events;
  }

  it('reports an error, scrubbed, with the tenant id kept', async () => {
    const events = await initWithStub();

    captureError(
      new Error('no se pudo cobrar: ana.gomez@correo.co / +57 301 234 5678 / cc 1020345678'),
      { tenantId: '7f9c1a2b-4d5e-4f60-9a1b-2c3d4e5f6071', source: 'http', operation: 'POST /v1/storefront/checkout' },
    );
    await flushSentry();

    expect(events).toHaveLength(1);
    const event = events[0] as {
      exception: { values: Array<{ value: string }> };
      tags: Record<string, string>;
    };
    expect(event.exception.values[0]?.value).toBe(
      `no se pudo cobrar: ${REDACTED_EMAIL} / ${REDACTED_PHONE} / cc ${REDACTED_ID}`,
    );
    expect(event.tags.tenant_id).toBe('7f9c1a2b-4d5e-4f60-9a1b-2c3d4e5f6071');
    expect(event.tags.source).toBe('http');
    expect(JSON.stringify(event)).not.toContain('ana.gomez@correo.co');
  });

  it('scrubs data attached through the SDK, not just through captureError', async () => {
    const events = await initWithStub();
    const Sentry = await import('@sentry/node');

    // Straight through the SDK's own API, bypassing every helper in
    // observability/sentry.ts — the scrubbing must be a property of the
    // client, not of our wrapper.
    Sentry.withScope((scope) => {
      scope.setExtras({
        customerName: 'Ana María Gómez Restrepo',
        cookie: 'better-auth.session_token=8f3c1d9a4b7e2f60c5a1b8d3e9f4a2c7',
        note: 'llamar al 3012345678',
      });
      Sentry.captureMessage('pedido rechazado');
    });
    await flushSentry();

    const serialized = JSON.stringify(events[0]);
    expect(serialized).not.toContain('Ana María Gómez Restrepo');
    expect(serialized).not.toContain('8f3c1d9a4b7e2f60c5a1b8d3e9f4a2c7');
    expect(serialized).not.toContain('3012345678');
  });
});
