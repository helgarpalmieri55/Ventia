import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module';
import { RedisModule } from '../common/redis.module';
import { PlatformAdminGuard } from './platform-admin.guard';
import { PlatformController } from './platform.controller';
import { PlatformService } from './platform.service';

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
 */
@Module({
  imports: [AdminModule, RedisModule],
  controllers: [PlatformController],
  providers: [PlatformAdminGuard, PlatformService],
})
export class PlatformModule {}
