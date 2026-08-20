import { Module } from '@nestjs/common';
import { AgentModule } from '../agent/agent.module';
import { AdminModule } from '../admin/admin.module';
import { WhatsAppInboundService } from './whatsapp-inbound.service';
import { WhatsAppNumbersService } from './whatsapp-numbers.service';
import { WhatsAppWebhooksController } from './whatsapp-webhooks.controller';
import { WhatsAppAdminController } from './whatsapp-admin.controller';

/**
 * The WhatsApp channel (docs/SPEC.md §7 channel 2).
 *
 * Imports `AgentModule` rather than reimplementing anything: P5 is a second
 * transport into the agent that already exists, not a second agent. The
 * budget cap, the per-conversation throttle and every tool behave here exactly
 * as they do for the web widget, which is the payoff for having kept
 * `AgentService.respond` channel-agnostic.
 */
@Module({
  imports: [AgentModule, AdminModule],
  controllers: [WhatsAppWebhooksController, WhatsAppAdminController],
  providers: [WhatsAppNumbersService, WhatsAppInboundService],
  exports: [WhatsAppNumbersService],
})
export class WhatsAppModule {}
