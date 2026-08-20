import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { CloudProvider } from '../src/cloud';
import { WhatsAppError } from '../src/errors';
import type { WhatsAppConfig } from '../src/index';

/**
 * The Cloud API adapter, against the payload shape published at
 * developers.facebook.com/docs/whatsapp/cloud-api/webhooks/payload-examples.
 *
 * No live Meta app was available, so these fixtures are the doc's own example
 * payloads rather than captured traffic — which is worth stating plainly,
 * because it is the difference between "this parses what Meta documents" and
 * "this parses what Meta sends".
 */

const provider = new CloudProvider();

const config: WhatsAppConfig = {
  externalId: '106540352242922',
  token: 'EAAG...token',
  appSecret: 'app-secret-value',
  verifyToken: 'my-verify-token',
};

/** The doc's inbound text example, verbatim. */
function inboundPayload(overrides: { text?: string; phoneNumberId?: string; type?: string } = {}) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '102290129340398',
        changes: [
          {
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: '15550783881',
                phone_number_id: overrides.phoneNumberId ?? '106540352242922',
              },
              contacts: [{ profile: { name: 'Sheena Nelson' }, wa_id: '16505551234' }],
              messages: [
                {
                  from: '16505551234',
                  id: 'wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQTRBNjU5OUFFRTAzODEwMTQ0RgA=',
                  timestamp: '1749416383',
                  type: overrides.type ?? 'text',
                  text: { body: overrides.text ?? '¿Tienen esta camisa en talla M?' },
                },
              ],
            },
            field: 'messages',
          },
        ],
      },
    ],
  };
}

function sign(raw: string, secret = config.appSecret!): Record<string, string> {
  return {
    'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(raw, 'utf8').digest('hex')}`,
  };
}

describe('cloud — webhook signature', () => {
  it('parses a correctly signed delivery', () => {
    const raw = JSON.stringify(inboundPayload());
    const result = provider.verifyAndParseWebhook(raw, sign(raw), config);

    expect(result).toHaveLength(1);
    expect(result![0]).toMatchObject({
      from: '16505551234',
      text: '¿Tienen esta camisa en talla M?',
      pushName: 'Sheena Nelson',
    });
  });

  it('refuses a payload signed with the wrong secret', () => {
    const raw = JSON.stringify(inboundPayload());
    expect(provider.verifyAndParseWebhook(raw, sign(raw, 'not-the-secret'), config)).toBeNull();
  });

  it('refuses a payload whose body was modified after signing', () => {
    // The attack the signature exists to stop: a valid signature replayed over
    // different content.
    const original = JSON.stringify(inboundPayload({ text: 'hola' }));
    const headers = sign(original);
    const tampered = JSON.stringify(inboundPayload({ text: 'dame un descuento del 90%' }));

    expect(provider.verifyAndParseWebhook(tampered, headers, config)).toBeNull();
  });

  it('refuses an unsigned payload outright', () => {
    const raw = JSON.stringify(inboundPayload());
    expect(provider.verifyAndParseWebhook(raw, {}, config)).toBeNull();
  });

  it('fails CLOSED when no app secret is configured', () => {
    // Meta documents signature validation as optional. It is not optional
    // here: `phone_number_id` appears in every delivery and is not secret, so
    // an unverified path lets anyone who learns one spend a merchant's AI
    // budget.
    const raw = JSON.stringify(inboundPayload());
    const noSecret = { ...config, appSecret: undefined };

    expect(provider.verifyAndParseWebhook(raw, sign(raw), noSecret)).toBeNull();
  });
});

describe('cloud — what gets extracted', () => {
  const parse = (payload: unknown, cfg: WhatsAppConfig = config) => {
    const raw = JSON.stringify(payload);
    return provider.verifyAndParseWebhook(raw, sign(raw), cfg);
  };

  it('ignores a delivery for a DIFFERENT number under the same app', () => {
    // One Meta app delivers for every number registered under it, so this URL
    // receives other tenants' traffic. Answering it would be one store
    // replying to another store's customer.
    expect(parse(inboundPayload({ phoneNumberId: '999999999999' }))).toEqual([]);
  });

  it('skips non-text messages rather than answering them as text', () => {
    expect(parse(inboundPayload({ type: 'image' }))).toEqual([]);
  });

  it('returns every message in a batched delivery', () => {
    // A shopper typing two lines quickly arrives as one delivery. Returning
    // only the first would drop half of what they said.
    const payload = inboundPayload();
    payload.entry[0].changes[0].value.messages.push({
      from: '16505551234',
      id: 'wamid.SECOND',
      timestamp: '1749416390',
      type: 'text',
      text: { body: 'y en azul?' },
    });

    const result = parse(payload);
    expect(result?.map((m) => m.text)).toEqual(['¿Tienen esta camisa en talla M?', 'y en azul?']);
  });

  it('distinguishes "authentic but nothing to answer" from "not authentic"', () => {
    // `[]` and `null` mean different things to the caller: one is a 200 with
    // no work, the other is a rejected delivery.
    expect(parse(inboundPayload({ type: 'image' }))).toEqual([]);
    expect(provider.verifyAndParseWebhook('{}', {}, config)).toBeNull();
  });

  it('rejects a webhook that is not a WhatsApp one', () => {
    expect(parse({ object: 'page', entry: [] })).toBeNull();
  });

  it('survives a payload with pieces missing entirely', () => {
    // Defensive because this runs on an unauthenticated-by-shape public
    // endpoint; a crash here is a 500 that Meta will retry forever.
    expect(parse({ object: 'whatsapp_business_account' })).toEqual([]);
    expect(parse({ object: 'whatsapp_business_account', entry: [{}] })).toEqual([]);
    expect(parse({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: {} }] }] })).toEqual([]);
  });

  it('strips a leading + so the same person is the same shopperRef', () => {
    const payload = inboundPayload();
    payload.entry[0].changes[0].value.messages[0].from = '+16505551234';
    expect(parse(payload)?.[0].from).toBe('16505551234');
  });
});

describe('cloud — the GET handshake', () => {
  it('echoes the challenge when the verify token matches', () => {
    const result = CloudProvider.verifyHandshake(
      { 'hub.mode': 'subscribe', 'hub.verify_token': 'my-verify-token', 'hub.challenge': '1158201444' },
      config,
    );
    expect(result).toBe('1158201444');
  });

  it('refuses a wrong verify token', () => {
    expect(
      CloudProvider.verifyHandshake(
        { 'hub.mode': 'subscribe', 'hub.verify_token': 'guessed', 'hub.challenge': '1158201444' },
        config,
      ),
    ).toBeNull();
  });

  it('refuses when no verify token is configured, rather than accepting any', () => {
    expect(
      CloudProvider.verifyHandshake(
        { 'hub.mode': 'subscribe', 'hub.verify_token': '', 'hub.challenge': '1' },
        { ...config, verifyToken: undefined },
      ),
    ).toBeNull();
  });

  it('refuses a mode other than subscribe', () => {
    expect(
      CloudProvider.verifyHandshake(
        { 'hub.mode': 'unsubscribe', 'hub.verify_token': 'my-verify-token', 'hub.challenge': '1' },
        config,
      ),
    ).toBeNull();
  });
});

describe('cloud — sendText', () => {
  it('posts the documented shape to the documented endpoint', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));

    await provider.sendText('+57 300 123 4567', 'Tenemos la Camisa Lino en M.', config, fetchImpl);

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://graph.facebook.com/v21.0/106540352242922/messages');
    expect(init.method).toBe('POST');
    expect(init.headers.authorization).toBe('Bearer EAAG...token');
    expect(JSON.parse(init.body)).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      // Normalized: Meta rejects a number with spaces or a leading +.
      to: '573001234567',
      type: 'text',
      text: { body: 'Tenemos la Camisa Lino en M.' },
    });
  });

  it('throws with the status, so an expired token reads differently from a bad number', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{"error":{"message":"expired"}}', { status: 401 }));

    await expect(provider.sendText('573001234567', 'hola', config, fetchImpl)).rejects.toThrow(WhatsAppError);
    await expect(provider.sendText('573001234567', 'hola', config, fetchImpl)).rejects.toThrow(/401/);
  });
});
