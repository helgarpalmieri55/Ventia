import { Module } from '@nestjs/common';
import { AgentToolsService } from './agent-tools.service';
import { StorefrontModule } from '../storefront/storefront.module';
import { CheckoutModule } from '../checkout/checkout.module';

/** P4a: the agent's TOOL layer only. The conversation loop, the Anthropic
 * call, budgets and the HTTP surface land in the next slice — this module
 * exists now so the tools can be built and tested against the real database
 * before anything talks to a model. */
@Module({
  imports: [StorefrontModule, CheckoutModule],
  providers: [AgentToolsService],
  exports: [AgentToolsService],
})
export class AgentModule {}
