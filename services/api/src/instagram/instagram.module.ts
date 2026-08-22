import { Module } from '@nestjs/common';
import { AgentModule } from '../agent/agent.module';
import { AdminModule } from '../admin/admin.module';
import { InstagramInboundService } from './instagram-inbound.service';
import { InstagramAccountsService } from './instagram-accounts.service';
import { InstagramWebhooksController } from './instagram-webhooks.controller';
import { InstagramAdminController } from './instagram-admin.controller';

/**
 * El canal de Instagram, el que vende el plan Crece.
 *
 * Importa `AgentModule` en vez de reimplementar nada: esto es un tercer
 * transporte hacia el agente que ya existe, no un tercer agente. El tope de
 * presupuesto, el freno por conversación y todas las herramientas se comportan
 * aquí igual que en el chat de la tienda y en WhatsApp, que es lo que se gana
 * por haber mantenido `AgentService.respond` agnóstico del canal.
 */
@Module({
  imports: [AgentModule, AdminModule],
  controllers: [InstagramWebhooksController, InstagramAdminController],
  providers: [InstagramAccountsService, InstagramInboundService],
  exports: [InstagramAccountsService],
})
export class InstagramModule {}
