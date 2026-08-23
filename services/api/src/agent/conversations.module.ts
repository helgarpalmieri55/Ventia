import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module';
import { InstagramModule } from '../instagram/instagram.module';
import { WhatsAppModule } from '../whatsapp/whatsapp.module';
import { ConversationsController } from './conversations.controller';
import { HumanReplyService } from './human-reply.service';

/**
 * La bandeja de atención: leer conversaciones y contestarlas como persona.
 *
 * ## Por qué un módulo propio y no `AgentModule`
 *
 * Porque el sentido de las flechas lo exige. `InstagramModule` y
 * `WhatsAppModule` importan `AgentModule` (son transportes HACIA el agente), y
 * contestar como persona necesita justo lo contrario: las credenciales de esos
 * dos canales. Dejar `ConversationsController` dentro de `AgentModule`
 * obligaría a que `AgentModule` importara los dos módulos que ya lo importan a
 * él, es decir a un `forwardRef` en cada lado — la clase de ciclo que compila,
 * arranca y luego falla en una inyección concreta meses después.
 *
 * Este módulo depende de los tres y NADIE depende de él, que es exactamente lo
 * que debe ser una superficie de administración: una hoja del grafo.
 */
@Module({
  imports: [AdminModule, InstagramModule, WhatsAppModule],
  controllers: [ConversationsController],
  providers: [HumanReplyService],
})
export class ConversationsModule {}
