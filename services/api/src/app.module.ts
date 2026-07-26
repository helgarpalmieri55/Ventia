import { Inject, MiddlewareConsumer, Module, NestModule, OnApplicationShutdown } from '@nestjs/common';
import Redis from 'ioredis';
import { platformDb } from '@ventia/db';
import { AdminModule } from './admin/admin.module';
import { CatalogModule } from './catalog/catalog.module';
import { CheckoutModule } from './checkout/checkout.module';
import { HealthController } from './health/health.controller';
import { OnboardingModule } from './onboarding/onboarding.module';
import { OrdersModule } from './orders/orders.module';
import { SettingsModule } from './settings/settings.module';
import { StaffModule } from './staff/staff.module';
import { StorefrontModule } from './storefront/storefront.module';
import { DomainResolver } from './tenants/domain-resolver';
import { TenantMiddleware } from './tenants/tenant.middleware';
import { TenantController } from './tenants/tenant.controller';

export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

@Module({
  imports: [
    AdminModule,
    CatalogModule,
    CheckoutModule,
    OnboardingModule,
    OrdersModule,
    SettingsModule,
    StaffModule,
    StorefrontModule,
  ],
  controllers: [HealthController, TenantController],
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
    {
      provide: DomainResolver,
      useFactory: (redis: Redis) => new DomainResolver(redis, platformDb),
      inject: [REDIS_CLIENT],
    },
    TenantMiddleware,
  ],
})
export class AppModule implements NestModule, OnApplicationShutdown {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async onApplicationShutdown() {
    // Nest calls this from app.close() (tests) as well as from OS shutdown
    // signals when enableShutdownHooks() is used (runtime) — either way, quit
    // the client so sockets/reconnect timers don't leak past app shutdown.
    try {
      await this.redis.quit();
    } catch {
      this.redis.disconnect();
    }
  }

  configure(consumer: MiddlewareConsumer) {
    // Health checks must not depend on DB/Redis connectivity, so they are
    // excluded from tenant resolution (deviation from the brief's literal
    // `forRoutes('*')`, documented in the task-8 report).
    consumer.apply(TenantMiddleware).exclude('v1/health').forRoutes('*');
  }
}
