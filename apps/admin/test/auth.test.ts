import { describe, expect, it } from 'vitest';
import { fieldForAuthCode } from '../lib/auth';

describe('fieldForAuthCode', () => {
  it('maps INVALID_EMAIL to email field', () => {
    expect(fieldForAuthCode('INVALID_EMAIL')).toBe('email');
  });

  it('maps USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL to email field', () => {
    expect(fieldForAuthCode('USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL')).toBe('email');
  });

  it('maps PASSWORD_TOO_SHORT to password field', () => {
    expect(fieldForAuthCode('PASSWORD_TOO_SHORT')).toBe('password');
  });

  it('maps PASSWORD_TOO_LONG to password field', () => {
    expect(fieldForAuthCode('PASSWORD_TOO_LONG')).toBe('password');
  });

  it('returns null for ambiguous INVALID_EMAIL_OR_PASSWORD', () => {
    expect(fieldForAuthCode('INVALID_EMAIL_OR_PASSWORD')).toBeNull();
  });

  it('returns null for unmapped codes', () => {
    expect(fieldForAuthCode('NETWORK')).toBeNull();
    expect(fieldForAuthCode('AUTH_ERROR')).toBeNull();
    expect(fieldForAuthCode('UNKNOWN_CODE')).toBeNull();
  });

  it('returns null when code is undefined', () => {
    expect(fieldForAuthCode(undefined)).toBeNull();
  });
});
