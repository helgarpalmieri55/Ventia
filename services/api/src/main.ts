import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import express from 'express';
import cookieParser from 'cookie-parser';
import { toNodeHandler } from 'better-auth/node';
import { AppModule } from './app.module';
import { AUTH_INSTANCE, type AuthInstance } from './admin/auth-instance';
import { StockReservationWorker } from './payments/stock-reservation.worker';

export async function createApp(): Promise<INestApplication> {
  // bodyParser: false — better-auth's toNodeHandler needs the raw (unparsed)
  // request stream for /v1/auth/*; express.json() is mounted after it below
  // so every other route still gets a parsed body.
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'], bodyParser: false });
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
  })();
}
