import { describe, expect, it, vi } from 'vitest';
import { createHandoffConversation, isConfigured } from '../src/chatwoot/chatwoot.client';

/**
 * The Chatwoot handoff client.
 *
 * Written against Chatwoot's documented application API but NOT verified
 * against a live instance — there is none in this repo's compose stack. These
 * assert the request shapes and, more importantly, the two properties that
 * would be damaging if wrong: the summary must be PRIVATE (it is internal
 * context, not something to send the customer), and a failure must be
 * reportable rather than silent.
 */

const config = {
  baseUrl: 'https://chat.ventia.co',
  apiToken: 'cw-token',
  accountId: '1',
  inboxId: '7',
};

const payload = {
  sourceId: '573001234567',
  contactName: '573001234567',
  reason: 'la clienta pidió hablar con una persona',
  transcriptSummary: 'Preguntó por tallas, no quedó conforme, 3 intentos sin resolver.',
  conversationUrl: 'http://admin.ventia.localhost/conversaciones?c=abc',
};

function okJson(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('isConfigured', () => {
  it('accepts a complete config', () => {
    expect(isConfigured(config)).toBe(true);
  });

  it('treats a MISSING config as unconfigured, not as an error', () => {
    // Most stores will never connect a Chatwoot. Unconfigured is the normal
    // case and must escalate exactly as before.
    expect(isConfigured(null)).toBe(false);
    expect(isConfigured(undefined)).toBe(false);
    expect(isConfigured({})).toBe(false);
  });

  it('treats a HALF-configured tenant as unconfigured', () => {
    // A token with no inbox would open conversations nowhere; better to fall
    // back to email than to half-deliver.
    expect(isConfigured({ ...config, inboxId: undefined })).toBe(false);
    expect(isConfigured({ ...config, apiToken: '' })).toBe(false);
  });
});

describe('createHandoffConversation', () => {
  it('opens a conversation, then posts the summary as a message', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(okJson({ id: 42 }))
      .mockResolvedValueOnce(okJson({ id: 99 }));

    const result = await createHandoffConversation(config, payload, fetchImpl);

    expect(result.conversationId).toBe(42);
    const [convUrl, convInit] = fetchImpl.mock.calls[0];
    expect(convUrl).toBe('https://chat.ventia.co/api/v1/accounts/1/conversations');
    expect(convInit.headers.api_access_token).toBe('cw-token');
    expect(JSON.parse(convInit.body)).toMatchObject({
      source_id: '573001234567',
      inbox_id: '7',
      // Open, not pending: it exists because it needs a person.
      status: 'open',
    });

    const [msgUrl] = fetchImpl.mock.calls[1];
    expect(msgUrl).toBe('https://chat.ventia.co/api/v1/accounts/1/conversations/42/messages');
  });

  it('marks the summary PRIVATE', async () => {
    // The single most damaging thing this could get wrong. The summary is
    // internal context — "3 intentos sin resolver" — and a non-private message
    // is delivered straight to the shopper.
    const fetchImpl = vi.fn().mockResolvedValueOnce(okJson({ id: 42 })).mockResolvedValueOnce(okJson({ id: 99 }));

    await createHandoffConversation(config, payload, fetchImpl);

    const body = JSON.parse(fetchImpl.mock.calls[1][1].body);
    expect(body.private).toBe(true);
  });

  it('includes a link back to the real transcript', async () => {
    // The summary is the model's; whoever picks this up needs the actual
    // conversation to work from.
    const fetchImpl = vi.fn().mockResolvedValueOnce(okJson({ id: 42 })).mockResolvedValueOnce(okJson({ id: 99 }));

    await createHandoffConversation(config, payload, fetchImpl);

    const body = JSON.parse(fetchImpl.mock.calls[1][1].body);
    expect(body.content).toContain(payload.conversationUrl);
    expect(body.content).toContain(payload.reason);
    expect(body.content).toContain(payload.transcriptSummary);
  });

  it('tolerates a trailing slash on the configured base URL', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(okJson({ id: 42 })).mockResolvedValueOnce(okJson({ id: 99 }));

    await createHandoffConversation({ ...config, baseUrl: 'https://chat.ventia.co/' }, payload, fetchImpl);

    expect(fetchImpl.mock.calls[0][0]).toBe('https://chat.ventia.co/api/v1/accounts/1/conversations');
  });

  it('throws with the status when Chatwoot rejects the conversation', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response('unauthorized', { status: 401 }));

    await expect(createHandoffConversation(config, payload, fetchImpl)).rejects.toThrow(/401/);
  });

  it('throws when the response carries no conversation id, rather than posting to undefined', async () => {
    // A 200 with an unexpected body would otherwise produce a message POST to
    // `/conversations/undefined/messages` and a confusing 404.
    const fetchImpl = vi.fn().mockResolvedValueOnce(okJson({ unexpected: true }));

    await expect(createHandoffConversation(config, payload, fetchImpl)).rejects.toThrow(/no conversation id/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('throws when the summary message fails, even though the conversation was created', async () => {
    // A conversation with no summary is a blank ticket. The caller logs this;
    // it must not pass silently.
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(okJson({ id: 42 }))
      .mockResolvedValueOnce(new Response('nope', { status: 422 }));

    await expect(createHandoffConversation(config, payload, fetchImpl)).rejects.toThrow(/422/);
  });
});
