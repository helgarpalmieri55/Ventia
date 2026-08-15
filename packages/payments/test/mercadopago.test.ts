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
    // A real MP payment resource always carries this alongside
    // `transaction_amount` (it is the currency that amount is denominated in);
    // the default fixture carries it too so the happy paths exercise the same
    // shape the live API returns. Overridable per-test.
    currency_id: 'COP',
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
      // P3 wave-1 fix 3: payment id + the payment's own gateway status, NOT
      // the bare payment id this used to assert — see the dedicated
      // "eventId composition (fix 3)" describe block below for why.
      eventId: '123456789:approved',
      providerRef: '123456789',
      reference: 'ORD-0001',
      status: 'PAID',
      amountCents: 4990000,
      // Read off the SAME authenticated payment resource `amountCents` comes
      // from — see the currency describe block below.
      currency: 'COP',
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

/** P3 wave-1 fix 3 — regression coverage for a HIGH-severity defect.
 *
 * `eventId` used to be `String(payment.id)` — the PAYMENT id, not an EVENT
 * id. Mercado Pago fires ONE notification per status change on the SAME
 * payment (`pending` -> `approved` is two deliveries carrying the same
 * `data.id`), so under the old composition the first, still-unpaid delivery
 * inserted the `WebhookEvent` idempotency row and the LATER, APPROVED one
 * collided with it and was discarded as a "replay" — 200 OK, order left
 * PENDING/PENDING forever. Wompi's adapter already composes
 * `transaction.id:timestamp` to avoid exactly this; MP now composes the
 * payment id with the payment's own gateway status.
 *
 * The two properties below are in tension and BOTH matter — a composition
 * that satisfies only one of them is not a fix:
 *  1. two deliveries for the same payment at DIFFERENT statuses must produce
 *     DIFFERENT event ids (or the settling one gets swallowed), and
 *  2. two deliveries of the SAME notification must produce the SAME event id
 *     (or genuine gateway retries settle the order twice). This is why the
 *     per-DELIVERY values available here (`x-request-id`, the signature's
 *     `ts`) are deliberately NOT part of the composition: they differ across
 *     redeliveries of one notification and would defeat dedupe entirely. */
describe('MercadoPagoProvider.verifyAndParseWebhook — eventId composition (fix 3)', () => {
  it('the pending and approved notifications for ONE payment produce DIFFERENT eventIds', async () => {
    const provider = new MercadoPagoProvider();

    const pendingReq = buildSignedWebhookRequest({
      dataId: '123456789',
      ts: '1742505638683',
      requestId: 'req-delivery-1',
      eventsSecret: cfg.eventsSecret!,
    });
    const pending = await provider.verifyAndParseWebhook(
      pendingReq,
      cfg,
      mockPaymentLookup({ status: 'pending' }) as unknown as typeof fetch,
    );

    // Same payment id — the shopper finished paying, MP notifies again.
    const approvedReq = buildSignedWebhookRequest({
      dataId: '123456789',
      ts: '1742505699999',
      requestId: 'req-delivery-2',
      eventsSecret: cfg.eventsSecret!,
    });
    const approved = await provider.verifyAndParseWebhook(
      approvedReq,
      cfg,
      mockPaymentLookup({ status: 'approved' }) as unknown as typeof fetch,
    );

    expect(pending.status).toBe('PENDING');
    expect(approved.status).toBe('PAID');
    // The whole point: these must not collapse onto one idempotency key.
    expect(approved.eventId).not.toBe(pending.eventId);
    // Both still identify the same payment for every other purpose.
    expect(pending.providerRef).toBe('123456789');
    expect(approved.providerRef).toBe('123456789');
    // Composition is payment id + the payment's own gateway status.
    expect(pending.eventId).toBe('123456789:pending');
    expect(approved.eventId).toBe('123456789:approved');
  });

  it('two deliveries of the SAME notification still produce the SAME eventId (dedupe preserved)', async () => {
    const provider = new MercadoPagoProvider();

    // A genuine MP retry: same payment, same status, but a NEW x-request-id
    // and a NEW signature ts — the two things that vary per delivery.
    const first = await provider.verifyAndParseWebhook(
      buildSignedWebhookRequest({
        dataId: '987654321',
        ts: '1742505638683',
        requestId: 'req-original',
        eventsSecret: cfg.eventsSecret!,
      }),
      cfg,
      mockPaymentLookup({ id: 987654321, status: 'approved' }) as unknown as typeof fetch,
    );
    const retry = await provider.verifyAndParseWebhook(
      buildSignedWebhookRequest({
        dataId: '987654321',
        ts: '1742509999999',
        requestId: 'req-retry',
        eventsSecret: cfg.eventsSecret!,
      }),
      cfg,
      mockPaymentLookup({ id: 987654321, status: 'approved' }) as unknown as typeof fetch,
    );

    expect(retry.eventId).toBe(first.eventId);
  });
});

describe('MercadoPagoProvider.verifyAndParseWebhook — the CURRENCY term', () => {
  // The webhook path had no currency at all, so the controller's amount check
  // compared a bare number. MP is the strongest of the three here: the value
  // comes off the same AUTHENTICATED `GET /v1/payments/:id` resource
  // `transaction_amount` does, so it is as trustworthy as the amount itself.
  it("reports the payment resource's own currency_id", async () => {
    const provider = new MercadoPagoProvider();
    const result = await provider.verifyAndParseWebhook(
      buildSignedWebhookRequest({ dataId: '123456789', ts: '1742505638683', eventsSecret: cfg.eventsSecret! }),
      cfg,
      mockPaymentLookup({ currency_id: 'USD' }) as unknown as typeof fetch,
    );

    expect(result.currency).toBe('USD');
  });

  it('leaves currency undefined rather than defaulting to COP when the lookup omits it', async () => {
    const provider = new MercadoPagoProvider();
    const result = await provider.verifyAndParseWebhook(
      buildSignedWebhookRequest({ dataId: '123456789', ts: '1742505638683', eventsSecret: cfg.eventsSecret! }),
      cfg,
      mockPaymentLookup({ currency_id: undefined }) as unknown as typeof fetch,
    );

    expect(result.currency).toBeUndefined();
  });

  it('ignores a non-string currency_id rather than coercing it', async () => {
    const provider = new MercadoPagoProvider();
    const result = await provider.verifyAndParseWebhook(
      buildSignedWebhookRequest({ dataId: '123456789', ts: '1742505638683', eventsSecret: cfg.eventsSecret! }),
      cfg,
      mockPaymentLookup({ currency_id: 170 }) as unknown as typeof fetch,
    );

    expect(result.currency).toBeUndefined();
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

      const result = await provider.getTransactionStatus('42', cfg, fetchImpl as unknown as typeof fetch);
      expect(result.status).toBe(expected);
    },
  );

  // --- P3c Task 2 (requirement 1): the ORDER-BINDING fields. Both
  // `external_reference` and `transaction_amount` are declared on the
  // official Mercado Pago Node SDK's own compiled `PaymentResponse` type for
  // this exact resource — see the adapter's module doc comment.
  it("returns MP's own external_reference and transaction_amount (pesos -> cents) alongside the status", async () => {
    const provider = new MercadoPagoProvider();
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          id: 42,
          status: 'approved',
          external_reference: '1042',
          transaction_amount: 49900,
          currency_id: 'COP',
        }),
        { status: 200 },
      ),
    );

    const result = await provider.getTransactionStatus('42', cfg, fetchImpl as unknown as typeof fetch);

    // MAJOR units in (49,900 pesos), cents out (4,990,000) — the same
    // direction `verifyAndParseWebhook` already converts, and the inverse of
    // `createCheckoutSession`'s `unit_price: totalCents / 100`. Getting this
    // backwards would make every amount check 10,000x off.
    expect(result).toEqual({ status: 'PAID', reference: '1042', amountCents: 4990000, currency: 'COP' });
  });

  it('rounds a fractional transaction_amount to whole cents rather than emitting a float', async () => {
    const provider = new MercadoPagoProvider();
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({ id: 42, status: 'approved', external_reference: '7', transaction_amount: 75.56 }),
        { status: 200 },
      ),
    );
    const result = await provider.getTransactionStatus('42', cfg, fetchImpl as unknown as typeof fetch);
    expect(result.amountCents).toBe(7556);
    expect(Number.isInteger(result.amountCents)).toBe(true);
  });

  it('leaves reference/amountCents undefined (rather than throwing) when the payment carries neither — only `status` is required', async () => {
    const provider = new MercadoPagoProvider();
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ id: 42, status: 'rejected' }), { status: 200 }),
    );
    const result = await provider.getTransactionStatus('42', cfg, fetchImpl as unknown as typeof fetch);
    expect(result.status).toBe('FAILED');
    expect(result.reference).toBeUndefined();
    expect(result.amountCents).toBeUndefined();
  });

  it('ignores a non-string external_reference / non-number transaction_amount rather than coercing them', async () => {
    const provider = new MercadoPagoProvider();
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({ id: 42, status: 'approved', external_reference: 1042, transaction_amount: '49900' }),
        { status: 200 },
      ),
    );
    const result = await provider.getTransactionStatus('42', cfg, fetchImpl as unknown as typeof fetch);
    expect(result.reference).toBeUndefined();
    expect(result.amountCents).toBeUndefined();
  });

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

  // --- P3 wave-2 FIX 3: the CURRENCY term. MP names this `currency_id` on
  // the payment resource, not `currency`.
  it("reports MP's own currency_id so the caller can require COP", async () => {
    const provider = new MercadoPagoProvider();
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({ id: 42, status: 'approved', external_reference: '1042', transaction_amount: 49900, currency_id: 'USD' }),
        { status: 200 },
      ),
    );

    const result = await provider.getTransactionStatus('42', cfg, fetchImpl as unknown as typeof fetch);

    expect(result.currency).toBe('USD');
  });

  it('leaves currency undefined rather than defaulting to COP when currency_id is absent', async () => {
    const provider = new MercadoPagoProvider();
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({ id: 42, status: 'approved', external_reference: '1042', transaction_amount: 49900 }),
        { status: 200 },
      ),
    );

    const result = await provider.getTransactionStatus('42', cfg, fetchImpl as unknown as typeof fetch);

    expect(result.currency).toBeUndefined();
  });

});

describe('MercadoPagoProvider.searchByReference', () => {
  function mockSearch(results: Record<string, unknown>[]) {
    return vi.fn(async () =>
      new Response(JSON.stringify({ paging: { total: results.length, limit: 30, offset: 0 }, results }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }

  it('returns null when results is empty', async () => {
    const provider = new MercadoPagoProvider();
    const fetchImpl = mockSearch([]);

    const result = await provider.searchByReference('ORD-0001', cfg, fetchImpl as unknown as typeof fetch);

    expect(result).toBeNull();
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.mercadopago.com/v1/payments/search?external_reference=ORD-0001');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer APP_USR-prv-abc123');
  });

  it('single approved result -> returns { providerRef, status: PAID } mapped via the shared mapStatus', async () => {
    const provider = new MercadoPagoProvider();
    const fetchImpl = mockSearch([
      {
        id: 555,
        status: 'approved',
        external_reference: 'ORD-0002',
        date_created: '2026-07-30T10:00:00.000-04:00',
        date_approved: '2026-07-30T10:01:00.000-04:00',
      },
    ]);

    const result = await provider.searchByReference('ORD-0002', cfg, fetchImpl as unknown as typeof fetch);

    expect(result).toEqual({ providerRef: '555', status: 'PAID', reference: 'ORD-0002' });
  });

  it('multiple results with mixed statuses: picks the approved one regardless of array position (NOT first)', async () => {
    const provider = new MercadoPagoProvider();
    // The approved attempt is deliberately NOT first in the array, and is
    // NOT the most recent by date either for the rejected one immediately
    // preceding it — this proves the implementation actually finds/picks the
    // approved entry rather than just taking results[0] or the max-date
    // entry blindly.
    const fetchImpl = mockSearch([
      {
        id: 111,
        status: 'rejected',
        external_reference: 'ORD-0003',
        date_created: '2026-07-30T09:00:00.000-04:00',
        date_approved: null,
      },
      {
        id: 222,
        status: 'rejected',
        external_reference: 'ORD-0003',
        date_created: '2026-07-30T09:30:00.000-04:00',
        date_approved: null,
      },
      {
        id: 333,
        status: 'approved',
        external_reference: 'ORD-0003',
        date_created: '2026-07-30T09:15:00.000-04:00',
        date_approved: '2026-07-30T09:16:00.000-04:00',
      },
    ]);

    const result = await provider.searchByReference('ORD-0003', cfg, fetchImpl as unknown as typeof fetch);

    expect(result).toEqual({ providerRef: '333', status: 'PAID', reference: 'ORD-0003' });
  });

  it('no approved result among multiple -> picks the most recent attempt of any status', async () => {
    const provider = new MercadoPagoProvider();
    // Most-recent (by date_created, since neither has date_approved) is id
    // 222, but it is NOT first in the array — proves the client-side sort,
    // not just "take the last element", actually runs.
    const fetchImpl = mockSearch([
      {
        id: 222,
        status: 'rejected',
        external_reference: 'ORD-0004',
        date_created: '2026-07-30T09:30:00.000-04:00',
        date_approved: null,
      },
      {
        id: 111,
        status: 'cancelled',
        external_reference: 'ORD-0004',
        date_created: '2026-07-30T09:00:00.000-04:00',
        date_approved: null,
      },
    ]);

    const result = await provider.searchByReference('ORD-0004', cfg, fetchImpl as unknown as typeof fetch);

    expect(result).toEqual({ providerRef: '222', status: 'FAILED', reference: 'ORD-0004' });
  });

  it('throws on a non-2xx response instead of returning null or a bogus result', async () => {
    const provider = new MercadoPagoProvider();
    const fetchImpl = vi.fn(async () => new Response('unauthorized', { status: 401 }));

    await expect(
      provider.searchByReference('ORD-0005', cfg, fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow(/HTTP 401/);
  });

  // --- P3c review follow-up: the search result now carries the GATEWAY'S OWN
  // `external_reference`/`transaction_amount` back to the caller, so the
  // reconciliation worker's `checkOrderBinding` can verify a real, gateway-
  // asserted binding instead of restating its own query key (which made the
  // reference comparison a tautology on this path).
  it("carries the CHOSEN result's own external_reference and transaction_amount (pesos -> cents)", async () => {
    const provider = new MercadoPagoProvider();
    const fetchImpl = mockSearch([
      {
        id: 777,
        status: 'approved',
        external_reference: 'ORD-0006',
        transaction_amount: 250.5,
        date_created: '2026-07-30T10:00:00.000-04:00',
        date_approved: '2026-07-30T10:01:00.000-04:00',
      },
    ]);

    const result = await provider.searchByReference('ORD-0006', cfg, fetchImpl as unknown as typeof fetch);

    expect(result).toEqual({
      providerRef: '777',
      status: 'PAID',
      reference: 'ORD-0006',
      // MAJOR units in (pesos), cents out — identical conversion to
      // getTransactionStatus/verifyAndParseWebhook in this same adapter.
      amountCents: 25_050,
    });
  });

  it('DROPS a result whose external_reference does not equal the queried reference', async () => {
    const provider = new MercadoPagoProvider();
    // The exact failure mode the belt-and-braces filter exists for: MP's
    // server-side filter is documented as exact-match, but a query-construction
    // bug (or MP ever switching to prefix/fuzzy matching) could return a
    // payment for order "142" when we searched for order "14". That result must
    // never be chosen — not even as the "most recent attempt of any status".
    const fetchImpl = mockSearch([
      {
        id: 999,
        status: 'approved',
        external_reference: '142',
        transaction_amount: 100,
        date_created: '2026-07-30T11:00:00.000-04:00',
        date_approved: '2026-07-30T11:01:00.000-04:00',
      },
    ]);

    const result = await provider.searchByReference('14', cfg, fetchImpl as unknown as typeof fetch);

    expect(result).toBeNull();
  });

  it('drops the mismatched result but still returns a genuinely matching one', async () => {
    const provider = new MercadoPagoProvider();
    const fetchImpl = mockSearch([
      {
        id: 999,
        status: 'approved',
        external_reference: '142',
        transaction_amount: 100,
        date_created: '2026-07-30T11:00:00.000-04:00',
        date_approved: '2026-07-30T11:01:00.000-04:00',
      },
      {
        id: 888,
        status: 'approved',
        external_reference: '14',
        transaction_amount: 30,
        date_created: '2026-07-30T10:00:00.000-04:00',
        date_approved: '2026-07-30T10:01:00.000-04:00',
      },
    ]);

    const result = await provider.searchByReference('14', cfg, fetchImpl as unknown as typeof fetch);

    // The mismatched entry is the most recent AND approved — it would win every
    // selection rule if it were not dropped first.
    expect(result).toEqual({ providerRef: '888', status: 'PAID', reference: '14', amountCents: 3_000 });
  });

  it('drops a result carrying NO external_reference at all rather than trusting the query', async () => {
    const provider = new MercadoPagoProvider();
    // `external_reference` is optional on MP's own payment type. An entry we
    // cannot verify is not an entry we can bind an order to — and the caller
    // must never be handed one whose `reference` we would have had to invent.
    const fetchImpl = mockSearch([
      { id: 321, status: 'approved', date_created: '2026-07-30T10:00:00.000-04:00', date_approved: null },
    ]);

    const result = await provider.searchByReference('ORD-0007', cfg, fetchImpl as unknown as typeof fetch);

    expect(result).toBeNull();
  });

  it('leaves amountCents undefined for a wrong-typed transaction_amount rather than coercing it', async () => {
    const provider = new MercadoPagoProvider();
    const fetchImpl = mockSearch([
      {
        id: 654,
        status: 'approved',
        external_reference: 'ORD-0008',
        transaction_amount: '250.50', // a string, not a number
        date_created: '2026-07-30T10:00:00.000-04:00',
        date_approved: '2026-07-30T10:01:00.000-04:00',
      },
    ]);

    const result = await provider.searchByReference('ORD-0008', cfg, fetchImpl as unknown as typeof fetch);

    expect(result?.amountCents).toBeUndefined();
    expect(result?.reference).toBe('ORD-0008');
  });

  // --- P3 wave-2 FIX 3: the search path reports the CHOSEN result's own
  // currency too, so the worker's binding check has the same three terms on
  // both lookup paths.
  it("reports the chosen result's own currency_id", async () => {
    const provider = new MercadoPagoProvider();
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          results: [
            {
              id: 991,
              status: 'approved',
              external_reference: 'ORD-CUR',
              transaction_amount: 49900,
              currency_id: 'COP',
              date_created: '2026-01-01T00:00:00.000-05:00',
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const result = await provider.searchByReference('ORD-CUR', cfg, fetchImpl as unknown as typeof fetch);

    expect(result).toMatchObject({ providerRef: '991', status: 'PAID', amountCents: 4990000, currency: 'COP' });
  });

  it('leaves currency undefined on the search path when the result omits currency_id', async () => {
    const provider = new MercadoPagoProvider();
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          results: [
            {
              id: 992,
              status: 'approved',
              external_reference: 'ORD-NOCUR',
              transaction_amount: 49900,
              date_created: '2026-01-01T00:00:00.000-05:00',
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const result = await provider.searchByReference('ORD-NOCUR', cfg, fetchImpl as unknown as typeof fetch);

    expect(result?.currency).toBeUndefined();
  });

});
