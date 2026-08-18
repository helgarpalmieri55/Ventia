/**
 * The WhatsApp channel's provider abstraction (docs/SPEC.md §7 channel 2).
 *
 * Deliberately shaped like `@ventia/payments`: two concrete adapters behind
 * one interface, an injected `fetch` so every adapter is testable without a
 * network, and no NestJS or Prisma anywhere — this package knows about wire
 * formats and nothing else.
 *
 * ## Two providers because the environments genuinely differ
 *
 * SPEC.md §4: "Evolution API in development, Meta WhatsApp Cloud API in
 * production." Evolution runs against a real phone via a QR pairing and needs
 * no Meta app review, which is what makes local development possible at all;
 * Cloud API is what a business actually ships on. They are not
 * interchangeable, so the interface is the narrowest thing both can honour:
 * receive text, send text.
 *
 * ## Wire formats were read from the official docs, not recalled
 *
 * SPEC.md §4 is explicit about this ("never implement from memory — read the
 * official docs ... at implementation time; APIs change"), and each adapter
 * cites what it was built against. What is NOT claimed: no live Meta app or
 * Evolution instance existed in this environment, so these are verified
 * against recorded payload fixtures, not against a real number.
 */

export type WhatsAppProviderId = 'evolution' | 'cloud';

/** One inbound text message, normalized across providers. */
export interface InboundMessage {
  /** The sender's phone number in digits only — no `+`, no `@s.whatsapp.net`
   * suffix. This becomes `Conversation.shopperRef`, so it must be stable
   * across providers and across messages from the same person. */
  from: string;
  /** The message text. Non-text messages (images, audio, location) are not
   * returned at all — see each adapter's parse. */
  text: string;
  /** The provider's own message id, used to drop duplicate deliveries. Both
   * providers retry, and both retry with the same id. */
  externalId: string;
  /** The sender's WhatsApp profile name, when the provider sends one. Never
   * trusted for anything but display — it is attacker-chosen text. */
  pushName?: string;
}

/**
 * Everything an adapter needs to talk to ONE tenant's number.
 *
 * Assembled by the API from the `WhatsAppNumber` row (and its decrypted
 * credentials) — this package never reads a database.
 */
export interface WhatsAppConfig {
  /** Cloud: the `phone_number_id`. Evolution: the instance name. The routing
   * key an inbound delivery is matched on. */
  externalId: string;
  /** Cloud: a permanent or system-user access token. Evolution: the instance
   * apikey. */
  token: string;
  /** Cloud: the Meta app secret, for `X-Hub-Signature-256`. Evolution has no
   * per-payload signature, so it is unused there. */
  appSecret?: string;
  /** Cloud only: the token echoed back during Meta's GET handshake. */
  verifyToken?: string;
  /** Evolution only: the base URL of the self-hosted instance. */
  baseUrl?: string;
}

export interface WhatsAppProvider {
  readonly id: WhatsAppProviderId;
  /**
   * Verifies a delivery and extracts every text message in it.
   *
   * Returns `null` when the payload is not authentic — a bad signature, a
   * shape that is not this provider's. The caller answers 200 and drops it:
   * both providers retry on non-2xx, and retrying will not make a forged or
   * malformed payload valid.
   *
   * Returns an ARRAY because a single Cloud API delivery can batch several
   * messages. Returning one would silently drop a shopper's second line.
   * An authentic delivery carrying no text messages (a status callback, a
   * photo) yields `[]`, which is different from `null` and must stay so.
   */
  verifyAndParseWebhook(
    rawBody: string,
    headers: Record<string, string | undefined>,
    config: WhatsAppConfig,
  ): InboundMessage[] | null;

  /** Sends one text message. Throws on a non-2xx so the caller can log and
   * retry; the agent's reply is not something to lose silently. */
  sendText(to: string, body: string, config: WhatsAppConfig, fetchImpl?: typeof fetch): Promise<void>;
}

export { normalizePhone } from './phone.js';
export { CloudProvider } from './cloud.js';
export { EvolutionProvider } from './evolution.js';
export { WhatsAppError } from './errors.js';
export { getWhatsAppProvider, WHATSAPP_PROVIDER_IDS } from './registry.js';
