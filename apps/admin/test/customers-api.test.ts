import { describe, expect, it } from 'vitest';
import {
  CONFIRM_WORD,
  REQUEST_CHANNELS,
  REQUEST_CHANNEL_LABELS,
  anonymizeSummary,
  customerLabel,
  type AnonymizeResponse,
  type Customer,
} from '../lib/customers-api';

function customer(overrides: Partial<Customer> = {}): Customer {
  return {
    id: 'c1',
    name: null,
    email: null,
    phone: null,
    ordersCount: 0,
    totalSpentCents: 0,
    anonymized: false,
    ...overrides,
  };
}

function response(counts: Partial<AnonymizeResponse['counts']>, alreadyAnonymized = false): AnonymizeResponse {
  return {
    customerId: 'c1',
    alreadyAnonymized,
    counts: {
      customer: 0,
      orders: 0,
      orderEvents: 0,
      conversations: 0,
      messages: 0,
      notifications: 0,
      auditLogs: 0,
      webhookEvents: 0,
      ...counts,
    },
  };
}

describe('customerLabel', () => {
  it('prefers the name, then the email, then the phone', () => {
    expect(customerLabel(customer({ name: 'Ana Gómez', email: 'a@b.co', phone: '3001112233' }))).toBe('Ana Gómez');
    expect(customerLabel(customer({ email: 'a@b.co', phone: '3001112233' }))).toBe('a@b.co');
    expect(customerLabel(customer({ phone: '3001112233' }))).toBe('3001112233');
  });

  it('falls back to es-CO copy rather than rendering an empty cell', () => {
    expect(customerLabel(customer())).toBe('Cliente sin datos');
    expect(customerLabel(customer({ name: '   ' }))).toBe('Cliente sin datos');
  });
});

describe('anonymizeSummary', () => {
  it('says nothing was left to erase when the run was a no-op', () => {
    expect(anonymizeSummary(response({}, true))).toContain('ya estaba anonimizado');
  });

  it('lists only the tables that actually changed, with es-CO plurals', () => {
    const text = anonymizeSummary(response({ customer: 1, orders: 1, messages: 4 }));
    expect(text).toContain('1 pedido');
    expect(text).not.toContain('1 pedidos');
    expect(text).toContain('4 mensajes');
    expect(text).not.toContain('conversaci');
    expect(text).not.toContain('0 ');
  });

  it('always promises that the money survived — the whole point of SPEC §9', () => {
    expect(anonymizeSummary(response({ orders: 2 }))).toContain('montos');
  });
});

describe('request channels', () => {
  it('is a closed list with a label for every value (no free text can reach the audit row)', () => {
    for (const channel of REQUEST_CHANNELS) {
      expect(REQUEST_CHANNEL_LABELS[channel]).toBeTruthy();
    }
    expect(Object.keys(REQUEST_CHANNEL_LABELS).sort()).toEqual([...REQUEST_CHANNELS].sort());
  });

  it('uses the same confirmation literal the API requires', () => {
    expect(CONFIRM_WORD).toBe('ANONIMIZAR');
  });
});
