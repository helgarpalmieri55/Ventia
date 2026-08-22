import { Inject, MiddlewareConsumer, Module, NestModule, OnApplicationShutdown } from '@nestjs/common';
import type Redis from 'ioredis';
import { platformDb } from '@ventia/db';
import { AdminModule } from './admin/admin.module';
import { AgentModule } from './agent/agent.module';
import { CatalogModule } from './catalog/catalog.module';
import { CheckoutModule } from './checkout/checkout.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { HealthController } from './health/health.controller';
import { ObservabilityModule } from './observability/observability.module';
import { OnboardingModule } from './onboarding/onboarding.module';
import { OpsModule } from './ops/ops.module';
import { OrdersModule } from './orders/orders.module';
import { PaymentAlertsModule } from './payment-alerts/payment-alerts.module';
import { SettingsModule } from './settings/settings.module';
import { ShopperModule } from './shopper/shopper.module';
import { StaffModule } from './staff/staff.module';
import { PlatformModule } from './platform/platform.module';
import { PrivacyModule } from './privacy/privacy.module';
import { StorefrontModule } from './storefront/storefront.module';
import { WhatsAppModule } from './whatsapp/whatsapp.module';
import { RedisModule, REDIS_CLIENT } from './common/redis.module';
import { DomainResolver } from './tenants/domain-resolver';
import { TenantMiddleware } from './tenants/tenant.middleware';
import { TenantController } from './tenants/tenant.controller';
import { CustomDomainsController, TlsAskController } from './tenants/custom-domains.controller';
import { CustomDomainsService } from './tenants/custom-domains.service';

// Re-exported from its own module (see common/redis.module.ts for why it moved)
// so `main.ts` and existing imports keep the same source.
export { REDIS_CLIENT };

@Module({
  imports: [
    RedisModule,
    AdminModule,
    AgentModule,
    CatalogModule,
    CheckoutModule,
    DashboardModule,
    ObservabilityModule,
    OnboardingModule,
    OpsModule,
    OrdersModule,
    PaymentAlertsModule,
    SettingsModule,
    ShopperModule,
    StaffModule,
    PlatformModule,
    PrivacyModule,
    StorefrontModule,
    WhatsAppModule,
  ],
  controllers: [HealthController, TenantController, TlsAskController, CustomDomainsController],
  providers: [
    {
      provide: DomainResolver,
      useFactory: (redis: Redis) => new DomainResolver(redis, platformDb),
      inject: [REDIS_CLIENT],
    },
    TenantMiddleware,
    CustomDomainsService,
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
