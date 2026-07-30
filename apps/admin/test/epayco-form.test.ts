import { describe, expect, it } from 'vitest';
import { BLANK_EPAYCO_FORM, buildEpaycoCredentialsPayload, type EpaycoFormFields } from '../lib/epayco-form';

const filled: EpaycoFormFields = {
  publicKey: 'epayco-public-abc123',
  privateKey: 'epayco-private-secret',
  eventsSecret: '',
  epaycoCustomerId: '',
  sandbox: true,
};

describe('buildEpaycoCredentialsPayload', () => {
  it('returns null when sandbox has not been chosen yet (BLANK_EPAYCO_FORM, a fresh unsubmitted form)', () => {
    expect(buildEpaycoCredentialsPayload(BLANK_EPAYCO_FORM)).toBeNull();
  });

  it('omits eventsSecret (P_KEY) and epaycoCustomerId (P_CUST_ID_CLIENTE) entirely when both are left blank', () => {
    const payload = buildEpaycoCredentialsPayload(filled);
    expect(payload).toEqual({
      publicKey: 'epayco-public-abc123',
      privateKey: 'epayco-private-secret',
      sandbox: true,
    });
    expect(payload).not.toHaveProperty('eventsSecret');
    expect(payload).not.toHaveProperty('epaycoCustomerId');
  });

  it('includes eventsSecret (P_KEY) when non-blank', () => {
    const payload = buildEpaycoCredentialsPayload({ ...filled, eventsSecret: 'p-key-value' });
    expect(payload).toEqual({
      publicKey: 'epayco-public-abc123',
      privateKey: 'epayco-private-secret',
      sandbox: true,
      eventsSecret: 'p-key-value',
    });
  });

  it('includes epaycoCustomerId (P_CUST_ID_CLIENTE) when non-blank', () => {
    const payload = buildEpaycoCredentialsPayload({ ...filled, epaycoCustomerId: 'cust-id-value' });
    expect(payload).toEqual({
      publicKey: 'epayco-public-abc123',
      privateKey: 'epayco-private-secret',
      sandbox: true,
      epaycoCustomerId: 'cust-id-value',
    });
  });

  it('includes both confirmation-signature fields when both are non-blank', () => {
    const payload = buildEpaycoCredentialsPayload({
      ...filled,
      eventsSecret: 'p-key-value',
      epaycoCustomerId: 'cust-id-value',
    });
    expect(payload).toEqual({
      publicKey: 'epayco-public-abc123',
      privateKey: 'epayco-private-secret',
      sandbox: true,
      eventsSecret: 'p-key-value',
      epaycoCustomerId: 'cust-id-value',
    });
  });

  it('treats whitespace-only secrets the same as blank (omitted, not sent as spaces)', () => {
    const payload = buildEpaycoCredentialsPayload({ ...filled, eventsSecret: '   ', epaycoCustomerId: '  ' });
    expect(payload).not.toHaveProperty('eventsSecret');
    expect(payload).not.toHaveProperty('epaycoCustomerId');
  });

  it('includes required fields as-typed, not trimmed', () => {
    const payload = buildEpaycoCredentialsPayload({
      ...filled,
      publicKey: ' epayco-public-abc123 ',
      privateKey: ' epayco-private-secret ',
    });
    expect(payload).toEqual({
      publicKey: ' epayco-public-abc123 ',
      privateKey: ' epayco-private-secret ',
      sandbox: true,
    });
  });

  it('respects sandbox: false (production) as an explicit, deliberate choice', () => {
    const payload = buildEpaycoCredentialsPayload({ ...filled, sandbox: false });
    expect(payload).toEqual({
      publicKey: 'epayco-public-abc123',
      privateKey: 'epayco-private-secret',
      sandbox: false,
    });
  });
});
