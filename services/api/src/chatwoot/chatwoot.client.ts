/**
 * Minimal Chatwoot client for the agent's human handoff (docs/SPEC.md §7:
 * `escalate_to_human` — "creates a Chatwoot conversation with the summary,
 * notifies merchant").
 *
 * ## Why this is a second notifier, not a replacement
 *
 * P4d already made escalation work with email: the conversation is marked
 * `escalated`, the merchant is emailed a deep link to the transcript, and the
 * shopper is told. That path stays. Chatwoot joins it because a helpdesk is
 * where a team actually works a queue — but an owner's inbox is a useful
 * backstop for a conversation sitting unread in one, and losing the email
 * would make the feature worse for the single-operator stores that are this
 * product's whole market.
 *
 * ## Optional by construction
 *
 * A tenant with no Chatwoot configuration escalates exactly as it did before.
 * `isConfigured()` is what every caller checks, and the absence of config is a
 * normal state rather than an error — most Colombian SMBs on the Básico plan
 * will never connect one.
 *
 * ## Not verified against a live Chatwoot
 *
 * There is no Chatwoot instance in this repo's compose stack and none was
 * available here. The request shapes below follow Chatwoot's documented
 * application API (`/api/v1/accounts/{account}/conversations` and
 * `.../messages`, authenticated with an `api_access_token` header). Treat them
 * as unconfirmed until a real instance has accepted one — the same caveat the
 * WhatsApp adapters carry, and for the same reason.
 */

export interface ChatwootConfig {
  /** Base URL of the Chatwoot instance, e.g. `https://chat.ventia.co`. */
  baseUrl: string;
  /** Account-scoped API access token. */
  apiToken: string;
  /** Which account the tenant's inbox lives under. */
  accountId: string;
  /** The inbox to open conversations in. */
  inboxId: string;
}

export interface HandoffPayload {
  /** Stable identifier for the shopper in Chatwoot — the WhatsApp number, or
   * the conversation id for an anonymous web visitor. Chatwoot dedupes
   * contacts on this, so a returning shopper lands in their existing thread
   * rather than a new one each time. */
  sourceId: string;
  contactName: string;
  reason: string;
  transcriptSummary: string;
  /** Deep link back to Ventia's own conversation view, so whoever picks this
   * up can read what actually happened rather than only the summary. */
  conversationUrl: string;
}

const TIMEOUT_MS = 10_000;

export function isConfigured(config: Partial<ChatwootConfig> | null | undefined): config is ChatwootConfig {
  return Boolean(config?.baseUrl && config?.apiToken && config?.accountId && config?.inboxId);
}

/**
 * Opens a Chatwoot conversation carrying the agent's summary.
 *
 * Throws on failure. The CALLER decides what that means — and for
 * `escalate_to_human` it must mean "log it", never "fail the escalation":
 * the conversation is already marked escalated and the merchant already has
 * an email, so a Chatwoot outage must not turn into a shopper being told
 * nobody can help them.
 */
export async function createHandoffConversation(
  config: ChatwootConfig,
  payload: HandoffPayload,
  fetchImpl: typeof fetch = fetch,
): Promise<{ conversationId: number }> {
  const base = config.baseUrl.replace(/\/+$/, '');
  const headers = { api_access_token: config.apiToken, 'content-type': 'application/json' };

  // Bounded, like every other outbound call in this system. `fetch` has no
  // default timeout, and this one runs inside a shopper's chat turn — a
  // Chatwoot that accepts a connection and then stalls would hold the turn
  // open indefinitely.
  const created = await withTimeout(
    fetchImpl(`${base}/api/v1/accounts/${encodeURIComponent(config.accountId)}/conversations`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        source_id: payload.sourceId,
        inbox_id: config.inboxId,
        contact: { name: payload.contactName },
        // Open, not pending: this conversation exists precisely because it
        // needs a person, so it should be in the queue people work.
        status: 'open',
      }),
    }),
    'createConversation',
  );

  if (!created.ok) {
    throw new Error(`chatwoot createConversation: HTTP ${created.status} ${await safeText(created)}`);
  }
  const body = (await created.json().catch(() => ({}))) as { id?: number };
  if (typeof body.id !== 'number') {
    throw new Error('chatwoot createConversation: response carried no conversation id');
  }

  // The summary goes as a separate message rather than in the create call, so
  // it renders as an actual message in the thread — a conversation whose only
  // content is metadata gives the agent picking it up nothing to read.
  const message = await withTimeout(
    fetchImpl(
      `${base}/api/v1/accounts/${encodeURIComponent(config.accountId)}/conversations/${body.id}/messages`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          content: [
            `**Motivo:** ${payload.reason}`,
            '',
            payload.transcriptSummary,
            '',
            `Conversación completa: ${payload.conversationUrl}`,
          ].join('\n'),
          message_type: 'outgoing',
          // Private: this is context for the team, not something to send to
          // the customer. Getting this wrong would deliver the agent's own
          // internal summary — including "3 intentos sin resolver" — straight
          // to the shopper.
          private: true,
        }),
      },
    ),
    'createMessage',
  );

  if (!message.ok) {
    throw new Error(`chatwoot createMessage: HTTP ${message.status} ${await safeText(message)}`);
  }

  return { conversationId: body.id };
}

async function withTimeout(promise: Promise<Response>, label: string): Promise<Response> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  return Promise.race([
    promise,
    new Promise<Response>((_, reject) => {
      timeout.addEventListener('abort', () =>
        reject(new Error(`chatwoot ${label}: timed out after ${TIMEOUT_MS}ms`)),
      );
    }),
  ]);
}

async function safeText(res: Response): Promise<string> {
  return (await res.text().catch(() => '')).slice(0, 200);
}
