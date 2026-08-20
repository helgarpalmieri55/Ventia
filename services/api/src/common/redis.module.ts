import { Module } from '@nestjs/common';
import Redis from 'ioredis';

/**
 * The one shared Redis connection, in a module of its own.
 *
 * It used to be a provider on `AppModule` directly, which was fine while the
 * only consumers were `AppModule` itself and `main.ts`. A FEATURE module
 * cannot inject it from there — `AppModule` is not global, and importing
 * `AppModule` from a feature module is a cycle both in Nest's graph and in the
 * TypeScript import graph (`app.module.ts` imports every feature module, so
 * the symbol would be read before it is defined).
 *
 * Extracting it to a leaf module fixes both: nothing here imports a feature,
 * so anything may import this.
 */
export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      useFactory: () => {
        const client = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
        // Without this listener, ioredis logs unhandled "error" events straight
        // to stderr (e.g. connection-refused noise in tests) and, on some
        // versions/paths, an unhandled 'error' event with no listener can throw.
        client.on('error', (err) => console.error('[redis]', err.message));
        return client;
      },
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule {}
