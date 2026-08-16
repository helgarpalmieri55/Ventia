import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { EpaycoProvider } from '../src/epayco';
import type { NormalizedStatus, OrderForPayment, RawRequest, TenantProviderConfig } from '../src/index';

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

const cfg: TenantProviderConfig = {
  publicKey: 'pub_test_abc123',
  privateKey: 'priv_test_abc123',
  sandbox: true,
  eventsSecret: 'test_P_KEY_secret',
  epaycoCustomerId: '1234567',
};

const order: OrderForPayment = {
  orderId: 'ord_1',
  orderNumber: 'ORD-0001',
  totalCents: 4990000,
  customerEmail: 'shopper@example.com',
  // Per-tenant, and REQUIRED (multi-tenancy fix) — this replaced the single
  // global `PAYMENTS_STOREFRONT_BASE_URL` env var the block below used to
  // set/unset.
  storefrontBaseUrl: 'https://tienda.example.com',
};

describe('EpaycoProvider.createCheckoutSession', () => {
  it('calls login then session/create in order, with Basic auth then Bearer JWT, and returns the storefront bridge-page redirectUrl', async () => {
    const provider = new EpaycoProvider();
    const fetchImpl = vi.fn();
    // First call: /login
    fetchImpl.mockImplementationOnce(async () =>
      new Response(JSON.stringify({ token: 'jwt-token-abc' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    // Second call: /payment/session/create
    fetchImpl.mockImplementationOnce(async () =>
      new Response(
        JSON.stringify({
          success: true,
          data: { sessionId: 'session-xyz-789', token: 'session-jwt' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const { redirectUrl } = await provider.createCheckoutSession(order, cfg, fetchImpl as unknown as typeof fetch);

    expect(fetchImpl).toHaveBeenCalledTimes(2);

    // Call 1: login
    const [loginUrl, loginInit] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(loginUrl).toBe('https://apify.epayco.co/login');
    expect(loginInit.method).toBe('POST');
    const expectedBasic = Buffer.from(`${cfg.publicKey}:${cfg.privateKey}`, 'utf8').toString('base64');
    expect((loginInit.headers as Record<string, string>).Authorization).toBe(`Basic ${expectedBasic}`);

    // Call 2: session/create, using the JWT extracted from call 1's response
    const [sessionUrl, sessionInit] = fetchImpl.mock.calls[1] as [string, RequestInit];
    expect(sessionUrl).toBe('https://apify.epayco.co/payment/session/create');
    expect(sessionInit.method).toBe('POST');
    expect((sessionInit.headers as Record<string, string>).Authorization).toBe('Bearer jwt-token-abc');
    const sessionBody = JSON.parse(sessionInit.body as string);
    expect(sessionBody.checkout_version).toBe('2');
    expect(sessionBody.currency).toBe('COP');
    // 4,990,000 cents -> 49,900 pesos (major-unit decimal, NOT cents) —
    // independently re-verified for ePayco, not assumed from Mercado Pago.
    expect(sessionBody.amount).toBe(49900);
    // extras.extra1 is the SAME slot verifyAndParseWebhook reads back as
    // x_extra1 — this is the sending side of that contract.
    expect(sessionBody.extras.extra1).toBe('ORD-0001');
    // `response` — the shopper's browser return URL, now populated per tenant.
    // Verified against ePayco's own docs (checkout-implementacion's verbatim
    // session-create example carries `"response": "https://mysite.com"`;
    // paginas-de-respuestas states the shopper returns with `ref_payco` in the
    // URL parameters) and against ePayco's own sample repo (`onePage/response/
    // response.html` reads `getQueryParam('ref_payco')`).
    expect(sessionBody.response).toBe('https://tienda.example.com/pago/epayco-retorno/ORD-0001');
    // `method` is deliberately NOT sent: ePayco documents it as `GET | POST`
    // with no stated default and no statement of which URL it governs, and the
    // analogous legacy `method_confirmation` selects the CONFIRMATION
    // webhook's method — i.e. the verified settle path. Guessing there could
    // silently kill webhook delivery.
    expect(sessionBody.method).toBeUndefined();
    // `confirmation` likewise stays out of this body: it is the signature-
    // verified settle path's URL, configured out-of-band in ePayco's dashboard
    // panel today. Changing it is a separate change with its own verification.
    expect(sessionBody.confirmation).toBeUndefined();

    // THIRD-PARTY vs FIRST-PARTY redirect distinction — the one adapter
    // where this matters: redirectUrl must be OUR OWN storefront's
    // /pago/epayco bridge page, NOT an epayco.co URL.
    const url = new URL(redirectUrl);
    expect(url.hostname).not.toMatch(/epayco/);
    expect(url.pathname).toBe('/pago/epayco');
    expect(url.searchParams.get('session')).toBe('session-xyz-789');
    expect(url.searchParams.get('sandbox')).toBe('true');
    // Task 6 addition: the bridge page has no other way to learn the order
    // number (neither configure()'s widget config nor ePayco's hooks carry
    // it back), so it must ride along in this redirect's query string too.
    expect(url.searchParams.get('orderNumber')).toBe('ORD-0001');
  });

  // --- Per-tenant storefront base URL (multi-tenancy fix). This replaces the
  // former `PAYMENTS_STOREFRONT_BASE_URL` env-var regression block: that env
  // var is gone, and with it the single-global-base behavior it pinned.
  //
  // ePayco's redirect is already live/shipped, so these still pin the produced
  // URLs BYTE-FOR-BYTE (not just "hostname isn't epayco.co"), so any drift in
  // the bridge-page URL or the new `response` URL fails loudly here.
  describe('per-tenant storefront base URL', () => {
    async function buildSession(
      overrides: Partial<OrderForPayment> = {},
    ): Promise<{ redirectUrl: string; body: Record<string, unknown> }> {
      const provider = new EpaycoProvider();
      const fetchImpl = vi.fn();
      fetchImpl.mockImplementationOnce(async () => new Response(JSON.stringify({ token: 'jwt' }), { status: 200 }));
      fetchImpl.mockImplementationOnce(async () =>
        new Response(JSON.stringify({ data: { sessionId: 'sess-1' } }), { status: 200 }),
      );
      const { redirectUrl } = await provider.createCheckoutSession(
        { ...order, ...overrides },
        cfg,
        fetchImpl as unknown as typeof fetch,
      );
      const [, sessionInit] = fetchImpl.mock.calls[1] as [string, RequestInit];
      return { redirectUrl, body: JSON.parse(sessionInit.body as string) as Record<string, unknown> };
    }

    it('builds both the bridge-page redirect and the `response` URL on the order-supplied base', async () => {
      const { redirectUrl, body } = await buildSession();
      expect(redirectUrl).toBe(
        'https://tienda.example.com/pago/epayco?session=sess-1&sandbox=true&orderNumber=ORD-0001',
      );
      expect(body.response).toBe('https://tienda.example.com/pago/epayco-retorno/ORD-0001');
    });

    // ==== THE multi-tenancy regression test (ePayco half). ====
    //
    // See `wompi.test.ts`'s twin for the full reasoning. The previous
    // implementation read ONE global env var, so both tenants below got a
    // byte-identical base and every ePayco shopper was redirected to whichever
    // single storefront that variable named. Both URLs ePayco receives — the
    // bridge page the browser is sent to, and the `response` page it is
    // returned to afterwards — must differ per tenant.
    it('gives two different tenants two DIFFERENT bridge-page AND response URLs', async () => {
      const a = await buildSession({ storefrontBaseUrl: 'https://tienda-a.example.com' });
      const b = await buildSession({ storefrontBaseUrl: 'https://tienda-b.example.com' });

      expect(a.redirectUrl).toBe(
        'https://tienda-a.example.com/pago/epayco?session=sess-1&sandbox=true&orderNumber=ORD-0001',
      );
      expect(b.redirectUrl).toBe(
        'https://tienda-b.example.com/pago/epayco?session=sess-1&sandbox=true&orderNumber=ORD-0001',
      );
      expect(a.redirectUrl).not.toBe(b.redirectUrl);
      expect(new URL(a.redirectUrl).host).not.toBe(new URL(b.redirectUrl).host);

      expect(a.body.response).toBe('https://tienda-a.example.com/pago/epayco-retorno/ORD-0001');
      expect(b.body.response).toBe('https://tienda-b.example.com/pago/epayco-retorno/ORD-0001');
      expect(a.body.response).not.toBe(b.body.response);
    });

    it('carries the order number in the response URL PATH, with no query string of its own', async () => {
      const { body } = await buildSession();
      const response = body.response as string;
      // ePayco appends `?ref_payco=...` to whatever URL it was given (its own
      // `onePage/response/response.html` sample reads that query param), and
      // no ePayco doc promises correct behavior when a query string is already
      // present — same reasoning as `wompi.ts`'s `?id=` append.
      expect(response).not.toContain('?');
      expect(response).not.toContain('&');

      const returned = new URL(`${response}?ref_payco=123456789`);
      expect(returned.pathname.split('/').pop()).toBe('ORD-0001');
      expect(returned.searchParams.get('ref_payco')).toBe('123456789');
      expect([...returned.searchParams.keys()]).toEqual(['ref_payco']);
    });

    it('percent-encodes a URL-significant order number into the response path segment', async () => {
      const { body } = await buildSession({ orderNumber: 'a/b?c' });
      expect(body.response).toBe('https://tienda.example.com/pago/epayco-retorno/a%2Fb%3Fc');
    });

    it('throws BEFORE any network call when storefrontBaseUrl is missing, rather than falling back to a global default', async () => {
      const provider = new EpaycoProvider();
      const fetchImpl = vi.fn();
      await expect(
        provider.createCheckoutSession(
          { ...order, storefrontBaseUrl: '' } as OrderForPayment,
          cfg,
          fetchImpl as unknown as typeof fetch,
        ),
      ).rejects.toThrow(/storefrontBaseUrl is required/);
      // A real ePayco session the shopper could never return from must never
      // be created in the first place.
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  it('uses the sandbox_init_point-equivalent sandbox flag verbatim (false) when cfg.sandbox is false', async () => {
    const provider = new EpaycoProvider();
    const fetchImpl = vi.fn();
    fetchImpl.mockImplementationOnce(async () => new Response(JSON.stringify({ token: 'jwt' }), { status: 200 }));
    fetchImpl.mockImplementationOnce(async () =>
      new Response(JSON.stringify({ data: { sessionId: 'sess-1' } }), { status: 200 }),
    );

    const { redirectUrl } = await provider.createCheckoutSession(
      order,
      { ...cfg, sandbox: false },
      fetchImpl as unknown as typeof fetch,
    );
    const url = new URL(redirectUrl);
    expect(url.searchParams.get('sandbox')).toBe('false');
  });

  it('throws on a non-2xx login response, and never attempts the session/create call', async () => {
    const provider = new EpaycoProvider();
    const fetchImpl = vi.fn(async () => new Response('unauthorized', { status: 401 }));
    await expect(
      provider.createCheckoutSession(order, cfg, fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow(/login HTTP 401/);
    // Explicit, not just inferred from the error message: a failed login must
    // never let a second call through with a garbage/undefined JWT.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('throws if the login response is missing token', async () => {
    const provider = new EpaycoProvider();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }));
    await expect(
      provider.createCheckoutSession(order, cfg, fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow(/missing token/);
  });

  it('throws on a non-2xx session/create response', async () => {
    const provider = new EpaycoProvider();
    const fetchImpl = vi.fn();
    fetchImpl.mockImplementationOnce(async () => new Response(JSON.stringify({ token: 'jwt' }), { status: 200 }));
    fetchImpl.mockImplementationOnce(async () => new Response('bad request', { status: 400 }));
    await expect(
      provider.createCheckoutSession(order, cfg, fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow(/session\/create HTTP 400/);
  });

  it('throws if the session/create response is missing data.sessionId', async () => {
    const provider = new EpaycoProvider();
    const fetchImpl = vi.fn();
    fetchImpl.mockImplementationOnce(async () => new Response(JSON.stringify({ token: 'jwt' }), { status: 200 }));
    fetchImpl.mockImplementationOnce(async () => new Response(JSON.stringify({ data: {} }), { status: 200 }));
    await expect(
      provider.createCheckoutSession(order, cfg, fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow(/missing data\.sessionId/);
  });
});

/** Builds a valid, form-urlencoded ePayco confirmation request with a
 * correctly-computed x_signature — the SHA-256 is recomputed fresh here
 * (independently of epayco.ts's implementation), same rigor as
 * wompi.test.ts's own integrity-signature test. */
function buildSignedWebhookRequest(opts: {
  xRefPayco: string;
  xTransactionId: string;
  xAmount: string;
  xCurrencyCode: string;
  xResponse: string;
  xExtra1: string;
  epaycoCustomerId: string;
  eventsSecret: string;
  encoding?: 'form' | 'json';
}): RawRequest {
  const signature = sha256Hex(
    `${opts.epaycoCustomerId}^${opts.eventsSecret}^${opts.xRefPayco}^${opts.xTransactionId}^${opts.xAmount}^${opts.xCurrencyCode}`,
  );
  const fields: Record<string, string> = {
    x_ref_payco: opts.xRefPayco,
    x_transaction_id: opts.xTransactionId,
    x_amount: opts.xAmount,
    x_currency_code: opts.xCurrencyCode,
    x_response: opts.xResponse,
    x_extra1: opts.xExtra1,
    x_signature: signature,
  };
  const rawBody =
    opts.encoding === 'json'
      ? Buffer.from(JSON.stringify(fields), 'utf8')
      : Buffer.from(new URLSearchParams(fields).toString(), 'utf8');
  return { headers: {}, rawBody };
}

/** Stubs ePayco's own transaction lookup (`GET
 * /validation/v1/reference/{x_ref_payco}`), which `verifyAndParseWebhook` now
 * ALWAYS calls after the signature check — see the "unsigned-field
 * re-verification (fix 1)" describe block below for why. Defaults agree with
 * `buildSignedWebhookRequest`'s own defaults so the happy paths stay happy. */
function mockReferenceLookup(overrides: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = {
    x_response: 'Aceptada',
    x_extra1: 'ORD-0001',
    x_amount: 49900,
    ...overrides,
  };
  return vi.fn(async () => new Response(JSON.stringify({ data }), { status: 200 }));
}

/** A fetch stub that fails the test if it is ever called — used by the cases
 * that must be rejected BEFORE any network call is made (bad signature,
 * missing fields, missing credentials). */
function neverCalledFetch() {
  return vi.fn(async () => {
    throw new Error('fetch must not be called on this path');
  });
}

describe('EpaycoProvider.verifyAndParseWebhook', () => {
  it('accepts a validly-signed, form-urlencoded confirmation and normalizes it', async () => {
    const provider = new EpaycoProvider();
    const req = buildSignedWebhookRequest({
      xRefPayco: 'ref-123',
      xTransactionId: 'txn-456',
      xAmount: '49900.00',
      xCurrencyCode: 'COP',
      xResponse: 'Aceptada',
      xExtra1: 'ORD-0001',
      epaycoCustomerId: cfg.epaycoCustomerId!,
      eventsSecret: cfg.eventsSecret!,
    });

    const result = await provider.verifyAndParseWebhook(
      req,
      cfg,
      mockReferenceLookup() as unknown as typeof fetch,
    );

    expect(result).toEqual({
      provider: 'epayco',
      // P3 wave-1 fix 1: the resolved status is part of the event id now —
      // same reasoning as mercadopago.ts's fix-3 composition, since the
      // status this adapter reports comes from the gateway lookup and CAN
      // legitimately change between two confirmations for one transaction.
      eventId: 'ref-123:txn-456:PAID',
      providerRef: 'ref-123',
      reference: 'ORD-0001',
      status: 'PAID',
      amountCents: 4990000,
      // The SIGNED `x_currency_code`, added when the currency term reached the
      // webhook path — see the "CURRENCY term" describe block below.
      currency: 'COP',
    });
  });

  it('also accepts a JSON-encoded confirmation body (defensive fallback)', async () => {
    const provider = new EpaycoProvider();
    const req = buildSignedWebhookRequest({
      xRefPayco: 'ref-1',
      xTransactionId: 'txn-1',
      xAmount: '100',
      xCurrencyCode: 'COP',
      xResponse: 'Aceptada',
      xExtra1: 'ORD-0002',
      epaycoCustomerId: cfg.epaycoCustomerId!,
      eventsSecret: cfg.eventsSecret!,
      encoding: 'json',
    });

    const result = await provider.verifyAndParseWebhook(
      req,
      cfg,
      mockReferenceLookup({ x_extra1: 'ORD-0002', x_amount: 100 }) as unknown as typeof fetch,
    );
    expect(result.status).toBe('PAID');
    expect(result.reference).toBe('ORD-0002');
  });

  it('rejects a payload whose x_signature was tampered with', async () => {
    const provider = new EpaycoProvider();
    const req = buildSignedWebhookRequest({
      xRefPayco: 'ref-123',
      xTransactionId: 'txn-456',
      xAmount: '49900.00',
      xCurrencyCode: 'COP',
      xResponse: 'Aceptada',
      xExtra1: 'ORD-0001',
      epaycoCustomerId: cfg.epaycoCustomerId!,
      eventsSecret: cfg.eventsSecret!,
    });
    const params = new URLSearchParams(req.rawBody.toString('utf8'));
    const original = params.get('x_signature')!;
    const tampered = original.slice(0, -1) + (original.endsWith('0') ? '1' : '0');
    params.set('x_signature', tampered);
    req.rawBody = Buffer.from(params.toString(), 'utf8');

    const fetchImpl = neverCalledFetch();
    await expect(
      provider.verifyAndParseWebhook(req, cfg, fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow(/signature mismatch/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a x_signature of the WRONG LENGTH without crashing (timingSafeEqual length guard)', async () => {
    const provider = new EpaycoProvider();
    const req = buildSignedWebhookRequest({
      xRefPayco: 'ref-123',
      xTransactionId: 'txn-456',
      xAmount: '49900.00',
      xCurrencyCode: 'COP',
      xResponse: 'Aceptada',
      xExtra1: 'ORD-0001',
      epaycoCustomerId: cfg.epaycoCustomerId!,
      eventsSecret: cfg.eventsSecret!,
    });
    const params = new URLSearchParams(req.rawBody.toString('utf8'));
    const original = params.get('x_signature')!;
    params.set('x_signature', `${original}ff`); // 2 extra hex chars — wrong length
    req.rawBody = Buffer.from(params.toString(), 'utf8');

    const fetchImpl = neverCalledFetch();
    await expect(
      provider.verifyAndParseWebhook(req, cfg, fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow(/signature mismatch/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects when a required field is missing', async () => {
    const provider = new EpaycoProvider();
    const req: RawRequest = {
      headers: {},
      rawBody: Buffer.from(new URLSearchParams({ x_ref_payco: 'ref-1' }).toString(), 'utf8'),
    };
    await expect(
      provider.verifyAndParseWebhook(req, cfg, neverCalledFetch() as unknown as typeof fetch),
    ).rejects.toThrow(/missing one or more required fields/);
  });

  it('throws if eventsSecret is missing from cfg', async () => {
    const provider = new EpaycoProvider();
    const badCfg: TenantProviderConfig = { publicKey: 'pub', privateKey: 'prv', sandbox: true, epaycoCustomerId: '1' };
    const req = buildSignedWebhookRequest({
      xRefPayco: 'ref-1',
      xTransactionId: 'txn-1',
      xAmount: '100',
      xCurrencyCode: 'COP',
      xResponse: 'Aceptada',
      xExtra1: 'ORD-1',
      epaycoCustomerId: '1',
      eventsSecret: 'irrelevant',
    });
    await expect(
      provider.verifyAndParseWebhook(req, badCfg, neverCalledFetch() as unknown as typeof fetch),
    ).rejects.toThrow(/eventsSecret/);
  });

  it('throws if epaycoCustomerId is missing from cfg', async () => {
    const provider = new EpaycoProvider();
    const badCfg: TenantProviderConfig = { publicKey: 'pub', privateKey: 'prv', sandbox: true, eventsSecret: 'secret' };
    const req = buildSignedWebhookRequest({
      xRefPayco: 'ref-1',
      xTransactionId: 'txn-1',
      xAmount: '100',
      xCurrencyCode: 'COP',
      xResponse: 'Aceptada',
      xExtra1: 'ORD-1',
      epaycoCustomerId: 'irrelevant',
      eventsSecret: 'secret',
    });
    await expect(
      provider.verifyAndParseWebhook(req, badCfg, neverCalledFetch() as unknown as typeof fetch),
    ).rejects.toThrow(/epaycoCustomerId/);
  });

  it.each([
    ['Aceptada', 'PAID'],
    ['Pendiente', 'PENDING'],
    ['Rechazada', 'FAILED'],
    ['Fallida', 'FAILED'],
  ] satisfies [string, NormalizedStatus][])('maps x_response %s to NormalizedStatus %s', async (xResponse, expected) => {
    const provider = new EpaycoProvider();
    const req = buildSignedWebhookRequest({
      xRefPayco: 'ref-9',
      xTransactionId: 'txn-9',
      xAmount: '500',
      xCurrencyCode: 'COP',
      xResponse,
      xExtra1: 'ORD-9',
      epaycoCustomerId: cfg.epaycoCustomerId!,
      eventsSecret: cfg.eventsSecret!,
    });
    // The status now comes from the GATEWAY LOOKUP, not from the body's own
    // unsigned x_response — so the lookup is what carries the vocabulary
    // under test here. (The body still has to carry a matching x_response:
    // it is a required field.)
    const result = await provider.verifyAndParseWebhook(
      req,
      cfg,
      mockReferenceLookup({ x_response: xResponse, x_extra1: 'ORD-9', x_amount: 500 }) as unknown as typeof fetch,
    );
    expect(result.status).toBe(expected);
  });
});

/** P3 wave-1 fix 1 (ePayco half) — regression coverage for a CRITICAL defect.
 *
 * ePayco's documented confirmation signature is
 * `SHA256(P_CUST_ID^P_KEY^x_ref_payco^x_transaction_id^x_amount^x_currency_code)`.
 * That 4-tuple covers NEITHER `x_response` (the status) NOR `x_extra1` (which
 * order this is), yet this adapter reads and acts on both. So one genuine,
 * fully-signed confirmation could be replayed verbatim with only those two
 * unsigned fields swapped — pointing a real 100-COP payment at a 999,999-COP
 * order and marking it paid. This is inherent to ePayco's own formula: any
 * correct implementation of it has this property, so the fix cannot live in
 * the hash.
 *
 * The remedy implemented here is to re-fetch the transaction from ePayco's own
 * lookup endpoint, keyed on the SIGNED `x_ref_payco`, and take the status and
 * reference from THAT response, requiring the looked-up reference to match the
 * body's `x_extra1` and the looked-up amount to match the SIGNED `x_amount`.
 *
 * HONEST LIMIT, stated here so no reader over-reads these tests: ePayco's
 * lookup endpoint is unauthenticated and ignores the caller's credentials
 * entirely (any reference resolves globally), so this re-verification binds
 * STATUS and REFERENCE to the signed transaction — it does NOT establish that
 * the transaction belongs to THIS merchant. Account-scoping for ePayco remains
 * unsolved. The controller's unconditional order-amount check is the layer
 * that actually stops a mismatched settlement. */
describe('EpaycoProvider.verifyAndParseWebhook — unsigned-field re-verification (fix 1)', () => {
  it('takes the status from the gateway lookup, NOT from the unsigned x_response', async () => {
    const provider = new EpaycoProvider();
    // The attacker (or a stale delivery) claims "Aceptada" in the unsigned
    // field; the gateway's own record says the transaction was rejected.
    const req = buildSignedWebhookRequest({
      xRefPayco: 'ref-777',
      xTransactionId: 'txn-777',
      xAmount: '49900.00',
      xCurrencyCode: 'COP',
      xResponse: 'Aceptada',
      xExtra1: 'ORD-0001',
      epaycoCustomerId: cfg.epaycoCustomerId!,
      eventsSecret: cfg.eventsSecret!,
    });
    const fetchImpl = mockReferenceLookup({ x_response: 'Rechazada' });

    const result = await provider.verifyAndParseWebhook(req, cfg, fetchImpl as unknown as typeof fetch);

    expect(result.status).toBe('FAILED');
    // Looked up BY THE SIGNED x_ref_payco — the only transaction identifier
    // in the payload that the signature actually covers.
    const [url] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://secure.epayco.co/validation/v1/reference/ref-777');
  });

  it('rejects the exact reported exploit: a genuine signed 4-tuple replayed with only x_extra1 swapped', async () => {
    const provider = new EpaycoProvider();
    // Verbatim replay of a REAL, correctly-signed confirmation for order
    // ORD-0001 — the signature still validates, because none of the four
    // signed fields were touched — with the unsigned order pointer swapped to
    // a different, much more expensive order.
    const req = buildSignedWebhookRequest({
      xRefPayco: 'ref-123',
      xTransactionId: 'txn-456',
      xAmount: '100.00',
      xCurrencyCode: 'COP',
      xResponse: 'Aceptada',
      xExtra1: 'ORD-9999-EXPENSIVE',
      epaycoCustomerId: cfg.epaycoCustomerId!,
      eventsSecret: cfg.eventsSecret!,
    });

    await expect(
      provider.verifyAndParseWebhook(
        req,
        cfg,
        // The gateway's own record still says this transaction is for ORD-0001.
        mockReferenceLookup({ x_extra1: 'ORD-0001', x_amount: 100 }) as unknown as typeof fetch,
      ),
    ).rejects.toThrow(/does not match/);
  });

  it('rejects when the lookup carries no reference at all (unverifiable is not verified)', async () => {
    const provider = new EpaycoProvider();
    const req = buildSignedWebhookRequest({
      xRefPayco: 'ref-1',
      xTransactionId: 'txn-1',
      xAmount: '100.00',
      xCurrencyCode: 'COP',
      xResponse: 'Aceptada',
      xExtra1: 'ORD-0001',
      epaycoCustomerId: cfg.epaycoCustomerId!,
      eventsSecret: cfg.eventsSecret!,
    });
    await expect(
      provider.verifyAndParseWebhook(
        req,
        cfg,
        mockReferenceLookup({ x_extra1: undefined }) as unknown as typeof fetch,
      ),
    ).rejects.toThrow(/carries no reference/);
  });

  it("rejects when the lookup's amount contradicts the SIGNED x_amount", async () => {
    const provider = new EpaycoProvider();
    const req = buildSignedWebhookRequest({
      xRefPayco: 'ref-1',
      xTransactionId: 'txn-1',
      xAmount: '100.00',
      xCurrencyCode: 'COP',
      xResponse: 'Aceptada',
      xExtra1: 'ORD-0001',
      epaycoCustomerId: cfg.epaycoCustomerId!,
      eventsSecret: cfg.eventsSecret!,
    });
    await expect(
      provider.verifyAndParseWebhook(
        req,
        cfg,
        mockReferenceLookup({ x_amount: 999999 }) as unknown as typeof fetch,
      ),
    ).rejects.toThrow(/amount/);
  });

  it('fails closed when the lookup itself fails (never falls back to the unsigned fields)', async () => {
    const provider = new EpaycoProvider();
    const req = buildSignedWebhookRequest({
      xRefPayco: 'ref-1',
      xTransactionId: 'txn-1',
      xAmount: '100.00',
      xCurrencyCode: 'COP',
      xResponse: 'Aceptada',
      xExtra1: 'ORD-0001',
      epaycoCustomerId: cfg.epaycoCustomerId!,
      eventsSecret: cfg.eventsSecret!,
    });
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 503 }));
    await expect(
      provider.verifyAndParseWebhook(req, cfg, fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow(/HTTP 503/);
  });

  it('rejects a non-numeric signed x_amount instead of emitting NaN as the amount', async () => {
    const provider = new EpaycoProvider();
    const req = buildSignedWebhookRequest({
      xRefPayco: 'ref-1',
      xTransactionId: 'txn-1',
      xAmount: 'not-a-number',
      xCurrencyCode: 'COP',
      xResponse: 'Aceptada',
      xExtra1: 'ORD-0001',
      epaycoCustomerId: cfg.epaycoCustomerId!,
      eventsSecret: cfg.eventsSecret!,
    });
    await expect(
      provider.verifyAndParseWebhook(req, cfg, neverCalledFetch() as unknown as typeof fetch),
    ).rejects.toThrow(/x_amount/);
  });
});

describe('EpaycoProvider.verifyAndParseWebhook — the CURRENCY term', () => {
  // ePayco is the only one of the three whose webhook currency is
  // CRYPTOGRAPHICALLY SIGNED: `x_currency_code` is the sixth term of ePayco's
  // own confirmation-hash formula. So the reported value is the signed one,
  // not the (unauthenticated) lookup's — and, exactly like the amount, the
  // lookup's own figure must not CONTRADICT it where it reports one.
  it('reports the SIGNED x_currency_code', async () => {
    const provider = new EpaycoProvider();
    const req = buildSignedWebhookRequest({
      xRefPayco: 'ref-usd',
      xTransactionId: 'txn-usd',
      xAmount: '250.00',
      xCurrencyCode: 'USD',
      xResponse: 'Aceptada',
      xExtra1: 'ORD-0001',
      epaycoCustomerId: cfg.epaycoCustomerId!,
      eventsSecret: cfg.eventsSecret!,
    });

    const result = await provider.verifyAndParseWebhook(
      req,
      cfg,
      mockReferenceLookup({ x_amount: 250 }) as unknown as typeof fetch,
    );

    expect(result.currency).toBe('USD');
    expect(result.amountCents).toBe(25_000);
  });

  it("rejects when the lookup's currency contradicts the SIGNED x_currency_code", async () => {
    const provider = new EpaycoProvider();
    const req = buildSignedWebhookRequest({
      xRefPayco: 'ref-1',
      xTransactionId: 'txn-1',
      xAmount: '100.00',
      xCurrencyCode: 'COP',
      xResponse: 'Aceptada',
      xExtra1: 'ORD-0001',
      epaycoCustomerId: cfg.epaycoCustomerId!,
      eventsSecret: cfg.eventsSecret!,
    });

    await expect(
      provider.verifyAndParseWebhook(
        req,
        cfg,
        mockReferenceLookup({ x_amount: 100, x_currency_code: 'USD' }) as unknown as typeof fetch,
      ),
    ).rejects.toThrow(/currency/);
  });

  it("accepts when the lookup's currency AGREES with the signed one", async () => {
    const provider = new EpaycoProvider();
    const req = buildSignedWebhookRequest({
      xRefPayco: 'ref-1',
      xTransactionId: 'txn-1',
      xAmount: '100.00',
      xCurrencyCode: 'COP',
      xResponse: 'Aceptada',
      xExtra1: 'ORD-0001',
      epaycoCustomerId: cfg.epaycoCustomerId!,
      eventsSecret: cfg.eventsSecret!,
    });

    const result = await provider.verifyAndParseWebhook(
      req,
      cfg,
      mockReferenceLookup({ x_amount: 100, x_currency_code: 'COP' }) as unknown as typeof fetch,
    );

    expect(result.currency).toBe('COP');
  });
});

describe('EpaycoProvider.getTransactionStatus', () => {
  it('parses a string x_response field when present (preferred, highest-confidence path)', async () => {
    const provider = new EpaycoProvider();
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ data: { x_response: 'Aceptada' } }), { status: 200 }),
    );
    const result = await provider.getTransactionStatus('ref-1', cfg, fetchImpl as unknown as typeof fetch);
    expect(result.status).toBe('PAID');
    const [url] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://secure.epayco.co/validation/v1/reference/ref-1');
  });

  it.each([
    ['1', 'PAID'],
    ['2', 'FAILED'],
    ['3', 'PENDING'],
    ['4', 'FAILED'],
  ] satisfies [string, NormalizedStatus][])(
    'falls back to numeric x_cod_respuesta %s -> %s when no x_response string is present',
    async (code, expected) => {
      const provider = new EpaycoProvider();
      const fetchImpl = vi.fn(async () =>
        new Response(JSON.stringify({ data: { x_cod_respuesta: Number(code) } }), { status: 200 }),
      );
      const result = await provider.getTransactionStatus('ref-1', cfg, fetchImpl as unknown as typeof fetch);
      expect(result.status).toBe(expected);
    },
  );

  it('also accepts the x_cod_response spelling as a fallback', async () => {
    const provider = new EpaycoProvider();
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ data: { x_cod_response: 1 } }), { status: 200 }),
    );
    const result = await provider.getTransactionStatus('ref-1', cfg, fetchImpl as unknown as typeof fetch);
    expect(result.status).toBe('PAID');
  });

  // --- P3c Task 2 (requirement 1): the ORDER-BINDING fields.
  //
  // `x_extra1` is THIS codebase's reference slot on ePayco (the same field
  // `verifyAndParseWebhook` reads, and the same one `createCheckoutSession`
  // populates as `extras.extra1`). Both it and `x_amount` are typed on
  // ePayco's OWN official sample repo's response model for this exact
  // endpoint — see the adapter's module doc comment for the source and the
  // remaining confidence caveat.
  it('returns x_extra1 as `reference` and x_amount (pesos) as `amountCents` alongside the status', async () => {
    const provider = new EpaycoProvider();
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          success: true,
          data: { x_response: 'Aceptada', x_extra1: '1042', x_amount: 49900, x_currency_code: 'COP' },
        }),
        { status: 200 },
      ),
    );
    const result = await provider.getTransactionStatus('ref-1', cfg, fetchImpl as unknown as typeof fetch);
    // 49,900 pesos -> 4,990,000 cents. Same major-unit convention (and same
    // `* 100` conversion) `verifyAndParseWebhook` already applies to the
    // identically-named `x_amount` field on the confirmation webhook.
    expect(result).toEqual({ status: 'PAID', reference: '1042', amountCents: 4990000, currency: 'COP' });
  });

  it('accepts x_amount delivered as a numeric STRING (ePayco form-encodes the same field on its webhook side)', async () => {
    const provider = new EpaycoProvider();
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({ data: { x_response: 'Aceptada', x_extra1: '7', x_amount: '49900.00' } }),
        { status: 200 },
      ),
    );
    const result = await provider.getTransactionStatus('ref-1', cfg, fetchImpl as unknown as typeof fetch);
    // No `x_currency_code` in this fixture, so `currency` is `undefined` —
    // never defaulted to 'COP'. The reconciliation worker treats that as
    // unverifiable and refuses to settle on the amount (P3 wave-2 FIX 3).
    expect(result).toEqual({ status: 'PAID', reference: '7', amountCents: 4990000, currency: undefined });
  });

  it('leaves reference/amountCents undefined (rather than throwing or fabricating) when the response omits them', async () => {
    const provider = new EpaycoProvider();
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ data: { x_response: 'Aceptada' } }), { status: 200 }),
    );
    const result = await provider.getTransactionStatus('ref-1', cfg, fetchImpl as unknown as typeof fetch);
    expect(result.status).toBe('PAID');
    expect(result.reference).toBeUndefined();
    expect(result.amountCents).toBeUndefined();
  });

  it('leaves amountCents undefined for a non-numeric x_amount rather than emitting NaN', async () => {
    const provider = new EpaycoProvider();
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({ data: { x_response: 'Aceptada', x_extra1: '9', x_amount: 'no-es-un-numero' } }),
        { status: 200 },
      ),
    );
    const result = await provider.getTransactionStatus('ref-1', cfg, fetchImpl as unknown as typeof fetch);
    expect(result.reference).toBe('9');
    expect(result.amountCents).toBeUndefined();
  });

  it('throws on a non-2xx response', async () => {
    const provider = new EpaycoProvider();
    const fetchImpl = vi.fn(async () => new Response('not found', { status: 404 }));
    await expect(
      provider.getTransactionStatus('missing', cfg, fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow(/HTTP 404/);
  });

  it('throws if the response has neither x_response nor a numeric code', async () => {
    const provider = new EpaycoProvider();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: {} }), { status: 200 }));
    await expect(
      provider.getTransactionStatus('ref-1', cfg, fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow(/malformed response/);
  });

  it('throws if the response is missing the `data` key entirely (distinct from an empty `data: {}`)', async () => {
    const provider = new EpaycoProvider();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }));
    await expect(
      provider.getTransactionStatus('ref-1', cfg, fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow(/missing data/);
  });

  // --- P3 wave-2 FIX 3: the CURRENCY term. `x_currency_code` is declared on
  // the same first-party response model this endpoint's other fields were
  // verified against, and is the SIGNED currency field on ePayco's own
  // confirmation webhook.
  it('reports x_currency_code so the caller can require COP', async () => {
    const provider = new EpaycoProvider();
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({ data: { x_response: 'Aceptada', x_extra1: '1042', x_amount: 49900, x_currency_code: 'USD' } }),
        { status: 200 },
      ),
    );
    const result = await provider.getTransactionStatus('ref-1', cfg, fetchImpl as unknown as typeof fetch);
    expect(result.currency).toBe('USD');
  });

  it('reports the currency on the NUMERIC-code fallback path too', async () => {
    const provider = new EpaycoProvider();
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({ data: { x_cod_respuesta: 1, x_extra1: '1042', x_amount: 49900, x_currency_code: 'COP' } }),
        { status: 200 },
      ),
    );
    const result = await provider.getTransactionStatus('ref-1', cfg, fetchImpl as unknown as typeof fetch);
    expect(result).toEqual({ status: 'PAID', reference: '1042', amountCents: 4990000, currency: 'COP' });
  });

});
