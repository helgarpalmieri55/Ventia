import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module';
import { RedisModule } from '../common/redis.module';
import { PlatformAdminGuard } from './platform-admin.guard';
import { PlatformController } from './platform.controller';
import { PlatformService } from './platform.service';
import { SubscriptionService } from './subscription.service';
import { SubscriptionSweepWorker } from './subscription-sweep.worker';

/**
 * `AdminModule` is imported ONLY for its `AUTH_INSTANCE` export — the single
 * shared better-auth instance, which `PlatformAdminGuard` needs to read a
 * session cookie. It does NOT bring `AdminSessionGuard` into play here; the
 * two guards are independent and this module registers only its own.
 *
 * `RedisModule` is imported for `REDIS_CLIENT`, which `PlatformService` uses
 * to evict `DomainResolver`'s tenant-resolution cache the moment a tenant is
 * suspended — without it, suspension would take up to 60 s to reach the
 * storefront (see that service's `setStatus` doc comment).
 *
 * `SubscriptionSweepWorker` is registered here as an ordinary provider and
 * STARTS NOTHING on its own: it implements no Nest lifecycle hook, so building
 * this module graph (which every test file does) never opens a BullMQ queue
 * and never suspends anybody. `main.ts`'s real-boot branch is the only caller
 * of its `start()`. Its `Mailer` comes from the @Global `MailerModule`, which
 * `AdminModule` already imports into the graph.
 */
@Module({
  imports: [AdminModule, RedisModule],
  controllers: [PlatformController],
  providers: [PlatformAdminGuard, PlatformService, SubscriptionService, SubscriptionSweepWorker],
})
export class PlatformModule {}
