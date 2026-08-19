import { describe, expect, it } from 'vitest';
import {
  DROP_KEYS,
  REDACTED,
  REDACTED_EMAIL,
  REDACTED_ID,
  REDACTED_PHONE,
  REDACTED_SECRET,
  REDACTED_TOKEN,
  scrubEvent,
  scrubEventOrDrop,
  scrubString,
  type TelemetryEvent,
} from '../src/observability/scrub';

/**
 * The PII scrubber that stands between this process and Sentry
 * (docs/SPEC.md §9 "Sentry alerts", Ley 1581).
 *
 * The load-bearing test is `a realistic Colombian checkout crash`: an event
 * shaped the way a real one would be, carrying a shopper's name, phone,
 * address and cédula, a session cookie, an Authorization header, an encrypted
 * provider credential and a gateway webhook payload — asserted class by
 * class, and then asserted again over the WHOLE serialized event, so a leak
 * through a field nobody thought to check still fails.
 */

/** A shopper who does not exist, in the shape of ones who do. */
const SHOPPER = {
  name: 'Ana María Gómez Restrepo',
  email: 'ana.gomez@correo.co',
  phone: '+57 301 234 5678',
  phoneDigits: '3012345678',
  cedula: '1020345678',
  cedulaDotted: '1.020.345.678',
  address: 'Cra 43A #7-50 apto 502',
} as const;

const SESSION_COOKIE =
  'better-auth.session_token=8f3c1d9a4b7e2f60c5a1b8d3e9f4a2c7; ventia_cart=cart_9f2b1a; locale=es-CO';
const BEARER = 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c3JfMTIzIn0.dQw4w9WgXcQabc123';
/** Shaped exactly like `payments/encryption.ts`'s output:
 * base64(12-byte iv):base64(16-byte tag):base64(ciphertext). */
const ENCRYPTED_CREDENTIAL = 'Zm9vYmFyYmF6cXV4:aGVsbG93b3JsZGhlbGxvd28==:c2VjcmV0LXdvbXBpLXByaXZhdGUta2V5';

const TENANT_ID = '7f9c1a2b-4d5e-4f60-9a1b-2c3d4e5f6071';

function checkoutCrashEvent(): TelemetryEvent {
  return {
    message: `checkout failed for ${SHOPPER.email}`,
    request: {
      method: 'POST',
      url: `https://tienda.ventia.co/v1/storefront/checkout?email=${SHOPPER.email}&documento=${SHOPPER.cedula}`,
      query_string: `email=${SHOPPER.email}`,
      cookies: { 'better-auth.session_token': '8f3c1d9a4b7e2f60c5a1b8d3e9f4a2c7' },
      headers: {
        'content-type': 'application/json',
        'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)',
        cookie: SESSION_COOKIE,
        authorization: BEARER,
        'x-forwarded-for': '190.24.11.8',
      },
      data: {
        nombreCompleto: SHOPPER.name,
        telefono: SHOPPER.phone,
        direccion: SHOPPER.address,
        documento: SHOPPER.cedulaDotted,
        email: SHOPPER.email,
      },
      env: { REMOTE_ADDR: '190.24.11.8' },
    },
    user: { id: 'usr_5kQ2', email: 'dueña@tienda.co', username: 'ana', ip_address: '190.24.11.8' },
    tags: { tenant_id: TENANT_ID, customerEmail: SHOPPER.email },
    extra: {
      tenantId: TENANT_ID,
      orderId: 'ord_8812',
      customerName: SHOPPER.name,
      shippingAddress: {
        departamentoName: 'Antioquia',
        municipioName: 'Medellín',
        direccion: SHOPPER.address,
        barrio: 'Laureles',
      },
      credentials: ENCRYPTED_CREDENTIAL,
      webhookPayload: { data: { transaction: { customer_email: SHOPPER.email, phone_number: SHOPPER.phoneDigits } } },
      note: `llamar al ${SHOPPER.phoneDigits} antes de entregar`,
    },
    breadcrumbs: [
      {
        message: `POST /v1/storefront/checkout?email=${SHOPPER.email}`,
        data: { url: `https://tienda.ventia.co/checkout?telefono=${SHOPPER.phoneDigits}`, status_code: 500 },
      },
    ],
    exception: {
      values: [
        {
          type: 'PrismaClientKnownRequestError',
          value: `Unique constraint failed on Customer (email: ${SHOPPER.email}, phone: ${SHOPPER.phone}, cc: ${SHOPPER.cedula})`,
          stacktrace: {
            frames: [
              {
                filename: '/home/user/Ventia/services/api/src/checkout/checkout.service.ts',
                function: 'createOrder',
                lineno: 214,
                vars: { body: { nombreCompleto: SHOPPER.name, telefono: SHOPPER.phone } },
              },
            ],
          },
        },
      ],
    },
  };
}

describe('scrubEvent — a realistic Colombian checkout crash', () => {
  const scrubbed = scrubEvent(checkoutCrashEvent());
  const serialized = JSON.stringify(scrubbed);

  it('leaves no trace of any personal value anywhere in the serialized event', () => {
    // The catch-all. Every assertion below says WHICH rule removed a value;
    // this one says none of them was bypassed by a field nobody listed.
    for (const [label, value] of Object.entries(SHOPPER)) {
      if (label === 'name') continue; // see the documented gap below
      expect(serialized, `${label} survived`).not.toContain(value);
    }
    expect(serialized).not.toContain('8f3c1d9a4b7e2f60c5a1b8d3e9f4a2c7'); // session cookie value
    expect(serialized).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'); // bearer JWT
    expect(serialized).not.toContain('c2VjcmV0LXdvbXBpLXByaXZhdGUta2V5'); // encrypted credential
    expect(serialized).not.toContain('190.24.11.8'); // client IP
  });

  it('drops the request body outright rather than scrubbing it', () => {
    expect(scrubbed.request?.data).toBeUndefined();
    expect(scrubbed.request?.cookies).toBeUndefined();
    expect(scrubbed.request?.env).toBeUndefined();
    expect(scrubbed.request?.query_string).toBeUndefined();
  });

  it('keeps only allowlisted headers — cookie and authorization are gone', () => {
    expect(scrubbed.request?.headers).toEqual({
      'content-type': 'application/json',
      'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)',
    });
  });

  it('keeps the route but not the query string', () => {
    expect(scrubbed.request?.url).toBe(`https://tienda.ventia.co/v1/storefront/checkout?${REDACTED}`);
  });

  it('keeps the opaque user id and nothing else about the human', () => {
    expect(scrubbed.user).toEqual({ id: 'usr_5kQ2', ip_address: null });
  });

  it('keeps the tenant id — the context that makes an alert actionable', () => {
    expect((scrubbed.extra as Record<string, unknown>).tenantId).toBe(TENANT_ID);
    expect((scrubbed.extra as Record<string, unknown>).orderId).toBe('ord_8812');
    expect((scrubbed.tags as Record<string, unknown>).tenant_id).toBe(TENANT_ID);
  });

  it('blanks personal values under known-PII keys, walking structures so geography survives', () => {
    const extra = scrubbed.extra as Record<string, unknown>;
    expect(extra.customerName).toBe(REDACTED);
    expect(extra.shippingAddress).toEqual({
      // Aggregate geography is not personal data — the same line
      // privacy/redact.ts draws for the anonymizer.
      departamentoName: 'Antioquia',
      municipioName: 'Medellín',
      direccion: REDACTED,
      barrio: REDACTED,
    });
    expect((scrubbed.tags as Record<string, unknown>).customerEmail).toBe(REDACTED);
  });

  it('drops encrypted credentials and webhook payloads whole, without walking into them', () => {
    const extra = scrubbed.extra as Record<string, unknown>;
    expect(extra.credentials).toBe(REDACTED);
    expect(extra.webhookPayload).toBe(REDACTED);
  });

  it('scrubs values by shape under innocent keys', () => {
    // `note` is not a PII key. The phone inside it is caught by the value rule.
    expect((scrubbed.extra as Record<string, unknown>).note).toBe(`llamar al ${REDACTED_PHONE} antes de entregar`);
  });

  it('scrubs the exception message, keeps the stack frame, deletes frame locals', () => {
    const value = scrubbed.exception?.values?.[0];
    expect(value?.value).toBe(
      `Unique constraint failed on Customer (email: ${REDACTED_EMAIL}, phone: ${REDACTED_PHONE}, cc: ${REDACTED_ID})`,
    );
    expect(value?.type).toBe('PrismaClientKnownRequestError');
    const frame = value?.stacktrace?.frames?.[0] as Record<string, unknown>;
    // Code identifiers are untouched: a scrubber that mangles file paths and
    // line numbers produces reports nobody can act on.
    expect(frame.filename).toBe('/home/user/Ventia/services/api/src/checkout/checkout.service.ts');
    expect(frame.lineno).toBe(214);
    expect(frame.vars).toBeUndefined();
  });

  it('scrubs breadcrumbs, including the query string of an http crumb', () => {
    const crumb = scrubbed.breadcrumbs?.[0];
    expect(crumb?.message).toBe(`POST /v1/storefront/checkout?email=${REDACTED_EMAIL}`);
    expect((crumb?.data as Record<string, unknown>).url).toBe(`https://tienda.ventia.co/checkout?${REDACTED}`);
    expect((crumb?.data as Record<string, unknown>).status_code).toBe(500);
  });

  it('DOES NOT remove a bare name from free prose — the documented gap', () => {
    // Stated as a test rather than only as a comment, so the claim in
    // docs/security-checklist.md is backed by something that would fail if it
    // silently changed. A name is not a shape; there is no regex for "is a
    // person". What closes the common path is that request bodies are dropped
    // whole and every name-ish KEY is blanked — both asserted above.
    expect(scrubEvent({ message: `no se pudo crear el pedido de ${SHOPPER.name}` }).message).toBe(
      `no se pudo crear el pedido de ${SHOPPER.name}`,
    );
  });
});

describe('scrubString — one class of value at a time', () => {
  it.each([
    ['email', 'escribir a ana.gomez@correo.co hoy', `escribir a ${REDACTED_EMAIL} hoy`],
    ['Colombian mobile, +57 spaced', 'tel +57 301 234 5678 ok', `tel ${REDACTED_PHONE} ok`],
    ['Colombian mobile, bare', 'tel 3012345678 ok', `tel ${REDACTED_PHONE} ok`],
    ['cédula, bare', 'cc 1020345678 ok', `cc ${REDACTED_ID} ok`],
    ['cédula, dotted', 'cc 1.020.345.678 ok', `cc ${REDACTED_ID} ok`],
    ['NIT', 'nit 900123456 ok', `nit ${REDACTED_ID} ok`],
    ['card number', 'pan 4111111111111111 ok', `pan ${REDACTED_ID} ok`],
    [
      'JWT',
      'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghij ok',
      `token ${REDACTED_TOKEN} ok`,
    ],
    ['bearer header', 'Authorization: Bearer sk_live_9aA1bB2cC3dD4eE5', `Authorization: Bearer ${REDACTED_TOKEN}`],
    [
      'session cookie pair',
      'cookie: better-auth.session_token=8f3c1d9a4b7e; other=1',
      `cookie: better-auth.session_token=${REDACTED_TOKEN}; other=1`,
    ],
    [
      'AES-GCM credential from payments/encryption.ts',
      `key=${ENCRYPTED_CREDENTIAL}`,
      `key=${REDACTED_SECRET}`,
    ],
    [
      'hex secret / signature',
      'checksum 3a7bd3e2360a3d29eea436fcfb7e44c735d117c42d1c1835420b6b9942dd4f1b',
      `checksum ${REDACTED_SECRET}`,
    ],
  ])('scrubs %s', (_label, input, expected) => {
    expect(scrubString(input)).toBe(expected);
  });

  it('leaves code identifiers, ids and short numbers alone', () => {
    // The other half of "works": a scrubber that eats everything is useless.
    for (const safe of [
      '/home/user/Ventia/services/api/src/observability/queue-health.service.ts:118:7',
      'order ord_8812 moved PENDING -> CONFIRMED',
      'tenant 7f9c1a2b-4d5e-4f60-9a1b-2c3d4e5f6071 suspended',
      'HTTP 500 in 234 ms',
      'expired 12 reservation(s)',
    ]) {
      expect(scrubString(safe)).toBe(safe);
    }
  });
});

describe('the drop-key list', () => {
  it('covers every credential-ish and raw-body key this codebase actually uses', () => {
    for (const key of ['cookie', 'authorization', 'apiKey', 'private_key', 'credentials', 'payload', 'rawBody']) {
      expect(DROP_KEYS.has(key.toLowerCase().replace(/[\s_-]/g, '')), key).toBe(true);
    }
  });
});

describe('failing closed', () => {
  it('drops an event whose scrubbing throws rather than sending it unscrubbed', () => {
    const hostile: TelemetryEvent = {};
    Object.defineProperty(hostile, 'extra', {
      enumerable: true,
      get() {
        throw new Error('boom');
      },
    });
    expect(scrubEventOrDrop(hostile)).toBeNull();
  });

  it('returns the event when scrubbing succeeds', () => {
    expect(scrubEventOrDrop({ message: 'fine' })?.message).toBe('fine');
  });
});
