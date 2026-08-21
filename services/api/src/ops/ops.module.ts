import { Module } from '@nestjs/common';
import { ObservabilityModule } from '../observability/observability.module';
import { QueueHealthService } from '../observability/queue-health.service';
import { OpsMetricsController } from './ops-metrics.controller';
import { OpsMetricsService } from './ops-metrics.service';
import { OpsPushWorker } from './ops-push.worker';
import { OpsTokenGuard } from './ops-token.guard';

/**
 * The OPS feed: one snapshot of cost and health per store and platform-wide,
 * available by pull (`GET /v1/ops/metrics`) and by push
 * (`ops-push.worker.ts`).
 *
 * ## Why its own module rather than a route on `PlatformModule`
 *
 * Different audience and a different credential. `/v1/platform/*` is a console
 * for a human operator behind `PlatformAdminGuard`; this is a machine feed
 * behind a rotatable bearer token. Keeping them apart means the OPS token can
 * never reach a mutation route by a later refactor putting one in the wrong
 * controller, and it keeps monitoring — which must keep working while the
 * console is being changed — uncoupled from it.
 *
 * `QueueHealthService` is re-listed as a provider rather than only imported:
 * `ObservabilityModule` does not export it, and duplicating the provider here
 * is a lazily-connecting service, so a second instance costs nothing until
 * something asks it for a snapshot.
 *
 * Registering this module starts NOTHING. `OpsPushWorker.start()` is called
 * from `main.ts`, and the metrics service holds no connection of its own.
 */
@Module({
  imports: [ObservabilityModule],
  controllers: [OpsMetricsController],
  providers: [OpsTokenGuard, OpsMetricsService, OpsPushWorker, QueueHealthService],
  exports: [OpsPushWorker, OpsMetricsService],
})
export class OpsModule {}
