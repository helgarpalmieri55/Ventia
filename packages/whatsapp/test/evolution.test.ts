import { describe, expect, it, vi } from 'vitest';
import { EvolutionProvider } from '../src/evolution';
import { WhatsAppError } from '../src/errors';
import type { WhatsAppConfig } from '../src/index';

/**
 * The Evolution API adapter — the development provider.
 *
 * The two behaviours that matter most here are not about parsing: an inbound
 * path with no authentication lets anyone who guesses an instance name spend a
 * merchant's AI budget, and an adapter that answers its OWN outbound messages
 * talks to itself forever on that same budget.
 */

const provider = new EvolutionProvider();

const config: WhatsAppConfig = {
  externalId: 'ventia-dev',
  token: 'instance-apikey',
  baseUrl: 'http://localhost:8080',
};

function upsert(overrides: Partial<{ text: string; fromMe: boolean; remoteJid: string; nested: boolean }> = {}) {
  const key = {
    remoteJid: overrides.remoteJid ?? '573001234567@s.whatsapp.net',
    fromMe: overrides.fromMe ?? false,
    id: '3EB0YYYYY',
  };
  const content = { conversation: overrides.text ?? 'hola, ¿tienen camisas?' };

  // Evolution's published examples disagree about the nesting depth, so both
  // shapes are exercised — see the adapter's class comment.
  return {
    event: 'messages.upsert',
    instance: 'ventia-dev',
    data: overrides.nested
      ? { message: { key, pushName: 'Juana', message: content } }
      : { key, pushName: 'Juana', message: content },
  };
}

const auth = { apikey: 'instance-apikey' };

describe('evolution — authentication', () => {
  it('parses a delivery carrying the instance apikey', () => {
    const result = provider.verifyAndParseWebhook(JSON.stringify(upsert()), auth, config);

    expect(result).toHaveLength(1);
    expect(result![0]).toMatchObject({
      from: '573001234567',
      text: 'hola, ¿tienen camisas?',
      pushName: 'Juana',
    });
  });

  it('refuses a delivery with the wrong apikey', () => {
    expect(provider.verifyAndParseWebhook(JSON.stringify(upsert()), { apikey: 'guessed' }, config)).toBeNull();
  });

  it('fails CLOSED with no apikey at all', () => {
    // This header is the whole of Evolution's authentication — it signs
    // nothing per payload.
    expect(provider.verifyAndParseWebhook(JSON.stringify(upsert()), {}, config)).toBeNull();
  });

  it('refuses a delivery for a different instance', () => {
    const payload = { ...upsert(), instance: 'someone-elses' };
    expect(provider.verifyAndParseWebhook(JSON.stringify(payload), auth, config)).toBeNull();
  });
});

describe('evolution — what gets answered', () => {
  const parse = (payload: unknown) => provider.verifyAndParseWebhook(JSON.stringify(payload), auth, config);

  it('NEVER answers our own outbound message', () => {
    // Evolution echoes sent messages back through the same event. Answering
    // one would have the agent in a conversation with itself, unbounded, on
    // the merchant's budget.
    expect(parse(upsert({ fromMe: true }))).toEqual([]);
  });

  it('ignores group chats', () => {
    // The agent is a one-to-one sales assistant; replying into a group shows
    // the store's answer to everyone in it.
    expect(parse(upsert({ remoteJid: '120363000000000000@g.us' }))).toEqual([]);
  });

  it('ignores events that are not new messages', () => {
    expect(parse({ event: 'messages.update', instance: 'ventia-dev', data: {} })).toEqual([]);
    // `send.message` is our own reply coming back under a different event
    // name — the same loop hazard as fromMe.
    expect(parse({ event: 'send.message', instance: 'ventia-dev', data: {} })).toEqual([]);
  });

  it('reads the nested payload shape too', () => {
    // Evolution's own docs show both; picking one would mean a channel that
    // looks wired up and silently drops every message.
    const result = parse(upsert({ nested: true }));
    expect(result).toHaveLength(1);
    expect(result![0].text).toBe('hola, ¿tienen camisas?');
  });

  it('reads a message containing a link', () => {
    // Arrives as extendedTextMessage rather than conversation — which is
    // exactly the shape of a shopper replying about a cart link the agent
    // just sent them.
    const payload = upsert();
    (payload.data as Record<string, unknown>).message = {
      extendedTextMessage: { text: 'ya abrí el link, ¿cómo pago?' },
    };
    expect(parse(payload)?.[0].text).toBe('ya abrí el link, ¿cómo pago?');
  });

  it('strips the JID suffix so the shopper matches across providers', () => {
    expect(parse(upsert())?.[0].from).toBe('573001234567');
  });

  it('survives malformed data without throwing', () => {
    expect(parse({ event: 'messages.upsert', instance: 'ventia-dev' })).toEqual([]);
    expect(parse({ event: 'messages.upsert', instance: 'ventia-dev', data: { key: {} } })).toEqual([]);
    expect(provider.verifyAndParseWebhook('not json', auth, config)).toBeNull();
  });
});

describe('evolution — sendText', () => {
  it('posts to /message/sendText/{instance} with the apikey header', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));

    await provider.sendText('573001234567@s.whatsapp.net', 'Claro que sí.', config, fetchImpl);

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://localhost:8080/message/sendText/ventia-dev');
    expect(init.headers.apikey).toBe('instance-apikey');
    expect(JSON.parse(init.body)).toEqual({ number: '573001234567', text: 'Claro que sí.' });
  });

  it('tolerates a trailing slash on the configured base URL', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    await provider.sendText('573001234567', 'hola', { ...config, baseUrl: 'http://localhost:8080/' }, fetchImpl);

    expect(fetchImpl.mock.calls[0][0]).toBe('http://localhost:8080/message/sendText/ventia-dev');
  });

  it('says so when no base URL is configured, rather than requesting undefined/', async () => {
    await expect(
      provider.sendText('573001234567', 'hola', { ...config, baseUrl: undefined }, vi.fn()),
    ).rejects.toThrow(WhatsAppError);
  });

  it('throws on a non-2xx', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('not connected', { status: 400 }));
    await expect(provider.sendText('573001234567', 'hola', config, fetchImpl)).rejects.toThrow(/400/);
  });
});
