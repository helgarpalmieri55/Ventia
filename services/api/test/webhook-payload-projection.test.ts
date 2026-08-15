import { describe, expect, it } from 'vitest';
import { projectWebhookLinks } from '../src/payment-alerts/webhook-links';

describe('projectWebhookLinks — wompi', () => {
  it('reads the merchant reference and the gateway transaction id', () => {
    expect(
      projectWebhookLinks('wompi', {
        data: { transaction: { id: 'wompi-tx-1', reference: '1042', amount_in_cents: 500_000 } },
      }),
    ).toEqual({ orderNumber: 1042, providerRef: 'wompi-tx-1' });
  });

  it('rejects a non-plain-integer reference rather than coercing it', () => {
    // Same `/^\d+$/` rule webhooks.controller.ts applies before it ever
    // resolves an order — " 42 ", "4.2e1", "+42", "0x2a" must not all map
    // onto order 42.
    for (const reference of [' 42 ', '4.2e1', '+42', '0x2a', '42.0', 'VNT-42', '']) {
      expect(projectWebhookLinks('wompi', { data: { transaction: { reference } } }).orderNumber).toBeNull();
    }
  });

  it('rejects an out-of-int4-range reference', () => {
    expect(
      projectWebhookLinks('wompi', { data: { transaction: { reference: '99999999999' } } }).orderNumber,
    ).toBeNull();
  });

  it('returns nulls for a malformed payload instead of throwing', () => {
    for (const payload of [null, undefined, 'a string', 42, [], {}, { data: null }, { data: { transaction: 7 } }]) {
      expect(projectWebhookLinks('wompi', payload)).toEqual({ orderNumber: null, providerRef: null });
    }
  });
});

describe('projectWebhookLinks — epayco', () => {
  it('reads x_extra1 as the reference and x_ref_payco as the gateway ref', () => {
    expect(
      projectWebhookLinks('epayco', {
        x_extra1: '77',
        x_ref_payco: '123456',
        x_amount: '1500.00',
      }),
    ).toEqual({ orderNumber: 77, providerRef: '123456' });
  });

  it('tolerates a missing x_extra1 (ePayco form bodies are not guaranteed)', () => {
    expect(projectWebhookLinks('epayco', { x_ref_payco: '123456' })).toEqual({
      orderNumber: null,
      providerRef: '123456',
    });
  });
});

describe('projectWebhookLinks — mercadopago', () => {
  it('has no reference to read, only the payment id', () => {
    // MP's delivered body is `{type, data:{id}}` and nothing else — the
    // external_reference lives in an authenticated follow-up lookup that is
    // never persisted. Documented, not papered over.
    expect(projectWebhookLinks('mercadopago', { type: 'payment', data: { id: 1234567890 } })).toEqual({
      orderNumber: null,
      providerRef: '1234567890',
    });
  });

  it('accepts a string id too', () => {
    expect(projectWebhookLinks('mercadopago', { data: { id: 'pay-9' } }).providerRef).toBe('pay-9');
  });
});

describe('projectWebhookLinks — unknown provider', () => {
  it('yields nothing rather than guessing at field names', () => {
    expect(projectWebhookLinks('some-future-gateway', { reference: '10', id: 'x' })).toEqual({
      orderNumber: null,
      providerRef: null,
    });
  });
});
