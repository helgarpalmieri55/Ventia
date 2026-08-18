import { Controller, Get, HttpCode, HttpException, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { CloudProvider, getWhatsAppProvider } from '@ventia/whatsapp';
import { WhatsAppInboundService } from './whatsapp-inbound.service';
import { WhatsAppNumbersService } from './whatsapp-numbers.service';

/**
 * The public inbound endpoint for both WhatsApp providers.
 * `GET|POST /webhooks/whatsapp/:provider`.
 *
 * ## Why there is no `:tenantId` in the path
 *
 * Every payment webhook here is `/webhooks/payments/:provider/:tenantId`,
 * because a gateway is configured per tenant at credential-save time. Meta is
 * not: it delivers **one webhook per app**, covering every phone number
 * registered under that app's WhatsApp Business Accounts. A single URL
 * therefore receives every tenant's traffic, and the only discriminator is
 * inside the payload — `phone_number_id`. SPEC.md §7 says exactly this
 * ("Inbound messages route by phone-number-id → tenant"), and it is why
 * `WhatsAppNumber.externalId` is globally unique: this lookup must have
 * exactly one answer.
 *
 * ## Why it answers before it works
 *
 * Both providers retry on a non-2xx and both time out fast. Answering 200 the
 * moment the payload verifies, then handling the message after, is what stops
 * a slow model call from turning into a redelivery — and a redelivery, absent
 * dedupe, is a second billed turn. Dedupe exists anyway
 * (`Message.externalId`), because "we ack quickly" is a mitigation and a
 * unique index is a guarantee.
 *
 * The consequence is that nothing after the ack can report an error to
 * anyone. `WhatsAppInboundService.handle` therefore never throws.
 *
 * Relies on `main.ts`'s path-scoped `express.raw()` for `/webhooks/*`: Cloud's
 * `X-Hub-Signature-256` covers the exact bytes Meta sent, and a
 * JSON-parsed-then-reserialized body produces a different string and a
 * signature that never matches.
 */
@Controller('webhooks/whatsapp')
export class WhatsAppWebhooksController {
  constructor(
    @Inject(WhatsAppNumbersService) private readonly numbers: WhatsAppNumbersService,
    @Inject(WhatsAppInboundService) private readonly inbound: WhatsAppInboundService,
  ) {}

  /**
   * Meta's subscription handshake. Echoes `hub.challenge` as PLAIN TEXT — not
   * JSON, not quoted — when `hub.verify_token` matches the one stored for this
   * number. Anything else is a 403.
   *
   * `hub.verify_token` is the only thing identifying which number is being
   * verified, so the token is looked up by trying it against the candidate
   * number named in `hub.challenge`'s sibling... which Meta does not send.
   * Hence `?number=` — an id the merchant's admin UI puts in the callback URL
   * it tells them to paste into the Meta dashboard. Without it a handshake
   * could not be attributed to a tenant at all.
   */
  @Get(':provider')
  async verify(
    @Param('provider') provider: string,
    @Query() query: Record<string, string | undefined>,
  ): Promise<string> {
    if (provider !== 'cloud') throw new HttpException({ error: 'NOT_FOUND' }, 404);

    const externalId = query.number;
    if (!externalId) throw new HttpException({ error: 'FORBIDDEN' }, 403);

    const resolved = await this.numbers.resolveInbound(provider, externalId);
    if (!resolved) throw new HttpException({ error: 'FORBIDDEN' }, 403);

    const challenge = CloudProvider.verifyHandshake(query, resolved.config);
    if (challenge === null) throw new HttpException({ error: 'FORBIDDEN' }, 403);
    return challenge;
  }

  @Post(':provider')
  @HttpCode(200)
  async receive(@Param('provider') providerId: string, @Req() req: Request): Promise<{ ok: true }> {
    const provider = getWhatsAppProvider(providerId);
    if (!provider) throw new HttpException({ error: 'NOT_FOUND' }, 404);

    const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    const headers = req.headers as Record<string, string | undefined>;

    // The routing key has to come out of the payload BEFORE verification,
    // because verification needs the credentials that only the routed row
    // holds. That ordering is safe: reading a field is not trusting it, and
    // the adapter re-checks the same value against the config it is handed —
    // so a payload naming someone else's number verifies against THEIR secret
    // and fails.
    const externalId = extractRoutingKey(providerId, raw);
    if (!externalId) return { ok: true };

    const resolved = await this.numbers.resolveInbound(providerId, externalId);
    // An unknown or disabled number gets a 200 and nothing else. A 404 would
    // tell an unauthenticated caller which numbers this platform serves, and
    // would make Meta retry a delivery that will never become valid.
    if (!resolved) return { ok: true };

    const messages = provider.verifyAndParseWebhook(raw, headers, resolved.config);
    if (messages === null) return { ok: true };

    // Fire-and-forget, deliberately: see the class comment. `handle` swallows
    // its own failures, so there is nothing to await for correctness and
    // awaiting would only delay the ack this endpoint exists to send fast.
    for (const message of messages) {
      void this.inbound.handle({
        tenantId: resolved.tenantId,
        numberId: resolved.numberId,
        provider: providerId,
        config: resolved.config,
        message,
      });
    }

    return { ok: true };
  }
}

/**
 * Pulls the routing key out of an UNVERIFIED payload.
 *
 * Deliberately minimal and total: this runs on a public endpoint before any
 * authentication, so it must not throw on anything, and it must not do
 * anything with the value except look a row up.
 */
function extractRoutingKey(provider: string, raw: string): string | null {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return null;
  }
  const root = asRecord(payload);

  if (provider === 'evolution') {
    return typeof root.instance === 'string' ? root.instance : null;
  }

  for (const entry of asArray(root.entry)) {
    for (const change of asArray(asRecord(entry).changes)) {
      const id = asRecord(asRecord(asRecord(change).value).metadata).phone_number_id;
      if (typeof id === 'string') return id;
    }
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
