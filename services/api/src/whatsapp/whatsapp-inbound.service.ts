import { Inject, Injectable } from '@nestjs/common';
import { platformDb, tenantDb } from '@ventia/db';
import { getWhatsAppProvider, type InboundMessage, type WhatsAppConfig } from '@ventia/whatsapp';
import { AgentService } from '../agent/agent.service';
import { renderForWhatsApp } from '../agent/whatsapp-render';
import { WhatsAppNumbersService } from './whatsapp-numbers.service';
import { tenantStorefrontBaseUrl } from '../tenants/tenant-public-url';

/**
 * Turns a verified inbound WhatsApp message into an agent turn and sends the
 * reply back (docs/SPEC.md §7 channel 2).
 *
 * This is the whole of what P5 adds to the agent: a second transport into
 * `AgentService.respond`, which is already channel-agnostic. Nothing here
 * decides what to say — the tools, the budget cap and the throttle all behave
 * exactly as they do for the web widget, which is the point of having built
 * the loop the way it is.
 *
 * ## Delivery, not request/response
 *
 * A payment webhook can answer the gateway with the result. This cannot: the
 * shopper's reply travels back out through a SEPARATE API call to the
 * provider, and the provider's own POST just needs a prompt 200 or it retries.
 * So the controller acknowledges immediately and this runs after — which means
 * every failure in here has to be handled here. There is nobody to return an
 * error to.
 */

@Injectable()
export class WhatsAppInboundService {
  constructor(
    @Inject(AgentService) private readonly agent: AgentService,
    @Inject(WhatsAppNumbersService) private readonly numbers: WhatsAppNumbersService,
  ) {}

  /**
   * Handles one message end to end: dedupe, plan check, agent turn, send.
   *
   * Never throws. A message that cannot be answered is logged and dropped,
   * because the alternative — an unhandled rejection in a fire-and-forget
   * call — takes the process down for one shopper's bad luck.
   */
  async handle(input: {
    tenantId: string;
    numberId: string;
    provider: string;
    config: WhatsAppConfig;
    message: InboundMessage;
  }): Promise<void> {
    const { tenantId, message } = input;
    try {
      if (await this.isDuplicate(tenantId, message.externalId)) return;

      // The plan gate, checked on every inbound message rather than only at
      // connect time. A store downgraded off the WhatsApp channel keeps its
      // number registered and Meta keeps delivering to it; without this check
      // it would keep answering — and keep spending AI budget — through a
      // channel it no longer pays for.
      const limits = await platformDb.tenantLimits.findUnique({ where: { tenantId } });
      if (!limits?.whatsappChannel) return;

      const conversationId = await this.resolveConversation(tenantId, message.from);
      const reply = await this.agent.respond({
        tenantId,
        conversationId,
        // The sender's number IS the shopper's identity here, unlike the web
        // widget where it is null. It is what makes a WhatsApp conversation
        // resumable across days and what gives `escalate_to_human` a real
        // contact to hand the merchant.
        shopperRef: message.from,
        message: message.text,
      });

      const baseUrl = await this.storefrontBaseUrl(tenantId);
      const bodies = renderForWhatsApp(reply, baseUrl);

      const provider = getWhatsAppProvider(input.provider);
      if (!provider) return;
      for (const body of bodies) {
        // Sequential, not Promise.all: WhatsApp does not guarantee ordering
        // between concurrent sends, and a product list arriving after the
        // sentence that introduces it reads as broken.
        await provider.sendText(message.from, body, input.config);
      }
    } catch (err) {
      console.error('[whatsapp] failed to handle inbound message', {
        tenantId,
        externalId: message.externalId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Both providers retry, and both retry with the same message id. Without
   * this a retried delivery is a second agent turn: the merchant is billed
   * twice and the shopper is answered twice.
   *
   * Keyed on the message's own id recorded against the conversation's tenant.
   * A dedicated table would be tidier; reusing `Message.externalId` keeps the
   * fact next to the transcript that proves it.
   */
  private async isDuplicate(tenantId: string, externalId: string): Promise<boolean> {
    const existing = await tenantDb(tenantId).message.findFirst({
      where: { tenantId, externalId },
      select: { id: true },
    });
    return existing !== null;
  }

  /**
   * The shopper's ongoing conversation, or a new one.
   *
   * Looked up by `(tenantId, channel, shopperRef)` rather than by a cookie —
   * on WhatsApp the thread IS the history, and a shopper who wrote last week
   * expects the store to remember. Reuses the most recent non-resolved
   * conversation so a merchant marking one handled starts the next message
   * fresh rather than reopening a closed case.
   */
  private async resolveConversation(tenantId: string, shopperRef: string): Promise<string> {
    const db = tenantDb(tenantId);
    const existing = await db.conversation.findFirst({
      where: { tenantId, channel: 'whatsapp', shopperRef, status: { not: 'resolved' } },
      orderBy: { startedAt: 'desc' },
    });
    if (existing) return existing.id;

    const created = await db.conversation.create({
      data: { tenantId, channel: 'whatsapp', shopperRef, status: 'open' },
    });
    return created.id;
  }

  /**
   * The tenant's own public storefront origin, for absolutizing the relative
   * URLs the tools return.
   *
   * A relative `/producto/camisa` is meaningless in a WhatsApp message — there
   * is no page it is relative TO. And it must be THIS tenant's domain: the
   * same multi-tenancy trap the payment adapters hit, where one global base
   * URL sent every store's shoppers to whichever storefront that variable
   * named.
   */
  private async storefrontBaseUrl(tenantId: string): Promise<string> {
    const domain = await platformDb.tenantDomain.findFirst({
      where: { tenantId },
      // Primary first, then by `domain` for a stable tie-break. `TenantDomain`
      // has no `createdAt`, so "oldest" is not available — and an unordered
      // findFirst would pick a different domain run to run, which for a tenant
      // with several domains means the same shopper getting links on different
      // hosts.
      orderBy: [{ isPrimary: 'desc' }, { domain: 'asc' }],
    });
    return tenantStorefrontBaseUrl(domain?.domain ?? '');
  }
}
