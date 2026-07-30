import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { MercadoPagoProvider } from '../src/mercadopago';
import type { NormalizedStatus, OrderForPayment, RawRequest, TenantProviderConfig } from '../src/index';

function hmacSha256Hex(secret: string, input: string): string {
  return createHmac('sha256', secret).update(input, 'utf8').digest('hex');
}

const cfg: TenantProviderConfig = {
  publicKey: 'APP_USR-abc123',
  privateKey: 'APP_USR-prv-abc123',
  sandbox: true,
  eventsSecret: 'test_webhook_secret',
};

const order: OrderForPayment = {
  orderId: 'ord_1',
  orderNumber: 'ORD-0001',
  totalCents: 4990000,
  customerEmail: 'shopper@example.com',
};

describe('MercadoPagoProvider.createCheckoutSession', () => {
  it('builds the preference request with pesos unit_price, external_reference, and Bearer privateKey (not publicKey)', async () => {
    const provider = new MercadoPagoProvider();
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({ init_point: 'https://www.mercadopago.com/checkout/prod', sandbox_init_point: 'https://sandbox.mercadopago.com/checkout/test' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    await provider.createCheckoutSession(order, cfg, fetchImpl as unknown as typeof fetch);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.mercadopago.com/checkout/preferences');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer APP_USR-prv-abc123');

    const body = JSON.parse(init.body as string);
    expect(body.external_reference).toBe('ORD-0001');
    expect(body.items).toHaveLength(1);
    // 4,990,000 cents -> 49,900 pesos (major-unit decimal, NOT cents).
    expect(body.items[0].unit_price).toBe(49900);
    expect(body.items[0].quantity).toBe(1);
    expect(body.items[0].currency_id).toBe('COP');
  });

  it('returns sandbox_init_point as redirectUrl when cfg.sandbox is true', async () => {
    const provider = new MercadoPagoProvider();
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({ init_point: 'https://www.mercadopago.com/checkout/prod', sandbox_init_point: 'https://sandbox.mercadopago.com/checkout/test' }),
        { status: 200 },
      ),
    );

    const { redirectUrl } = await provider.createCheckoutSession(order, cfg, fetchImpl as unknown as typeof fetch);
    expect(redirectUrl).toBe('https://sandbox.mercadopago.com/checkout/test');
  });

  it('returns init_point as redirectUrl when cfg.sandbox is false', async () => {
    const provider = new MercadoPagoProvider();
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({ init_point: 'https://www.mercadopago.com/checkout/prod', sandbox_init_point: 'https://sandbox.mercadopago.com/checkout/test' }),
        { status: 200 },
      ),
    );

    const { redirectUrl } = await provider.createCheckoutSession(
      order,
      { ...cfg, sandbox: false },
      fetchImpl as unknown as typeof fetch,
    );
    expect(redirectUrl).toBe('https://www.mercadopago.com/checkout/prod');
  });

  it('throws on a non-2xx response', async () => {
    const provider = new MercadoPagoProvider();
    const fetchImpl = vi.fn(async () => new Response('bad request', { status: 400 }));
    await expect(
      provider.createCheckoutSession(order, cfg, fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow(/HTTP 400/);
  });

  it('throws if the response is missing both init_point and sandbox_init_point', async () => {
    const provider = new MercadoPagoProvider();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }));
    await expect(
      provider.createCheckoutSession(order, cfg, fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow(/malformed response/);
  });
});

/** Builds a `{type, data: {id}}` webhook payload plus a correctly-computed
 * `x-signature` header, mirroring `wompi.test.ts`'s
 * `buildSignedWebhookPayload` convention — the HMAC here is computed fresh
 * in the test (via Node's own `createHmac`), independently of
 * `mercadopago.ts`'s implementation, so a subtly wrong manifest/algorithm in
 * the implementation would fail this test rather than being invisibly
 * self-consistent. */
function buildSignedWebhookRequest(opts: {
  dataId: string;
  ts: string;
  requestId?: string;
  eventsSecret: string;
}): RawRequest {
  const payload = { type: 'payment', data: { id: opts.dataId } };
  const manifest =
    `id:${opts.dataId};` + (opts.requestId !== undefined ? `request-id:${opts.requestId};` : '') + `ts:${opts.ts};`;
  const v1 = hmacSha256Hex(opts.eventsSecret, manifest);
  const headers: Record<string, string> = {
    'x-signature': `ts=${opts.ts},v1=${v1}`,
  };
  if (opts.requestId !== undefined) {
    headers['x-request-id'] = opts.requestId;
  }
  return {
    headers,
    rawBody: Buffer.from(JSON.stringify(payload), 'utf8'),
  };
}

function mockPaymentLookup(overrides: Partial<Record<string, unknown>> = {}) {
  const body = {
    id: 123456789,
    status: 'approved',
    transaction_amount: 49900,
    external_reference: 'ORD-0001',
    ...overrides,
  };
  return vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
}

describe('MercadoPagoProvider.verifyAndParseWebhook', () => {
  it('accepts a validly-signed payload, fetches the payment, and normalizes it', async () => {
    const provider = new MercadoPagoProvider();
    const req = buildSignedWebhookRequest({
      dataId: '123456789',
      ts: '1742505638683',
      requestId: 'req-abc-123',
      eventsSecret: cfg.eventsSecret!,
    });
    const fetchImpl = mockPaymentLookup();

    const result = await provider.verifyAndParseWebhook(req, cfg, fetchImpl as unknown as typeof fetch);

    expect(result).toEqual({
      provider: 'mercadopago',
      eventId: '123456789',
      providerRef: '123456789',
      reference: 'ORD-0001',
      status: 'PAID',
      amountCents: 4990000,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.mercadopago.com/v1/payments/123456789');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer APP_USR-prv-abc123');
  });

  it('rejects a payload whose v1 signature was tampered with', async () => {
    const provider = new MercadoPagoProvider();
    const req = buildSignedWebhookRequest({
      dataId: '123456789',
      ts: '1742505638683',
      requestId: 'req-abc-123',
      eventsSecret: cfg.eventsSecret!,
    });
    const tampered = req.headers['x-signature'] as string;
    const [tsPart, v1Part] = tampered.split(',');
    const badV1 = v1Part.slice(0, -1) + (v1Part.endsWith('0') ? '1' : '0');
    req.headers['x-signature'] = `${tsPart},${badV1}`;

    await expect(
      provider.verifyAndParseWebhook(req, cfg, mockPaymentLookup() as unknown as typeof fetch),
    ).rejects.toThrow(/signature mismatch/);
  });

  it('rejects a payload whose ts was tampered with (changes the manifest, invalidating the signature)', async () => {
    const provider = new MercadoPagoProvider();
    const req = buildSignedWebhookRequest({
      dataId: '123456789',
      ts: '1742505638683',
      requestId: 'req-abc-123',
      eventsSecret: cfg.eventsSecret!,
    });
    const original = req.headers['x-signature'] as string;
    const [, v1Part] = original.split(',');
    req.headers['x-signature'] = `ts=1742505638999,${v1Part}`;

    await expect(
      provider.verifyAndParseWebhook(req, cfg, mockPaymentLookup() as unknown as typeof fetch),
    ).rejects.toThrow(/signature mismatch/);
  });

  it('rejects a v1 signature of the WRONG LENGTH without throwing an unhandled RangeError', async () => {
    // node:crypto's timingSafeEqual throws (rather than returning false) when
    // given two buffers of different lengths — a naive `timingSafeEqual(a, b)`
    // call on a length-mismatched tampered/truncated signature would crash
    // with an uncaught RangeError instead of cleanly rejecting. This locks in
    // that the implementation's length guard actually prevents that crash
    // (verified correct by code inspection during this task's review, but
    // previously untested).
    const provider = new MercadoPagoProvider();
    const req = buildSignedWebhookRequest({
      dataId: '123456789',
      ts: '1742505638683',
      requestId: 'req-abc-123',
      eventsSecret: cfg.eventsSecret!,
    });
    const tampered = req.headers['x-signature'] as string;
    const [tsPart, v1Part] = tampered.split(',');
    req.headers['x-signature'] = `${tsPart},${v1Part}ff`; // 2 extra hex chars — wrong length, not just wrong content

    await expect(
      provider.verifyAndParseWebhook(req, cfg, mockPaymentLookup() as unknown as typeof fetch),
    ).rejects.toThrow(/signature mismatch/);
  });

  it('rejects when x-request-id is missing and the manifest was (correctly) built assuming it was present', async () => {
    // This request is signed AS IF request-id were present (attacker/relay
    // scenario: signature computed over a manifest that includes
    // `request-id:...;`), but the header itself is stripped before
    // delivery. Per this adapter's "omit if absent" implementation, it
    // recomputes the manifest WITHOUT the request-id segment, which no
    // longer matches — signature mismatch, correctly rejected.
    const provider = new MercadoPagoProvider();
    const req = buildSignedWebhookRequest({
      dataId: '123456789',
      ts: '1742505638683',
      requestId: 'req-abc-123',
      eventsSecret: cfg.eventsSecret!,
    });
    delete req.headers['x-request-id'];

    await expect(
      provider.verifyAndParseWebhook(req, cfg, mockPaymentLookup() as unknown as typeof fetch),
    ).rejects.toThrow(/signature mismatch/);
  });

  it('accepts a validly-signed payload that never had x-request-id at all (manifest omits the segment on both sides)', async () => {
    const provider = new MercadoPagoProvider();
    const req = buildSignedWebhookRequest({
      dataId: '123456789',
      ts: '1742505638683',
      eventsSecret: cfg.eventsSecret!,
      // requestId omitted entirely — both the signer (this helper) and the
      // implementation must agree to drop the segment.
    });

    const result = await provider.verifyAndParseWebhook(req, cfg, mockPaymentLookup() as unknown as typeof fetch);
    expect(result.status).toBe('PAID');
  });

  it('rejects malformed JSON bodies', async () => {
    const provider = new MercadoPagoProvider();
    const req: RawRequest = { headers: { 'x-signature': 'ts=1,v1=deadbeef' }, rawBody: Buffer.from('not json', 'utf8') };
    await expect(provider.verifyAndParseWebhook(req, cfg)).rejects.toThrow(/not valid JSON/);
  });

  it('rejects a payload missing the x-signature header entirely', async () => {
    const provider = new MercadoPagoProvider();
    const req: RawRequest = {
      headers: {},
      rawBody: Buffer.from(JSON.stringify({ type: 'payment', data: { id: '1' } }), 'utf8'),
    };
    await expect(provider.verifyAndParseWebhook(req, cfg)).rejects.toThrow(/missing x-signature/);
  });

  it('throws if eventsSecret is missing from cfg', async () => {
    const provider = new MercadoPagoProvider();
    const badCfg: TenantProviderConfig = { publicKey: 'pub', privateKey: 'prv', sandbox: true };
    const req = buildSignedWebhookRequest({ dataId: '1', ts: '1', eventsSecret: 'irrelevant' });
    await expect(provider.verifyAndParseWebhook(req, badCfg)).rejects.toThrow(/eventsSecret/);
  });

  it.each([
    ['approved', 'PAID'],
    ['pending', 'PENDING'],
    ['in_process', 'PENDING'],
    ['authorized', 'PENDING'],
    ['in_mediation', 'PENDING'],
    ['rejected', 'FAILED'],
    ['cancelled', 'FAILED'],
    ['refunded', 'EXPIRED'],
    ['charged_back', 'EXPIRED'],
  ] satisfies [string, NormalizedStatus][])(
    'maps payment-lookup status %s to NormalizedStatus %s',
    async (mpStatus, expected) => {
      const provider = new MercadoPagoProvider();
      const req = buildSignedWebhookRequest({
        dataId: '999',
        ts: '1742505638683',
        requestId: 'req-1',
        eventsSecret: cfg.eventsSecret!,
      });
      const fetchImpl = mockPaymentLookup({ status: mpStatus });

      const result = await provider.verifyAndParseWebhook(req, cfg, fetchImpl as unknown as typeof fetch);
      expect(result.status).toBe(expected);
    },
  );

  it('cancelled and refunded/charged_back land in DIFFERENT buckets (FAILED vs EXPIRED)', async () => {
    const provider = new MercadoPagoProvider();

    const cancelledReq = buildSignedWebhookRequest({
      dataId: '1',
      ts: '1',
      requestId: 'r1',
      eventsSecret: cfg.eventsSecret!,
    });
    const cancelledResult = await provider.verifyAndParseWebhook(
      cancelledReq,
      cfg,
      mockPaymentLookup({ status: 'cancelled' }) as unknown as typeof fetch,
    );

    const refundedReq = buildSignedWebhookRequest({
      dataId: '2',
      ts: '2',
      requestId: 'r2',
      eventsSecret: cfg.eventsSecret!,
    });
    const refundedResult = await provider.verifyAndParseWebhook(
      refundedReq,
      cfg,
      mockPaymentLookup({ status: 'refunded' }) as unknown as typeof fetch,
    );

    expect(cancelledResult.status).toBe('FAILED');
    expect(refundedResult.status).toBe('EXPIRED');
    expect(cancelledResult.status).not.toBe(refundedResult.status);
  });
});

describe('MercadoPagoProvider.getTransactionStatus', () => {
  it.each([
    ['approved', 'PAID'],
    ['pending', 'PENDING'],
    ['in_process', 'PENDING'],
    ['authorized', 'PENDING'],
    ['in_mediation', 'PENDING'],
    ['rejected', 'FAILED'],
    ['cancelled', 'FAILED'],
    ['refunded', 'EXPIRED'],
    ['charged_back', 'EXPIRED'],
  ] satisfies [string, NormalizedStatus][])(
    'maps MP status %s to NormalizedStatus %s via the shared mapStatus',
    async (mpStatus, expected) => {
      const provider = new MercadoPagoProvider();
      const fetchImpl = vi.fn(async () =>
        new Response(JSON.stringify({ id: 42, status: mpStatus, transaction_amount: 100, external_reference: 'X' }), {
          status: 200,
        }),
      );

      const status = await provider.getTransactionStatus('42', cfg, fetchImpl as unknown as typeof fetch);
      expect(status).toBe(expected);
    },
  );

  it('uses Bearer privateKey (not publicKey) against the real payment-lookup URL', async () => {
    const provider = new MercadoPagoProvider();
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ id: 42, status: 'approved' }), { status: 200 }),
    );
    await provider.getTransactionStatus('42', cfg, fetchImpl as unknown as typeof fetch);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.mercadopago.com/v1/payments/42');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer APP_USR-prv-abc123');
  });

  it('throws on a non-2xx response instead of returning a bogus status', async () => {
    const provider = new MercadoPagoProvider();
    const fetchImpl = vi.fn(async () => new Response('not found', { status: 404 }));
    await expect(
      provider.getTransactionStatus('missing', cfg, fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow(/HTTP 404/);
  });
});
