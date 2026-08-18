import { createHmac, timingSafeEqual } from 'node:crypto';
import { WhatsAppError } from './errors.js';
import type { InboundMessage, WhatsAppConfig, WhatsAppProvider } from './index.js';
import { normalizePhone } from './phone.js';

/**
 * Evolution API — the DEVELOPMENT provider (docs/SPEC.md §4).
 *
 * Self-hosted, pairs with a real phone by QR, and needs no Meta app review,
 * which is what makes it possible to exercise this channel locally at all.
 * Not a production path: it drives a personal WhatsApp session rather than the
 * Business Platform.
 *
 * Built against the v2 docs and the published integration examples read at
 * implementation time (`POST /message/sendText/{instance}` with an `apikey`
 * header; `messages.upsert` webhook events).
 *
 * ## Two shapes, both accepted
 *
 * Evolution's own examples disagree about whether an inbound message sits at
 * `data.key` / `data.message` or one level deeper at `data.message.key` /
 * `data.message.message`. Rather than pick one and have real traffic silently
 * fail to parse, this reads both and prefers the flatter form. The cost is a
 * few lines; the alternative is a channel that looks wired up and drops every
 * message.
 */

export class EvolutionProvider implements WhatsAppProvider {
  readonly id = 'evolution' as const;

  verifyAndParseWebhook(
    rawBody: string,
    headers: Record<string, string | undefined>,
    config: WhatsAppConfig,
  ): InboundMessage[] | null {
    // Evolution signs nothing per-payload; the shared instance apikey is the
    // only credential. Requiring it on the webhook is therefore the whole of
    // this provider's authentication, and it fails CLOSED — an unauthenticated
    // inbound path is one where anyone who guesses an instance name can spend
    // a merchant's AI budget.
    const supplied = headers.apikey ?? headers['x-api-key'];
    if (typeof supplied !== 'string' || !constantTimeEquals(supplied, config.token)) return null;

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return null;
    }

    const root = asRecord(payload);
    // Only new messages. `messages.update`, `send.message` and the rest are
    // real events this agent has nothing to do with — and `send.message` in
    // particular is our OWN outbound reply coming back, which would loop.
    if (root.event !== 'messages.upsert') return [];
    // The instance is the routing key, re-checked here for the same reason
    // Cloud re-checks `phone_number_id`.
    if (typeof root.instance === 'string' && root.instance !== config.externalId) return null;

    const data = asRecord(root.data);
    // The flatter shape first, then the nested one — see the class comment.
    const inner = asRecord(data.message);
    const key = asRecord(data.key).remoteJid !== undefined ? asRecord(data.key) : asRecord(inner.key);
    const content = asRecord(data.key).remoteJid !== undefined ? inner : asRecord(inner.message);

    // Our own outbound messages come back through this same event. Answering
    // them would have the agent talking to itself, forever, on the merchant's
    // budget.
    if (key.fromMe === true) return [];

    const remoteJid = key.remoteJid;
    const externalId = key.id;
    if (typeof remoteJid !== 'string' || typeof externalId !== 'string') return [];

    // A group chat's JID ends in `@g.us`. The agent is a one-to-one sales
    // assistant; replying into a group is both wrong and a privacy problem,
    // since the store's answer would be visible to everyone in it.
    if (remoteJid.endsWith('@g.us')) return [];

    const text = extractText(content);
    if (!text) return [];

    const pushName = data.pushName ?? inner.pushName;
    return [
      {
        from: normalizePhone(remoteJid),
        text,
        externalId,
        pushName: typeof pushName === 'string' && pushName.trim() ? pushName.trim() : undefined,
      },
    ];
  }

  async sendText(
    to: string,
    body: string,
    config: WhatsAppConfig,
    fetchImpl: typeof fetch = fetch,
  ): Promise<void> {
    if (!config.baseUrl) {
      throw new WhatsAppError('evolution', 0, 'no baseUrl configured for this instance');
    }
    const base = config.baseUrl.replace(/\/+$/, '');
    const res = await fetchImpl(`${base}/message/sendText/${encodeURIComponent(config.externalId)}`, {
      method: 'POST',
      headers: { apikey: config.token, 'content-type': 'application/json' },
      body: JSON.stringify({ number: normalizePhone(to), text: body }),
    });

    if (!res.ok) {
      throw new WhatsAppError('evolution', res.status, await res.text().catch(() => ''));
    }
  }
}

/** A plain chat message is `conversation`; one containing a link (which every
 * cart link the agent sends will be) arrives as `extendedTextMessage.text`
 * instead. Missing the second would drop exactly the replies that matter. */
function extractText(content: Record<string, unknown>): string | null {
  const plain = content.conversation;
  if (typeof plain === 'string' && plain.trim()) return plain;
  const extended = asRecord(content.extendedTextMessage).text;
  if (typeof extended === 'string' && extended.trim()) return extended;
  return null;
}

function constantTimeEquals(a: string, b: string): boolean {
  const ha = createHmac('sha256', 'cmp').update(a).digest();
  const hb = createHmac('sha256', 'cmp').update(b).digest();
  return timingSafeEqual(ha, hb);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
