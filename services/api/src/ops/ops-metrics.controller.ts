import { Controller, Get, Inject, UseGuards } from '@nestjs/common';
import { OpsTokenGuard } from './ops-token.guard';
import { OpsMetricsService, type OpsSnapshot } from './ops-metrics.service';

/**
 * `GET /v1/ops/metrics` — the pull half of the OPS feed.
 *
 * ## Access control
 *
 * `OpsTokenGuard`: a machine credential, not a human session. See that file
 * for why this does not reuse `PlatformAdminGuard` like every other
 * cross-tenant route. It fails closed — unset token, nobody gets in.
 *
 * ## Why both a pull endpoint and a push worker
 *
 * They answer different questions and the OPS app wants both. Polling gives
 * it the current state on demand, which is what a dashboard render needs and
 * what makes "is Ventia up?" answerable by asking Ventia. The push
 * (`ops-push.worker.ts`) keeps arriving when nobody is looking, which is what
 * makes a gap in the data itself a signal — a polled endpoint that stops being
 * polled looks exactly like one that stops being available.
 *
 * Both serve the identical object from `OpsMetricsService.snapshot()`.
 *
 * ## Read-only by construction
 *
 * There is no write route in this module and there should never be one. The
 * credential is a long-lived secret living in another application's config;
 * whatever it can reach is what an attacker gets with one leaked file.
 */
@Controller('v1/ops')
@UseGuards(OpsTokenGuard)
export class OpsMetricsController {
  // Explicit @Inject: esbuild (vitest's transform) emits no `design:paramtypes`.
  constructor(@Inject(OpsMetricsService) private readonly metrics: OpsMetricsService) {}

  @Get('metrics')
  async snapshot(): Promise<OpsSnapshot> {
    return this.metrics.snapshot();
  }
}
