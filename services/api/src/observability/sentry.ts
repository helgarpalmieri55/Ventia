import type { NodeOptions } from '@sentry/node';
import { scrubBreadcrumb, scrubEventOrDrop, type TelemetryBreadcrumb, type TelemetryEvent } from './scrub';

/**
 * Sentry wiring (docs/SPEC.md §9 "Sentry alerts").
 *
 * ## Three properties this module is built around
 *
 * 1. **Unset `SENTRY_DSN` is a clean, complete no-op.** Not "starts and fails
 *    to send", not "throws at boot": every dev machine and most deployments
 *    of this platform run with no DSN, so that is the NORMAL path and it must
 *    cost nothing. Concretely, `@sentry/node` is not even imported until a
 *    valid DSN has been found — the `await import(...)` below sits after the
 *    guards, so with no DSN the SDK's ~700-package OpenTelemetry tree is
 *    never loaded, nothing patches `http`, and no `uncaughtException` handler
 *    is installed.
 * 2. **Tests never initialize it.** Two independent reasons: `main.ts` calls
 *    this only from its `require.main === module` real-boot branch (which no
 *    test's import graph reaches — the same discipline the four BullMQ
 *    workers already follow), AND {@link initSentry} refuses outright when it
 *    sees `VITEST`/`NODE_ENV=test` in the environment it is handed. Either
 *    alone would do; both means neither can be removed by accident.
 * 3. **Nothing personal leaves the process.** See scrub.ts. Every hook the
 *    SDK offers before serialization is wired to it, and a scrubber that
 *    throws drops the event rather than passing it through.
 *
 * ## Environment
 *
 * | Variable | Meaning |
 * |---|---|
 * | `SENTRY_DSN` | The project DSN. **Unset ⇒ disabled.** |
 * | `SENTRY_ENVIRONMENT` | Tag on every event; defaults to `NODE_ENV`, else `development`. |
 * | `SENTRY_RELEASE` | Optional release identifier (a git sha in CI). |
 * | `SENTRY_TRACES_SAMPLE_RATE` | Defaults to `0` — see below. |
 *
 * Deliberately NOT added to `packages/core`'s `loadEnv` schema: that schema
 * throws the whole process at boot on a bad value, which is right for
 * `PAYMENTS_ENCRYPTION_KEY` (a wrong key silently produces garbage
 * ciphertext) and wrong here. A typo in a telemetry DSN must not take a
 * merchant's storefront offline. It is logged loudly and reporting stays off
 * — the one state this module treats as an error rather than a preference.
 *
 * ## Why `tracesSampleRate` defaults to 0
 *
 * Performance tracing is a separate product decision with a separate privacy
 * profile: a transaction event carries the full URL of every span, including
 * outbound HTTP to gateways, and it is billed per unit. Errors are what §9
 * asked for. Set the variable to opt in.
 */

/** The outcome of {@link initSentry}. Returned rather than thrown so callers
 * (and tests) can assert on the exact reason reporting is off. */
export type SentryStatus =
  | { enabled: false; reason: 'no-dsn' | 'test-environment' | 'invalid-dsn' | 'sdk-unavailable' }
  | { enabled: true; environment: string; host: string };

/**
 * A DSN is `https://<publicKey>@<host>/<projectId>`. Checked before the SDK
 * sees it so a malformed value produces one clear log line here, rather than
 * an SDK-internal warning that is easy to miss in a boot log.
 */
const DSN_RE = /^https?:\/\/[^:@/\s]+(?::[^@/\s]*)?@[^/\s]+\/\d+$/;

/** Populated only on a successful init. The module-level handle is what makes
 * {@link captureError} a genuine no-op when disabled: with no DSN this stays
 * `null` and every call returns immediately without touching the SDK. */
let sdk: typeof import('@sentry/node') | null = null;
let status: SentryStatus = { enabled: false, reason: 'no-dsn' };

/** Reporting state, for the queue-health endpoint and for tests. */
export function sentryStatus(): SentryStatus {
  return status;
}

/**
 * Initializes error reporting. Call ONCE, before Nest bootstraps, so that a
 * failure inside `createApp()` (a bad module graph, an unreachable database
 * at first connect) is captured too — that is the class of error nobody is
 * watching a terminal for.
 *
 * `env` is a parameter rather than a direct `process.env` read so tests can
 * hand in a controlled environment; the default is the real one.
 */
export async function initSentry(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<NodeOptions> = {},
): Promise<SentryStatus> {
  // Refusal #1 — a test process never reports, whatever else is configured.
  // A developer with a real DSN in their shell must not have `pnpm test`
  // start filing their local test failures as production incidents.
  if (env.VITEST || env.NODE_ENV === 'test') {
    status = { enabled: false, reason: 'test-environment' };
    return status;
  }

  const dsn = env.SENTRY_DSN?.trim();
  // Refusal #2 — the normal case. Silent: an unset DSN is a configuration
  // choice, not a problem, and a warning on every boot of every dev machine
  // is a warning nobody reads.
  if (!dsn) {
    status = { enabled: false, reason: 'no-dsn' };
    return status;
  }

  if (!DSN_RE.test(dsn)) {
    console.error(
      '[observability] SENTRY_DSN is set but is not a valid DSN (expected https://<key>@<host>/<projectId>) — ' +
        'error reporting is DISABLED. Fix the value or unset it.',
    );
    status = { enabled: false, reason: 'invalid-dsn' };
    return status;
  }

  let Sentry: typeof import('@sentry/node');
  try {
    // Imported here, not at module scope: see property 1 above.
    Sentry = await import('@sentry/node');
  } catch (err) {
    console.error(
      '[observability] SENTRY_DSN is set but @sentry/node could not be loaded — error reporting is DISABLED.',
      err instanceof Error ? err.message : String(err),
    );
    status = { enabled: false, reason: 'sdk-unavailable' };
    return status;
  }

  const environment = env.SENTRY_ENVIRONMENT?.trim() || env.NODE_ENV?.trim() || 'development';
  const tracesSampleRate = Number.parseFloat(env.SENTRY_TRACES_SAMPLE_RATE ?? '');

  Sentry.init({
    dsn,
    environment,
    release: env.SENTRY_RELEASE?.trim() || undefined,
    // Explicit, not defaulted: this is the switch that decides whether the
    // SDK attaches IP addresses, cookies and request bodies of its own accord.
    sendDefaultPii: false,
    tracesSampleRate: Number.isFinite(tracesSampleRate) && tracesSampleRate > 0 ? tracesSampleRate : 0,
    // Every hook that runs before an envelope is serialized, all pointing at
    // the same scrubber. `beforeBreadcrumb` is not redundant with the
    // breadcrumb pass inside `beforeSend`: it cleans each crumb as it is
    // RECORDED, so personal data never sits in the in-memory ring buffer
    // waiting for an error that may attach it to a different request.
    // The casts cross from the SDK's exact event types to this module's
    // structural {@link TelemetryEvent}; `TransactionEvent` is not exported
    // from `@sentry/node`'s public surface, so `typeof event` is used to
    // stay pinned to whatever the SDK declares here.
    beforeSend: (event) => scrubEventOrDrop(event as unknown as TelemetryEvent) as unknown as typeof event | null,
    beforeSendTransaction: (event) =>
      scrubEventOrDrop(event as unknown as TelemetryEvent) as unknown as typeof event | null,
    beforeBreadcrumb: (breadcrumb) =>
      scrubBreadcrumb(breadcrumb as unknown as TelemetryBreadcrumb) as unknown as typeof breadcrumb,
    initialScope: { tags: { service: 'api' } },
    ...overrides,
  });

  sdk = Sentry;
  status = { enabled: true, environment, host: new URL(dsn).host };
  console.log(`[observability] Sentry error reporting enabled (environment=${environment})`);
  return status;
}

/**
 * Context attached to a captured error. Deliberately narrow, and deliberately
 * NOT a free-form bag: SPEC §9's requirement is actionable alerts, and what
 * makes an alert actionable here is knowing which tenant and which surface —
 * not who the shopper was. Everything placed here still passes through the
 * scrubber on the way out, so this is a statement of intent rather than the
 * enforcement.
 */
export interface ErrorContext {
  /** Tenant id — an opaque uuid, not a person. The single most useful tag on
   * a multi-tenant platform: "is this one store or all of them". */
  tenantId?: string | null;
  /** Where it came from: `http`, `queue:payment-reconciliation`, … */
  source?: string;
  /** Route template or job name. */
  operation?: string;
  /** Extra scalars. Objects are accepted but get walked by the scrubber. */
  extra?: Record<string, unknown>;
}

/**
 * Reports an error, or does nothing at all if reporting is disabled.
 *
 * Never throws: a telemetry failure must not become the error the user sees.
 */
export function captureError(error: unknown, context: ErrorContext = {}): void {
  if (!sdk) return;
  try {
    sdk.withScope((scope) => {
      if (context.tenantId) scope.setTag('tenant_id', context.tenantId);
      if (context.source) scope.setTag('source', context.source);
      if (context.operation) scope.setTag('operation', context.operation);
      if (context.extra) scope.setExtras(context.extra);
      sdk!.captureException(error);
    });
  } catch (err) {
    console.error('[observability] failed to report an error to Sentry', err instanceof Error ? err.message : err);
  }
}

/**
 * Flushes pending events. Called on shutdown so a crash-then-exit does not
 * lose the very event that explains the crash. A no-op when disabled.
 */
export async function flushSentry(timeoutMs = 2000): Promise<void> {
  if (!sdk) return;
  try {
    await sdk.close(timeoutMs);
  } catch {
    // Shutdown path — there is nowhere useful left to report this.
  } finally {
    sdk = null;
  }
}

/** Test seam: forgets any initialized client without touching the SDK's own
 * globals. Exported for `test/observability-sentry.test.ts`, which inits a
 * client against a stub transport and must not leave it behind. */
export function resetSentryForTests(): void {
  sdk = null;
  status = { enabled: false, reason: 'no-dsn' };
}
