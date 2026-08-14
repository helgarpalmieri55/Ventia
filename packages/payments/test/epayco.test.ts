import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

  // --- P3c Task 2 (requirement 3): REGRESSION GUARD for the
  // `EPAYCO_STOREFRONT_BASE_URL` -> `PAYMENTS_STOREFRONT_BASE_URL` rename.
  //
  // ePayco's redirect is already live/shipped, so this rename is the single
  // biggest regression risk in that task. These tests pin the produced URL
  // BYTE-FOR-BYTE (not just "hostname isn't epayco.co"), for the env-var-set
  // case, the unset-default case, and the now-removed old env var — so a
  // half-done rename (e.g. shared module added but ePayco still reading the
  // old var, or the default silently changed) fails loudly here.
  describe('storefront base URL after the PAYMENTS_STOREFRONT_BASE_URL rename', () => {
    const ORIGINAL_NEW = process.env.PAYMENTS_STOREFRONT_BASE_URL;
    const ORIGINAL_OLD = process.env.EPAYCO_STOREFRONT_BASE_URL;
    const restore = (key: string, value: string | undefined) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    afterEach(() => {
      restore('PAYMENTS_STOREFRONT_BASE_URL', ORIGINAL_NEW);
      restore('EPAYCO_STOREFRONT_BASE_URL', ORIGINAL_OLD);
    });

    async function buildRedirect(): Promise<string> {
      const provider = new EpaycoProvider();
      const fetchImpl = vi.fn();
      fetchImpl.mockImplementationOnce(async () => new Response(JSON.stringify({ token: 'jwt' }), { status: 200 }));
      fetchImpl.mockImplementationOnce(async () =>
        new Response(JSON.stringify({ data: { sessionId: 'sess-1' } }), { status: 200 }),
      );
      const { redirectUrl } = await provider.createCheckoutSession(order, cfg, fetchImpl as unknown as typeof fetch);
      return redirectUrl;
    }

    it('produces the byte-identical redirect URL it produced before the rename, when the new env var is set', async () => {
      delete process.env.EPAYCO_STOREFRONT_BASE_URL;
      process.env.PAYMENTS_STOREFRONT_BASE_URL = 'https://tienda.example.com';
      expect(await buildRedirect()).toBe(
        'https://tienda.example.com/pago/epayco?session=sess-1&sandbox=true&orderNumber=ORD-0001',
      );
    });

    it('keeps the SAME http://localhost:3000 dev default when no env var is set at all', async () => {
      delete process.env.EPAYCO_STOREFRONT_BASE_URL;
      delete process.env.PAYMENTS_STOREFRONT_BASE_URL;
      expect(await buildRedirect()).toBe(
        'http://localhost:3000/pago/epayco?session=sess-1&sandbox=true&orderNumber=ORD-0001',
      );
    });

    it('no longer reads the OLD EPAYCO_STOREFRONT_BASE_URL name (proves the rename is complete, not additive)', async () => {
      process.env.EPAYCO_STOREFRONT_BASE_URL = 'https://stale-old-var.example.com';
      delete process.env.PAYMENTS_STOREFRONT_BASE_URL;
      const redirectUrl = await buildRedirect();
      expect(redirectUrl).not.toContain('stale-old-var.example.com');
      expect(redirectUrl).toBe(
        'http://localhost:3000/pago/epayco?session=sess-1&sandbox=true&orderNumber=ORD-0001',
      );
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

    const result = await provider.verifyAndParseWebhook(req, cfg);

    expect(result).toEqual({
      provider: 'epayco',
      eventId: 'ref-123:txn-456',
      providerRef: 'ref-123',
      reference: 'ORD-0001',
      status: 'PAID',
      amountCents: 4990000,
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

    const result = await provider.verifyAndParseWebhook(req, cfg);
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

    await expect(provider.verifyAndParseWebhook(req, cfg)).rejects.toThrow(/signature mismatch/);
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

    await expect(provider.verifyAndParseWebhook(req, cfg)).rejects.toThrow(/signature mismatch/);
  });

  it('rejects when a required field is missing', async () => {
    const provider = new EpaycoProvider();
    const req: RawRequest = {
      headers: {},
      rawBody: Buffer.from(new URLSearchParams({ x_ref_payco: 'ref-1' }).toString(), 'utf8'),
    };
    await expect(provider.verifyAndParseWebhook(req, cfg)).rejects.toThrow(/missing one or more required fields/);
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
    await expect(provider.verifyAndParseWebhook(req, badCfg)).rejects.toThrow(/eventsSecret/);
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
    await expect(provider.verifyAndParseWebhook(req, badCfg)).rejects.toThrow(/epaycoCustomerId/);
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
    const result = await provider.verifyAndParseWebhook(req, cfg);
    expect(result.status).toBe(expected);
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
    expect(result).toEqual({ status: 'PAID', reference: '1042', amountCents: 4990000 });
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
    expect(result).toEqual({ status: 'PAID', reference: '7', amountCents: 4990000 });
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
});
