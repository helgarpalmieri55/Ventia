import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import Redis from 'ioredis';
import { platformDb } from '@ventia/db';
import { HealthController } from './health/health.controller';
import { DomainResolver } from './tenants/domain-resolver';
import { TenantMiddleware } from './tenants/tenant.middleware';
import { TenantController } from './tenants/tenant.controller';

@Module({
  controllers: [HealthController, TenantController],
  providers: [
    {
      provide: DomainResolver,
      useFactory: () =>
        new DomainResolver(new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379'), platformDb),
    },
    TenantMiddleware,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Health checks must not depend on DB/Redis connectivity, so they are
    // excluded from tenant resolution (deviation from the brief's literal
    // `forRoutes('*')`, documented in the task-8 report).
    consumer.apply(TenantMiddleware).exclude('v1/health').forRoutes('*');
  }
}
