import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import express from 'express';
import { toNodeHandler } from 'better-auth/node';
import { platformDb } from '@ventia/db';
import { AppModule } from './app.module';
import { createAuth } from './auth/auth';

export async function createApp(): Promise<INestApplication> {
  // bodyParser: false — better-auth's toNodeHandler needs the raw (unparsed)
  // request stream for /v1/auth/*; express.json() is mounted after it below
  // so every other route still gets a parsed body.
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'], bodyParser: false });
  const auth = createAuth(platformDb, {
    secret: process.env.AUTH_SECRET ?? 'dev-secret-change-me',
    baseURL: process.env.API_URL ?? 'http://api.ventia.localhost',
  });
  const httpAdapter = app.getHttpAdapter().getInstance() as express.Express;
  httpAdapter.all('/v1/auth/*', toNodeHandler(auth));
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
