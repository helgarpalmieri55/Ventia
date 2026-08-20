import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module';
import { PlatformAdminGuard } from '../platform/platform-admin.guard';
import { QueueHealthController } from './queue-health.controller';
import { QueueHealthService } from './queue-health.service';

/**
 * Observability (docs/SPEC.md §9): Sentry wiring lives in `sentry.ts` and is
 * called from `main.ts` before Nest exists, so it needs no provider. What
 * this module contributes is the operator-facing queue-health route.
 *
 * `AdminModule` is imported ONLY for its `AUTH_INSTANCE` export, which
 * `PlatformAdminGuard` needs to read a session cookie — the same reason
 * `PlatformModule` imports it. The guard is registered here as a provider so
 * this module can be built independently; it is the exact class from
 * `platform/platform-admin.guard.ts`, not a variant.
 *
 * Registering this module starts NOTHING: `QueueHealthService` opens its
 * Redis connection on first use, not in a constructor or a lifecycle hook, so
 * every test file that builds `AppModule` still opens no queue.
 */
@Module({
  imports: [AdminModule],
  controllers: [QueueHealthController],
  providers: [PlatformAdminGuard, QueueHealthService],
})
export class ObservabilityModule {}
