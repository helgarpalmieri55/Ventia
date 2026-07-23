import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from './app.module';

export async function createApp(): Promise<INestApplication> {
  return NestFactory.create(AppModule, { logger: ['error', 'warn'] });
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
