import { Module } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { AdminModule } from '../admin/admin.module';
import { AgentModule } from '../agent/agent.module';
import { ANTHROPIC_CLIENT } from '../agent/agent.service';
import { DashboardModule } from '../dashboard/dashboard.module';
import { AgentCommandController } from './agent-command.controller';
import { AgentCommandService } from './agent-command.service';
import { AgentCommandToolsService } from './agent-command-tools.service';

/**
 * The merchant's business assistant (docs/design-gap.md §7 item 6).
 *
 * Separate from `AgentModule` on purpose. The two share a budget counter and a
 * client, and nothing else: different audience, different tools, different
 * risk. Keeping them apart is what makes "no write tool, no shopper tool"
 * checkable by reading one directory instead of auditing a merged tool array.
 *
 * ## What is imported and why
 *
 * - `AgentModule` for {@link AgentBudgetService}, which it exports. The shared
 *   `TenantLimits.aiMessagesMonth` counter is the whole point — see
 *   `agent-command.service.ts` for the decision and for the shopper reserve
 *   that keeps this surface from spending the storefront into silence.
 * - `DashboardModule` for `DashboardService`, so the assistant's numbers are
 *   the merchant's own tablero numbers rather than a second set that can
 *   disagree with it.
 * - `AdminModule` for `AdminSessionGuard` + `AUTH_INSTANCE`, same as every
 *   other merchant-facing module.
 *
 * ## Why `ANTHROPIC_CLIENT` is re-provided here
 *
 * `AgentModule` declares that token but does not export it, and that module is
 * not this change's to edit. Declaring it here under the SAME imported symbol
 * gives this module its own client while keeping one token across the app —
 * which is what lets a test call `overrideProvider(ANTHROPIC_CLIENT)` once and
 * have both loops run against the same fake, with no network and no API key.
 *
 * A second client instance costs nothing: constructing one does not reach the
 * network (it resolves credentials lazily), so an API instance with no key
 * still boots and fails at the first question instead — the right place for
 * that to surface.
 */
@Module({
  imports: [AgentModule, DashboardModule, AdminModule],
  controllers: [AgentCommandController],
  providers: [
    AgentCommandToolsService,
    AgentCommandService,
    { provide: ANTHROPIC_CLIENT, useFactory: () => new Anthropic() },
  ],
})
export class AgentCommandModule {}
