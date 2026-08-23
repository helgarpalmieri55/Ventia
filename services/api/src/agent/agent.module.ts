import { Module } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { AgentToolsService } from './agent-tools.service';
import { AgentBudgetService } from './agent-budget.service';
import { AgentThrottleService } from './agent-throttle.service';
import { AgentController } from './agent.controller';
import { AgentAdminController } from './agent-admin.controller';
import { AgentService, ANTHROPIC_CLIENT } from './agent.service';
import { ConversationRetentionWorker } from './conversation-retention.worker';
import { RedisModule } from '../common/redis.module';
import { AdminModule } from '../admin/admin.module';
import { MailerModule } from '../mailer/mailer.module';
import { StorefrontModule } from '../storefront/storefront.module';
import { CheckoutModule } from '../checkout/checkout.module';

/**
 * The AI sales agent (docs/SPEC.md §7).
 *
 * The Anthropic client is a provider rather than a module-level singleton so
 * tests can replace it with a fake and exercise the whole loop — tool
 * dispatch, persistence, budget enforcement — with no network call and no API
 * key. Constructed with no arguments: the SDK resolves credentials from the
 * environment (`ANTHROPIC_API_KEY`, or an `ant auth login` profile), so a
 * deployment configures it the same way it configures every other secret here.
 *
 * Note that constructing the client does NOT reach the network, so an API
 * instance with no key still boots — it fails at the first agent request
 * instead, which is the right place for that to surface (a store with no AI
 * traffic should not be unable to serve its catalogue).
 */
@Module({
  imports: [RedisModule, StorefrontModule, CheckoutModule, AdminModule, MailerModule],
  // `ConversationsController` se fue a `ConversationsModule`: contestar como
  // persona necesita las credenciales de Instagram y WhatsApp, y esos dos
  // módulos ya importan este. Ver la cabecera de aquel módulo.
  controllers: [AgentController, AgentAdminController],
  providers: [
    AgentToolsService,
    AgentBudgetService,
    AgentThrottleService,
    AgentService,
    // Registered here so main.ts can `app.get()` it. Registration alone starts
    // NOTHING: the class implements no Nest lifecycle hook, so `app.init()` —
    // which every test file in this repo calls — never touches Redis or
    // deletes a row. See its doc comment.
    ConversationRetentionWorker,
    { provide: ANTHROPIC_CLIENT, useFactory: () => new Anthropic() },
  ],
  exports: [AgentToolsService, AgentBudgetService, AgentService],
})
export class AgentModule {}
