import type { Mailer } from './mailer';

/**
 * The one email the AI agent sends: a handoff notice to the merchant when it
 * escalates a conversation (docs/SPEC.md §7's `escalate_to_human`).
 *
 * ## Why email, when SPEC names Chatwoot
 *
 * SPEC's tool description is "creates a Chatwoot conversation with the
 * summary, notifies merchant". The Chatwoot half is a P5 line item and there
 * is no Chatwoot in this repo's compose stack yet — but the notification half
 * is the part a shopper's outcome actually depends on, and it works today with
 * infrastructure that already exists and is already tested. Building the
 * notification now means an escalated shopper is genuinely reached; waiting
 * for Chatwoot would mean the agent tells a customer "un asesor te contactará"
 * and nobody is told to contact them.
 *
 * When Chatwoot lands, it becomes a second notifier alongside this one rather
 * than a replacement: an email in the owner's inbox is a useful backstop for a
 * conversation sitting unread in a helpdesk.
 */

export interface HandoffEmailContext {
  /** Where the notice goes — the merchant's `settings.storeInfo.contactEmail`. */
  merchantContactEmail: string;
  tenantName: string;
  /** The model's one-line reason for handing over. */
  reason: string;
  /** The model's summary, so whoever answers does not have to read the whole
   * transcript before saying something useful. */
  transcriptSummary: string;
  /** How to reach the shopper, when the conversation carries it. `null` for a
   * web-widget visitor who never identified themselves — in which case the
   * merchant's route back is the conversation in the admin, not a reply. */
  shopperRef: string | null;
  conversationId: string;
}

/**
 * Fire-and-forget from the tool executor, same posture as the order emails: a
 * mail transport that is briefly down must not turn into a tool error the
 * shopper sees, because the escalation itself (the conversation's status, the
 * record) has already been written and is what the merchant's admin reads.
 */
export async function sendHandoffEmail(mailer: Mailer, ctx: HandoffEmailContext): Promise<void> {
  const contactLine = ctx.shopperRef
    ? `Contacto del cliente: ${ctx.shopperRef}`
    : 'El cliente escribió desde el chat de la tienda y no dejó datos de contacto. Puedes responderle desde la conversación en tu panel.';

  await mailer.send({
    to: ctx.merchantContactEmail,
    subject: `Un cliente necesita ayuda humana — ${ctx.tenantName}`,
    text: `Hola,

Tu asistente de ventas pasó una conversación a una persona.

Motivo: ${ctx.reason}

Resumen:
${ctx.transcriptSummary}

${contactLine}

Conversación: ${ctx.conversationId}

Le dijimos al cliente que alguien de tu equipo lo contactará.`,
  });
}
