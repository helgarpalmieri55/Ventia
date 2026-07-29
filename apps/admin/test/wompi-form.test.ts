import { describe, expect, it } from 'vitest';
import { BLANK_WOMPI_FORM, buildWompiCredentialsPayload, type WompiFormFields } from '../lib/wompi-form';

const filled: WompiFormFields = {
  publicKey: 'pub_test_abc123',
  privateKey: 'prv_test_secret',
  integritySecret: '',
  eventsSecret: '',
  sandbox: true,
};

describe('buildWompiCredentialsPayload', () => {
  it('returns null when sandbox has not been chosen yet (BLANK_WOMPI_FORM, a fresh unsubmitted form)', () => {
    expect(buildWompiCredentialsPayload(BLANK_WOMPI_FORM)).toBeNull();
  });

  it('omits integritySecret and eventsSecret entirely when both are left blank', () => {
    const payload = buildWompiCredentialsPayload(filled);
    expect(payload).toEqual({
      publicKey: 'pub_test_abc123',
      privateKey: 'prv_test_secret',
      sandbox: true,
    });
    expect(payload).not.toHaveProperty('integritySecret');
    expect(payload).not.toHaveProperty('eventsSecret');
  });

  it('includes integritySecret when non-blank', () => {
    const payload = buildWompiCredentialsPayload({ ...filled, integritySecret: 'int-secret' });
    expect(payload).toEqual({
      publicKey: 'pub_test_abc123',
      privateKey: 'prv_test_secret',
      sandbox: true,
      integritySecret: 'int-secret',
    });
  });

  it('includes eventsSecret when non-blank', () => {
    const payload = buildWompiCredentialsPayload({ ...filled, eventsSecret: 'events-secret' });
    expect(payload).toEqual({
      publicKey: 'pub_test_abc123',
      privateKey: 'prv_test_secret',
      sandbox: true,
      eventsSecret: 'events-secret',
    });
  });

  it('includes both secrets when both are non-blank', () => {
    const payload = buildWompiCredentialsPayload({
      ...filled,
      integritySecret: 'int-secret',
      eventsSecret: 'events-secret',
    });
    expect(payload).toEqual({
      publicKey: 'pub_test_abc123',
      privateKey: 'prv_test_secret',
      sandbox: true,
      integritySecret: 'int-secret',
      eventsSecret: 'events-secret',
    });
  });

  it('treats a whitespace-only secret the same as blank (omitted, not sent as spaces)', () => {
    const payload = buildWompiCredentialsPayload({ ...filled, integritySecret: '   ', eventsSecret: '  ' });
    expect(payload).not.toHaveProperty('integritySecret');
    expect(payload).not.toHaveProperty('eventsSecret');
  });

  it('respects sandbox: false (production) as an explicit, deliberate choice', () => {
    const payload = buildWompiCredentialsPayload({ ...filled, sandbox: false });
    expect(payload).toEqual({
      publicKey: 'pub_test_abc123',
      privateKey: 'prv_test_secret',
      sandbox: false,
    });
  });
});
