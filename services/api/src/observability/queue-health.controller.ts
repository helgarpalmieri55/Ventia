import { Controller, Get, Inject, Query, UseGuards } from '@nestjs/common';
import { PlatformAdminGuard } from '../platform/platform-admin.guard';
import { DEFAULT_FAILURE_LIMIT, QueueHealthService, type QueueHealthReport } from './queue-health.service';

/**
 * `GET /v1/observability/queues` — queue health for a Ventia operator.
 *
 * ## Access control
 *
 * Queue state is **cross-tenant platform data**: the counts aggregate every
 * merchant on the instance, and a failure message can name one merchant's
 * order to another merchant's eyes. So this sits behind the same
 * `PlatformAdminGuard` as `/v1/platform/*` — env allowlist AND
 * `User.isPlatformAdmin` AND a verified email, all three, failing closed when
 * `PLATFORM_ADMIN_EMAILS` is unset.
 *
 * The guard is IMPORTED from `platform/`, not reimplemented here. A second
 * copy of a platform-admin check is the bug this codebase is most exposed to:
 * the copy is the one that gets forgotten when the original gains a
 * condition. This route lives in its own module rather than inside
 * `PlatformModule` so that observability — which must keep working while the
 * operator console is being changed — is not coupled to it.
 *
 * Read-only by construction — there is no route here that writes anything.
 * Retrying or removing a job is a deliberate omission, not an oversight; see
 * the `bull-board` discussion in queue-health.service.ts.
 */
@Controller('v1/observability')
@UseGuards(PlatformAdminGuard)
export class QueueHealthController {
  // Explicit @Inject: esbuild (vitest's transform) emits no `design:paramtypes`.
  constructor(@Inject(QueueHealthService) private readonly queueHealth: QueueHealthService) {}

  /**
   * `?failures=N` — how many recent failed jobs to include per queue.
   * Clamped rather than validated through a `@ventia/core` schema: the only
   * accepted shape is "a small non-negative integer", and a clamp expresses
   * that completely. Anything unparseable falls back to the default instead
   * of 400-ing, because an operator fat-fingering a query string during an
   * incident should get their dashboard, not a validation error.
   */
  @Get('queues')
  async queues(@Query('failures') failures?: string): Promise<QueueHealthReport> {
    const parsed = failures === undefined ? DEFAULT_FAILURE_LIMIT : Number.parseInt(failures, 10);
    return this.queueHealth.snapshot(Number.isFinite(parsed) ? parsed : DEFAULT_FAILURE_LIMIT);
  }
}
