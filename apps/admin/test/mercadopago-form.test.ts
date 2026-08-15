import { describe, expect, it } from 'vitest';
import { BLANK_MERCADOPAGO_FORM, buildMercadoPagoCredentialsPayload, type MercadoPagoFormFields } from '../lib/mercadopago-form';

const filled: MercadoPagoFormFields = {
  publicKey: 'TEST-abc123',
  privateKey: 'TEST-secret-token',
  eventsSecret: '',
  sandbox: true,
};

describe('buildMercadoPagoCredentialsPayload', () => {
  it('returns null when sandbox has not been chosen yet (BLANK_MERCADOPAGO_FORM, a fresh unsubmitted form)', () => {
    expect(buildMercadoPagoCredentialsPayload(BLANK_MERCADOPAGO_FORM)).toBeNull();
  });

  it('omits eventsSecret entirely when left blank', () => {
    const payload = buildMercadoPagoCredentialsPayload(filled);
    expect(payload).toEqual({
      publicKey: 'TEST-abc123',
      privateKey: 'TEST-secret-token',
      sandbox: true,
    });
    expect(payload).not.toHaveProperty('eventsSecret');
  });

  it('includes eventsSecret when non-blank', () => {
    const payload = buildMercadoPagoCredentialsPayload({ ...filled, eventsSecret: 'events-secret' });
    expect(payload).toEqual({
      publicKey: 'TEST-abc123',
      privateKey: 'TEST-secret-token',
      sandbox: true,
      eventsSecret: 'events-secret',
    });
  });

  it('treats a whitespace-only eventsSecret the same as blank (omitted, not sent as spaces)', () => {
    const payload = buildMercadoPagoCredentialsPayload({ ...filled, eventsSecret: '   ' });
    expect(payload).not.toHaveProperty('eventsSecret');
  });

  it('includes required fields as-typed, not trimmed', () => {
    const payload = buildMercadoPagoCredentialsPayload({
      ...filled,
      publicKey: ' TEST-abc123 ',
      privateKey: ' TEST-secret-token ',
    });
    expect(payload).toEqual({
      publicKey: ' TEST-abc123 ',
      privateKey: ' TEST-secret-token ',
      sandbox: true,
    });
  });

  it('respects sandbox: false (production) as an explicit, deliberate choice', () => {
    const payload = buildMercadoPagoCredentialsPayload({ ...filled, sandbox: false });
    expect(payload).toEqual({
      publicKey: 'TEST-abc123',
      privateKey: 'TEST-secret-token',
      sandbox: false,
    });
  });
});
