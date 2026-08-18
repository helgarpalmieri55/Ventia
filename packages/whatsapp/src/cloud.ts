import { createHmac, timingSafeEqual } from 'node:crypto';
import { WhatsAppError } from './errors.js';
import type { InboundMessage, WhatsAppConfig, WhatsAppProvider } from './index.js';
import { normalizePhone } from './phone.js';

/**
 * Meta WhatsApp Cloud API — the production provider (docs/SPEC.md §4).
 *
 * Built against the official docs read at implementation time, per SPEC §4's
 * "never implement from memory":
 *  - webhook payload shape:
 *    https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/payload-examples
 *  - signature + GET handshake:
 *    https://developers.facebook.com/docs/graph-api/webhooks/getting-started
 *  - send:
 *    https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages
 *
 * Not verified against a live Meta app — none was available in this
 * environment. The fixtures in `test/` are the doc's own example payloads.
 */

/** Pinned rather than floating. Meta versions the Graph API and deprecates old
 * versions on a schedule; a floating `/latest` would change this adapter's
 * behaviour without a deploy, which is exactly what you do not want on the
 * path a customer's message travels. Bump deliberately. */
const GRAPH_VERSION = 'v21.0';

export class CloudProvider implements WhatsAppProvider {
  readonly id = 'cloud' as const;

  verifyAndParseWebhook(
    rawBody: string,
    headers: Record<string, string | undefined>,
    config: WhatsAppConfig,
  ): InboundMessage[] | null {
    if (!this.verifySignature(rawBody, headers, config)) return null;

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return null;
    }

    const root = asRecord(payload);
    // Meta stamps every WhatsApp delivery with this. A payload without it is
    // some other product's webhook pointed at the wrong URL.
    if (root.object !== 'whatsapp_business_account') return null;

    const messages: InboundMessage[] = [];
    for (const entry of asArray(root.entry)) {
      for (const change of asArray(asRecord(entry).changes)) {
        const value = asRecord(asRecord(change).value);

        // The routing key, re-checked HERE rather than trusted from whatever
        // the caller looked the config up by. One Meta app delivers for every
        // number registered under it, so a single URL receives other tenants'
        // traffic — answering a message whose `phone_number_id` is not this
        // number's would be one store replying to another store's customer.
        const metadata = asRecord(value.metadata);
        if (metadata.phone_number_id !== config.externalId) continue;

        for (const raw of asArray(value.messages)) {
          const message = asRecord(raw);
          // Only text. An image or a location is a real message a shopper
          // sent, but this agent has no tool that can act on one, and
          // answering it as though it were text would produce nonsense.
          if (message.type !== 'text') continue;
          const body = asRecord(message.text).body;
          if (typeof body !== 'string' || body.trim().length === 0) continue;
          if (typeof message.from !== 'string' || typeof message.id !== 'string') continue;

          messages.push({
            from: normalizePhone(message.from),
            text: body,
            externalId: message.id,
            pushName: profileName(value, message.from),
          });
        }
      }
    }
    return messages;
  }

  /**
   * Meta's `GET` handshake: echo `hub.challenge` back as plain text, but only
   * when `hub.verify_token` matches. Returns `null` when it does not, and the
   * caller 403s.
   *
   * A static method rather than part of the interface: Evolution has no
   * equivalent, and putting a Cloud-only concern on the shared interface would
   * force the other adapter to implement something meaningless.
   */
  static verifyHandshake(
    query: Record<string, string | undefined>,
    config: WhatsAppConfig,
  ): string | null {
    if (query['hub.mode'] !== 'subscribe') return null;
    const supplied = query['hub.verify_token'];
    const expected = config.verifyToken;
    if (!expected || typeof supplied !== 'string') return null;
    if (!constantTimeEquals(supplied, expected)) return null;
    return typeof query['hub.challenge'] === 'string' ? query['hub.challenge'] : null;
  }

  async sendText(
    to: string,
    body: string,
    config: WhatsAppConfig,
    fetchImpl: typeof fetch = fetch,
  ): Promise<void> {
    const res = await fetchImpl(
      `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(config.externalId)}/messages`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: normalizePhone(to),
          type: 'text',
          text: { body },
        }),
      },
    );

    if (!res.ok) {
      throw new WhatsAppError('cloud', res.status, await res.text().catch(() => ''));
    }
  }

  /**
   * `X-Hub-Signature-256: sha256=<hex hmac of the RAW body with the app
   * secret>`.
   *
   * The raw body matters: re-serializing the parsed JSON produces different
   * bytes (key order, whitespace, number formatting) and a signature that
   * never matches. This is the same reason `main.ts` mounts `express.raw` for
   * `/webhooks`.
   *
   * A config with no `appSecret` fails CLOSED. Meta documents signature
   * validation as optional, which is true of the protocol and false of this
   * system: without it, anyone who learns a `phone_number_id` — a value that
   * appears in every delivery and is not secret — can post messages that a
   * merchant's agent will answer and pay for.
   */
  private verifySignature(
    rawBody: string,
    headers: Record<string, string | undefined>,
    config: WhatsAppConfig,
  ): boolean {
    if (!config.appSecret) return false;
    const header = headers['x-hub-signature-256'];
    if (typeof header !== 'string' || !header.startsWith('sha256=')) return false;

    const expected = createHmac('sha256', config.appSecret).update(rawBody, 'utf8').digest('hex');
    return constantTimeEquals(header.slice('sha256='.length), expected);
  }
}

/** The sender's WhatsApp profile name, if this delivery carried a matching
 * contact. Display only — it is whatever the sender set it to. */
function profileName(value: Record<string, unknown>, from: string): string | undefined {
  for (const raw of asArray(value.contacts)) {
    const contact = asRecord(raw);
    if (contact.wa_id === from) {
      const name = asRecord(contact.profile).name;
      if (typeof name === 'string' && name.trim().length > 0) return name.trim();
    }
  }
  return undefined;
}

/** Length-independent comparison. `timingSafeEqual` throws on differing
 * lengths, which would itself leak length, so both sides are hashed to a fixed
 * width first. */
function constantTimeEquals(a: string, b: string): boolean {
  const ha = createHmac('sha256', 'cmp').update(a).digest();
  const hb = createHmac('sha256', 'cmp').update(b).digest();
  return timingSafeEqual(ha, hb);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
