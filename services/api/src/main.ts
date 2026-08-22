import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import express from 'express';
import cookieParser from 'cookie-parser';
import type Redis from 'ioredis';
import { toNodeHandler } from 'better-auth/node';
import { AppModule, REDIS_CLIENT } from './app.module';
import { SentryExceptionFilter } from './observability/sentry-exception.filter';
import { captureError, flushSentry, initSentry } from './observability/sentry';
import { AUTH_INSTANCE, type AuthInstance } from './admin/auth-instance';
import { clientIp, createRateLimiter, RATE_LIMITS } from './common/rate-limit';
import { ReconciliationWorker } from './payments/reconciliation.worker';
import { StockReservationWorker } from './payments/stock-reservation.worker';
import { ConversationRetentionWorker } from './agent/conversation-retention.worker';
import { SubscriptionSweepWorker } from './platform/subscription-sweep.worker';
import { OpsPushWorker } from './ops/ops-push.worker';
import { ShopperSessionCleanupWorker } from './shopper/shopper-session.worker';

export async function createApp(): Promise<INestApplication> {
  // bodyParser: false — better-auth's toNodeHandler needs the raw (unparsed)
  // request stream for /v1/auth/*; express.json() is mounted after it below
  // so every other route still gets a parsed body.
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'], bodyParser: false });
  // Reports unhandled 5xx to Sentry and then defers to Nest's own exception
  // handling, unchanged (see the filter's doc comment on why it extends
  // BaseExceptionFilter rather than formatting a response of its own).
  //
  // Registered here, inside createApp(), rather than only in the real-boot
  // branch below — so that the ~60 test files that boot through this factory
  // exercise the same error path production uses. It costs them nothing:
  // `captureError` returns immediately while Sentry is uninitialized, which
  // in a test process it always is (see observability/sentry.ts).
  app.useGlobalFilters(new SentryExceptionFilter(app.getHttpAdapter()));
  // Reuse the single better-auth instance created by AdminModule's AUTH_INSTANCE
  // provider (one instance, not a second one built here) — see src/admin/auth-instance.ts.
  const auth = app.get<AuthInstance>(AUTH_INSTANCE);
  const httpAdapter = app.getHttpAdapter().getInstance() as express.Express;
  // Populates req.cookies for CartCookieGuard (and any future cookie
  // consumer) — better-auth parses its own session cookie internally, not
  // via Express's req.cookies, so this was never wired up before. No
  // interaction with the body-parser ordering below; mounted early in the
  // middleware chain since cookie parsing is cheap and side-effect-free.
  httpAdapter.use(cookieParser());

  // Rate limiting (docs/SPEC.md §9). Mounted here, on the Express adapter,
  // rather than as Nest guards — `/v1/auth/*` below is handled by better-auth
  // before Nest routing ever sees it, and those are the endpoints that most
  // need limiting.
  //
  // `trust proxy` is what makes IP-based limiting meaningful at all: the API
  // runs behind Caddy (docker/Caddyfile), so without it every request carries
  // the proxy's address and one abusive client would spend everybody's budget.
  // Set to 1 — trust exactly one hop — rather than `true`: `true` takes the
  // left-most X-Forwarded-For entry, which the CLIENT supplies and can forge,
  // letting an attacker mint a fresh identity per request and bypass the limit
  // entirely. One hop means the address comes from Caddy's own appended entry.
  // A deployment that adds another proxy in front must raise this to match, or
  // limiting silently keys on the wrong address again.
  httpAdapter.set('trust proxy', 1);
  const redis = app.get<Redis>(REDIS_CLIENT);

  // Auth: the credential-stuffing / signup-spam / verification-email-flood
  // surface. Keyed by IP alone — not IP+email — so that trying 200 different
  // emails from one address costs the same budget as retrying one, which is
  // the attack that actually matters here.
  httpAdapter.use(
    '/v1/auth',
    createRateLimiter(redis, {
      name: 'auth',
      limit: RATE_LIMITS.auth(),
      windowSeconds: 60,
      key: clientIp,
      errorCode: 'TOO_MANY_REQUESTS',
    }),
  );

  // Checkout: order-creation spam. Each accepted request decrements stock and
  // holds a reservation for 15 minutes, so a flood here is not merely load —
  // it can empty a merchant's sellable inventory without a single payment.
  // Keyed by IP; the limit is generous enough that a shopper retrying a
  // declined card, or several shoppers behind one NAT, never sees it.
  httpAdapter.use(
    '/v1/storefront/checkout',
    createRateLimiter(redis, {
      name: 'checkout',
      limit: RATE_LIMITS.checkout(),
      windowSeconds: 60,
      key: clientIp,
      errorCode: 'TOO_MANY_REQUESTS',
    }),
  );

  // Agent: the only surface where an accepted request spends the MERCHANT's
  // money rather than ours — every turn can be a model call against their
  // monthly AI allowance. The per-conversation throttle
  // (agent/agent-throttle.service.ts) is what shapes a single chat; this
  // address-keyed limit is what stops a script from evading that throttle by
  // starting a fresh conversation for every message.
  httpAdapter.use(
    '/v1/storefront/agent',
    createRateLimiter(redis, {
      name: 'agent',
      limit: RATE_LIMITS.agent(),
      windowSeconds: 60,
      key: clientIp,
      errorCode: 'TOO_MANY_REQUESTS',
    }),
  );

  // Webhooks: limited LAST and most cautiously, because the failure mode here
  // is not a slow attacker, it is a dropped payment. A 429 to a gateway is a
  // delivery we refused; gateways retry, but a settle delayed is a shopper
  // charged with no order until the retry lands.
  //
  // So: keyed per TENANT rather than per IP (gateway callbacks all originate
  // from a handful of the gateway's own addresses, so an IP key would put
  // every merchant in one bucket and let one busy store throttle the rest),
  // with a limit far above any plausible legitimate rate for a single store.
  // The tenant comes from the URL path this endpoint already routes on. A
  // request whose path does not carry one is not limited at all rather than
  // being lumped into a shared bucket — see the `key` contract.
  httpAdapter.use(
    '/webhooks',
    createRateLimiter(redis, {
      name: 'webhooks',
      limit: RATE_LIMITS.webhooks(),
      windowSeconds: 60,
      key: (req) => {
        // `/webhooks/payments/:provider/:tenantId` — this middleware is mounted
        // on '/webhooks', so req.path is the remainder.
        //
        // `/webhooks/whatsapp/:provider` deliberately falls through to `null`
        // (no limiting). Its tenant is only knowable from `phone_number_id`
        // INSIDE the payload, and this middleware runs before the body is even
        // read — so the only key available here is the client address, which
        // for Meta is a handful of edge IPs shared by every tenant. Keying on
        // that would let one busy store throttle every other store's inbound
        // messages, which is precisely the failure the per-tenant key below
        // exists to avoid.
        //
        // What bounds that endpoint instead, in order: the provider signature
        // is verified before any work beyond one indexed lookup (so forged
        // traffic costs almost nothing), `Message.externalId` dedupes retries,
        // the per-conversation throttle caps a single shopper, and the monthly
        // budget caps the tenant. Four layers, none of which can be evaded by
        // volume from an address we cannot attribute.
        const parts = req.path.split('/').filter(Boolean);
        return parts.length >= 3 && parts[0] === 'payments' ? `${parts[1]}:${parts[2]}` : null;
      },
      errorCode: 'TOO_MANY_REQUESTS',
    }),
  );

  httpAdapter.all('/v1/auth/*', toNodeHandler(auth));
  // Path-scoped '10mb' limit ONLY for the CSV import routes (Task 8's
  // POST /v1/admin/import/*, whose own 2 MB cap is enforced in
  // csv-import.service.ts's assertCsvSize) — express.json()'s 100kb default
  // would otherwise 413 those requests at the body-parser layer with
  // express's generic error page, before our own 413 CSV_TOO_LARGE response
  // gets a chance to run. This must be mounted BEFORE the global
  // express.json() below: body-parser's json middleware skips re-parsing a
  // request whose body it (or an earlier body-parser instance) already
  // parsed, so a /v1/admin/import/* request gets the raised limit here and
  // the global middleware just passes it through, while every other route
  // still gets the conservative 100kb default.
  httpAdapter.use('/v1/admin/import', express.json({ limit: '10mb' }));
  // Path-scoped raw-body exception for the payments webhook endpoint
  // (services/api/src/payments/webhooks.controller.ts, POST
  // /webhooks/payments/:provider/:tenantId). Signature verification
  // (WompiProvider.verifyAndParseWebhook, packages/payments/src/wompi.ts)
  // needs the EXACT original bytes the gateway signed — re-serializing a
  // JSON-parsed body (different key order, whitespace, number formatting)
  // would silently produce a different string than what was hashed on the
  // sender's side, breaking the checksum even for a genuinely-untampered
  // payload. `type: '*/*'` (rather than a specific content-type matcher)
  // is deliberate: it's safer against variance in exactly what content-type
  // a real Wompi delivery sends (e.g. `application/json; charset=utf-8`
  // vs. plain `application/json`) — this route's own controller is the only
  // thing that ever reads this body, so accepting any content-type as raw
  // bytes here costs nothing.
  //
  // Must be mounted BEFORE the global express.json() below, same ordering
  // reason as the /v1/admin/import exception above: body-parser's json
  // middleware skips re-parsing a request whose body an earlier middleware
  // already parsed (or, in this case, already consumed as a raw Buffer) —
  // mounting this first means /webhooks/* requests get `req.body` as a raw
  // Buffer, and the global express.json() below passes them through
  // untouched, while every other route still gets its parsed JSON body as
  // before.
  httpAdapter.use('/webhooks', express.raw({ type: '*/*', limit: '1mb' }));
  httpAdapter.use(express.json());
  return app;
}

if (require.main === module) {
  void (async () => {
    // FIRST, before loadEnv() and before Nest builds a single provider: a
    // crash in either is exactly the class of error nobody is watching a
    // terminal for, and it is the one this must not miss. With no
    // `SENTRY_DSN` — every dev machine, and most deployments — this returns
    // `{ enabled: false, reason: 'no-dsn' }` without so much as importing the
    // SDK, so the normal path costs one string comparison.
    await initSentry();
    try {
      await boot();
    } catch (err) {
      // Boot failed: report it, wait for the report to actually leave (the
      // process is about to end, and an unflushed event is a lost one), then
      // exit non-zero so the supervisor restarts rather than parking a
      // half-dead process.
      console.error('[api] failed to start', err);
      captureError(err, { source: 'bootstrap' });
      await flushSentry();
      process.exitCode = 1;
    }
  })();
}

/**
 * The real process boot, extracted from the `require.main === module` block
 * above so that its failures are catchable — an exception thrown inside an
 * un-awaited async IIFE is an unhandled rejection, which is precisely the
 * event we most want reported and the one hardest to attach context to.
 */
async function boot(): Promise<void> {
  const { loadEnv } = await import('@ventia/core');
  const env = loadEnv();
  const app = await createApp();
  // Only needed for the real runtime process so OS shutdown signals
  // (SIGTERM/SIGINT) trigger onApplicationShutdown (e.g. Redis .quit()).
  // Tests call app.close() directly, which always runs these hooks anyway.
  app.enableShutdownHooks();
  await app.listen(env.API_PORT);
  // Starts the stock-reservation TTL-expiry BullMQ scheduling (Task 6) —
  // deliberately called ONLY here, in the real-process-boot branch, never
  // inside createApp() itself. createApp() is the same factory every test
  // file's beforeAll calls (`await createApp(); await app.init();`), so
  // anything that started real BullMQ Queue/Worker machinery from inside
  // createApp() (or from a Nest lifecycle hook any provider it constructs
  // implements) would silently start a real repeatable job + Worker
  // against every test's own ephemeral Testcontainers Postgres+Redis, on
  // every test run in this repo. StockReservationWorker (see that file's
  // doc comment) implements no such lifecycle hook — `start()` is a plain
  // method nothing but this line calls.
  await app.get(StockReservationWorker).start();
  // Starts the payment-status reconciliation BullMQ scheduling (P3c Task 4)
  // — a sibling of the line above, here for the identical reason: it is the
  // real-process-boot branch, which no test's import graph reaches.
  // ReconciliationWorker implements no Nest lifecycle hook either (see its
  // own doc comment), so registering it in PaymentsModule starts nothing on
  // its own.
  await app.get(ReconciliationWorker).start();
  // Starts the Ley 1581 conversation-retention purge (SPEC.md §9) — a third
  // sibling of the two lines above, in this branch for the identical reason.
  // ConversationRetentionWorker implements no Nest lifecycle hook either, so
  // registering it in AgentModule starts nothing on its own — which matters
  // most for THIS worker, since an accidentally-auto-started one would be
  // deleting rows in the background of every test run in this repo.
  await app.get(ConversationRetentionWorker).start();
  // Starts the subscription auto-suspend sweep (SPEC §6 M9) — a fourth
  // sibling, in this branch for the identical reason, and the one where an
  // accidental auto-start would be worst: this job SUSPENDS TENANTS, so a
  // lifecycle hook would have it taking stores offline in the background of
  // every test run and inside any process that merely built the module
  // graph. SubscriptionSweepWorker implements no Nest lifecycle hook, so
  // registering it in PlatformModule starts nothing on its own.
  await app.get(SubscriptionSweepWorker).start();

  // The OPS feed's push half. Same no-lifecycle-hook discipline as its four
  // siblings above, and it additionally no-ops unless OPS_PUSH_URL and the OPS
  // token are both set — so a deployment that only wants the pull endpoint
  // (or neither) opens no Redis connection here at all.
  await app.get(OpsPushWorker).start();

  // Expired shopper sessions and spent link tokens. Same no-lifecycle-hook
  // discipline as its siblings. The rows it removes are already inert — every
  // lookup filters on expiry — so this is about not keeping credential
  // material whose purpose has already been served.
  await app.get(ShopperSessionCleanupWorker).start();

  // Express-level errors — i.e. anything that calls `next(err)` from
  // MIDDLEWARE rather than throwing inside a controller. `TenantMiddleware`
  // is the one that matters: when domain resolution throws (a database it
  // cannot reach), it hands the error to Express, which never reaches
  // Nest's exception filter and so never reaches SentryExceptionFilter.
  //
  // Mounted HERE, after `listen()`, on purpose: Express runs error handlers
  // in registration order, and only those registered AFTER the middleware
  // that failed. Everything Nest registers — routes, and the middleware
  // from `AppModule.configure()` — is in place by this line, so an error
  // handler added now sits behind all of it. Mounting it inside
  // `createApp()` would put it in front, where it would never run.
  //
  // `next(err)` is called unconditionally: this observes, it does not
  // handle, so Express's default error response is unchanged.
  app
    .getHttpAdapter()
    .getInstance()
    .use((err: unknown, req: express.Request, _res: express.Response, next: express.NextFunction) => {
      captureError(err, {
        tenantId: req.tenant?.tenantId ?? null,
        source: 'express-middleware',
        operation: `${req.method} ${req.path}`,
      });
      next(err);
    });

  // Flush on the way down so an event captured microseconds before SIGTERM
  // is not lost with the process. Nest's shutdown hooks are already enabled
  // above; this is the last thing after them.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      void flushSentry();
    });
  }
}
