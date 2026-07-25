import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import express from 'express';
import { toNodeHandler } from 'better-auth/node';
import { AppModule } from './app.module';
import { AUTH_INSTANCE, type AuthInstance } from './admin/auth-instance';

export async function createApp(): Promise<INestApplication> {
  // bodyParser: false — better-auth's toNodeHandler needs the raw (unparsed)
  // request stream for /v1/auth/*; express.json() is mounted after it below
  // so every other route still gets a parsed body.
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'], bodyParser: false });
  // Reuse the single better-auth instance created by AdminModule's AUTH_INSTANCE
  // provider (one instance, not a second one built here) — see src/admin/auth-instance.ts.
  const auth = app.get<AuthInstance>(AUTH_INSTANCE);
  const httpAdapter = app.getHttpAdapter().getInstance() as express.Express;
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
  })();
}
