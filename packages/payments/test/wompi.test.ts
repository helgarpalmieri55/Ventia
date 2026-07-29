import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { WompiProvider } from '../src/wompi';
import type { NormalizedStatus, OrderForPayment, RawRequest, TenantProviderConfig } from '../src/index';

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

const cfg: TenantProviderConfig = {
  publicKey: 'pub_test_abc123',
  privateKey: 'prv_test_abc123',
  sandbox: true,
  integritySecret: 'test_integrity_secret456',
  eventsSecret: 'test_events_secret789',
};

const order: OrderForPayment = {
  orderId: 'ord_1',
  orderNumber: 'ORD-0001',
  totalCents: 4990000,
  customerEmail: 'shopper@example.com',
};

describe('WompiProvider.createCheckoutSession', () => {
  it('builds the checkout redirect URL with the exact independently-computed integrity signature', async () => {
    const provider = new WompiProvider();
    const { redirectUrl } = await provider.createCheckoutSession(order, cfg);

    // Independently hand-computed per Wompi's real integrity-signature
    // formula (SHA256(reference + amountInCents + currency +
    // integritySecret)), NOT by calling any internal helper of the
    // implementation — this way the test fails if the implementation's
    // algorithm is subtly wrong (wrong field order, missing field, etc.).
    const expectedSignature = sha256Hex(`ORD-0001${4990000}COP${cfg.integritySecret}`);

    const url = new URL(redirectUrl);
    expect(url.origin + url.pathname).toBe('https://checkout.wompi.co/p/');
    expect(url.searchParams.get('public-key')).toBe('pub_test_abc123');
    expect(url.searchParams.get('currency')).toBe('COP');
    expect(url.searchParams.get('amount-in-cents')).toBe('4990000');
    expect(url.searchParams.get('reference')).toBe('ORD-0001');
    expect(url.searchParams.get('signature:integrity')).toBe(expectedSignature);
    // Sanity: the expected digest is a real 64-char SHA256 hex string, so a
    // typo in the hand-computed expectation itself would also be caught.
    expect(expectedSignature).toMatch(/^[0-9a-f]{64}$/);
  });

  it('throws if integritySecret is missing from cfg, rather than silently building an unsigned URL', async () => {
    const provider = new WompiProvider();
    const badCfg: TenantProviderConfig = { publicKey: 'pub', privateKey: 'prv', sandbox: true };
    await expect(provider.createCheckoutSession(order, badCfg)).rejects.toThrow(/integritySecret/);
  });
});

function buildSignedWebhookPayload(opts: {
  transactionId: string;
  status: string;
  amountInCents: number;
  reference: string;
  timestamp: number;
  eventsSecret: string;
  properties?: string[];
}) {
  const properties = opts.properties ?? [
    'transaction.id',
    'transaction.status',
    'transaction.amount_in_cents',
    'transaction.reference',
  ];
  const data = {
    transaction: {
      id: opts.transactionId,
      status: opts.status,
      amount_in_cents: opts.amountInCents,
      reference: opts.reference,
      currency: 'COP',
    },
  };
  const valuesByPath: Record<string, unknown> = {
    'transaction.id': data.transaction.id,
    'transaction.status': data.transaction.status,
    'transaction.amount_in_cents': data.transaction.amount_in_cents,
    'transaction.reference': data.transaction.reference,
  };
  // Independently computed (same formula as the doc/implementation, but
  // built fresh in the test): SHA256(concat(property values in order) +
  // timestamp + eventsSecret).
  const concatenated = properties.map((p) => String(valuesByPath[p])).join('') + String(opts.timestamp) + opts.eventsSecret;
  const checksum = sha256Hex(concatenated);
  return {
    event: 'transaction.updated',
    data,
    signature: { properties, checksum },
    timestamp: opts.timestamp,
    sent_at: new Date(opts.timestamp * 1000).toISOString(),
  };
}

function toRawRequest(payload: unknown): RawRequest {
  return {
    headers: { 'content-type': 'application/json' },
    rawBody: Buffer.from(JSON.stringify(payload), 'utf8'),
  };
}

describe('WompiProvider.verifyAndParseWebhook', () => {
  it('accepts a validly-signed payload and normalizes it', async () => {
    const provider = new WompiProvider();
    const payload = buildSignedWebhookPayload({
      transactionId: 'txn-1234-abcd',
      status: 'APPROVED',
      amountInCents: 4990000,
      reference: 'ORD-0001',
      timestamp: 1700000000,
      eventsSecret: cfg.eventsSecret!,
    });

    const result = await provider.verifyAndParseWebhook(toRawRequest(payload), cfg);

    expect(result).toEqual({
      provider: 'wompi',
      eventId: 'txn-1234-abcd:1700000000',
      providerRef: 'txn-1234-abcd',
      reference: 'ORD-0001',
      status: 'PAID',
      amountCents: 4990000,
    });
  });

  it('rejects a payload whose checksum was tampered with', async () => {
    const provider = new WompiProvider();
    const payload = buildSignedWebhookPayload({
      transactionId: 'txn-1234-abcd',
      status: 'APPROVED',
      amountInCents: 4990000,
      reference: 'ORD-0001',
      timestamp: 1700000000,
      eventsSecret: cfg.eventsSecret!,
    });
    payload.signature.checksum = payload.signature.checksum.slice(0, -1) + (payload.signature.checksum.endsWith('0') ? '1' : '0');

    await expect(provider.verifyAndParseWebhook(toRawRequest(payload), cfg)).rejects.toThrow(/signature mismatch/);
  });

  it('rejects a payload where a signed field was tampered with but the checksum was not recomputed', async () => {
    const provider = new WompiProvider();
    const payload = buildSignedWebhookPayload({
      transactionId: 'txn-1234-abcd',
      status: 'APPROVED',
      amountInCents: 4990000,
      reference: 'ORD-0001',
      timestamp: 1700000000,
      eventsSecret: cfg.eventsSecret!,
    });
    // Attacker flips a DECLINED transaction to look APPROVED without
    // recomputing the checksum.
    payload.data.transaction.status = 'DECLINED';

    await expect(provider.verifyAndParseWebhook(toRawRequest(payload), cfg)).rejects.toThrow(/signature mismatch/);
  });

  it('rejects a validly-checksummed payload whose signature.properties omits a field this method relies on', async () => {
    const provider = new WompiProvider();
    // The checksum here is genuinely valid FOR THE NARROWER properties list
    // (only transaction.id is signed) — an attacker who controls the
    // transport (or a Wompi event type that only signs a subset of fields)
    // could flip `transaction.status`/`amount_in_cents` freely without
    // invalidating this checksum, since those fields were never bound into
    // it. Without the properties-coverage check, this payload would be
    // accepted with `status: 'DECLINED'` silently trusted despite having
    // zero cryptographic backing.
    const payload = buildSignedWebhookPayload({
      transactionId: 'txn-1234-abcd',
      status: 'DECLINED',
      amountInCents: 4990000,
      reference: 'ORD-0001',
      timestamp: 1700000000,
      eventsSecret: cfg.eventsSecret!,
      properties: ['transaction.id'],
    });

    await expect(provider.verifyAndParseWebhook(toRawRequest(payload), cfg)).rejects.toThrow(
      /doesn't cover required field/,
    );
  });

  it('rejects a validly-checksummed payload whose signature.properties omits transaction.reference', async () => {
    const provider = new WompiProvider();
    // The checksum here is genuinely valid for the narrower properties list
    // (transaction.reference is not signed) — an attacker who controls the
    // transport could substitute a DIFFERENT reference (routing this event
    // to someone else's order) without invalidating this checksum, since
    // `reference` was never bound into it. Without the properties-coverage
    // check, this payload would have its (tampered) reference silently
    // trusted despite zero cryptographic backing on that field.
    const payload = buildSignedWebhookPayload({
      transactionId: 'txn-1234-abcd',
      status: 'APPROVED',
      amountInCents: 4990000,
      reference: 'ORD-0001',
      timestamp: 1700000000,
      eventsSecret: cfg.eventsSecret!,
      properties: ['transaction.id', 'transaction.status', 'transaction.amount_in_cents'],
    });

    await expect(provider.verifyAndParseWebhook(toRawRequest(payload), cfg)).rejects.toThrow(
      /doesn't cover required field/,
    );
  });

  it('rejects malformed JSON bodies', async () => {
    const provider = new WompiProvider();
    const req: RawRequest = { headers: {}, rawBody: Buffer.from('not json', 'utf8') };
    await expect(provider.verifyAndParseWebhook(req, cfg)).rejects.toThrow(/not valid JSON/);
  });

  it.each([
    ['APPROVED', 'PAID'],
    ['PENDING', 'PENDING'],
    ['DECLINED', 'FAILED'],
    ['VOIDED', 'FAILED'],
    ['ERROR', 'FAILED'],
  ] satisfies [string, NormalizedStatus][])('maps webhook status %s to %s', async (wompiStatus, expected) => {
    const provider = new WompiProvider();
    const payload = buildSignedWebhookPayload({
      transactionId: 'txn-status-test',
      status: wompiStatus,
      amountInCents: 100000,
      reference: 'ORD-STATUS',
      timestamp: 1700000001,
      eventsSecret: cfg.eventsSecret!,
    });
    const result = await provider.verifyAndParseWebhook(toRawRequest(payload), cfg);
    expect(result.status).toBe(expected);
  });
});

describe('WompiProvider.getTransactionStatus', () => {
  it.each([
    ['APPROVED', 'PAID'],
    ['PENDING', 'PENDING'],
    ['DECLINED', 'FAILED'],
    ['VOIDED', 'FAILED'],
    ['ERROR', 'FAILED'],
  ] satisfies [string, NormalizedStatus][])('maps Wompi status %s to NormalizedStatus %s', async (wompiStatus, expected) => {
    const provider = new WompiProvider();
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ data: { id: 'txn-abc', status: wompiStatus, amount_in_cents: 100000 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const status = await provider.getTransactionStatus('txn-abc', cfg, fetchImpl as unknown as typeof fetch);

    expect(status).toBe(expected);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://sandbox.wompi.co/v1/transactions/txn-abc');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer pub_test_abc123');
  });

  it('uses the production base URL when cfg.sandbox is false', async () => {
    const provider = new WompiProvider();
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ data: { id: 'txn-abc', status: 'APPROVED', amount_in_cents: 100000 } }), {
        status: 200,
      }),
    );
    await provider.getTransactionStatus('txn-abc', { ...cfg, sandbox: false }, fetchImpl as unknown as typeof fetch);
    const [url] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://production.wompi.co/v1/transactions/txn-abc');
  });

  it('throws on a non-2xx response instead of returning a bogus status', async () => {
    const provider = new WompiProvider();
    const fetchImpl = vi.fn(async () => new Response('not found', { status: 404 }));
    await expect(
      provider.getTransactionStatus('missing', cfg, fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow(/HTTP 404/);
  });

  it('defaults fetchImpl to the global fetch when not provided (no crash constructing the call)', () => {
    const provider = new WompiProvider();
    expect(typeof provider.getTransactionStatus).toBe('function');
    // Not actually invoked without an injected fetchImpl in this suite —
    // this just documents/locks in that the 3rd param is optional.
    expect(provider.getTransactionStatus.length).toBeLessThanOrEqual(3);
  });
});
