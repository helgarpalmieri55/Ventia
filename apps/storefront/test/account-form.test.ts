import { describe, expect, it } from 'vitest';
import { SHOPPER_PASSWORD_MAX, SHOPPER_PASSWORD_MIN } from '@ventia/core';
import { AccountApiError } from '../lib/account-api';
import {
  ACCOUNT_NOTICES,
  GENERIC_ERROR,
  LINK_INVALID,
  SIGN_IN_FAILED,
  isEmailLike,
  linkErrorMessage,
  normalizeEmail,
  signInErrorMessage,
  tokenFromSearchParams,
  validateEmailOnlyForm,
  validateNewPasswordForm,
  validateRegisterForm,
  validateSignInForm,
} from '../lib/account-form';

describe('the copy never says whether an address has an account', () => {
  // This is the test the whole feature is shaped around. The API answers 202
  // to register, magic-link and password-reset regardless of whether the
  // address exists, so that the ONLY statement of "this address shops here"
  // is an email its owner alone can read. A single sentence in the UI can
  // give that back — to an address-enumerating attacker, not to a shopper,
  // who already knows.
  const FORBIDDEN = [
    /ya existe/i,
    /ya tienes una cuenta/i,
    /ya está registrad/i,
    /no encontramos/i,
    /no existe/i,
    /no está registrad/i,
    /no hay (ninguna )?cuenta/i,
    /correo incorrecto/i,
    /contraseña incorrecta/i,
    /usuario no/i,
  ];

  it.each(ACCOUNT_NOTICES)('%s', (notice) => {
    for (const pattern of FORBIDDEN) {
      expect(notice).not.toMatch(pattern);
    }
  });

  it('phrases the link notices conditionally, so they are true either way', () => {
    // "Si el correo está registrado, te enviamos un enlace" is honest whether
    // or not anything was sent, and it quietly explains the silence to a
    // shopper who mistyped their own address.
    const linkNotices = ACCOUNT_NOTICES.filter((n) => n.includes('enlace') && n.startsWith('Si '));
    expect(linkNotices.length).toBeGreaterThanOrEqual(2);
  });

  it('blames neither field in the sign-in failure message', () => {
    // One message for a wrong password AND for an address with no account —
    // the API returns one code for both, and naming a field here would undo
    // that.
    expect(SIGN_IN_FAILED).toContain('correo');
    expect(SIGN_IN_FAILED).toContain('contraseña');
    expect(SIGN_IN_FAILED).toMatch(/ o /);
  });
});

describe('normalizeEmail', () => {
  it('trims and lowercases, matching the API schema', () => {
    expect(normalizeEmail('  Ana@Example.COM ')).toBe('ana@example.com');
  });
});

describe('isEmailLike', () => {
  it.each(['ana@example.com', 'ana.maria+tienda@correo.com.co', ' ANA@EXAMPLE.COM '])(
    'accepts %s',
    (value) => expect(isEmailLike(value)).toBe(true),
  );

  it.each(['', 'ana', 'ana@', '@example.com', 'ana@example', 'ana @example.com', 'a@b@c.com'])(
    'rejects %s',
    (value) => expect(isEmailLike(value)).toBe(false),
  );
});

describe('validateSignInForm', () => {
  it('accepts a filled form', () => {
    expect(validateSignInForm({ email: 'ana@example.com', password: 'x' })).toEqual({});
  });

  it('flags a missing address and a missing password', () => {
    const errors = validateSignInForm({ email: '', password: '' });
    expect(errors.email).toBeTruthy();
    expect(errors.password).toBeTruthy();
  });

  it('flags a malformed address', () => {
    expect(validateSignInForm({ email: 'ana', password: 'x' }).email).toBeTruthy();
  });

  it('does NOT apply a length rule to the password', () => {
    // Deliberate, mirroring `shopperSignInSchema`: rejecting a short password
    // locally tells someone their guess was the wrong SHAPE rather than
    // simply wrong, and would lock out any account whose password predates a
    // future raise of the minimum.
    expect(validateSignInForm({ email: 'ana@example.com', password: 'abc' })).toEqual({});
  });
});

describe('validateRegisterForm', () => {
  const base = { email: 'ana@example.com', password: 'contrasena1', name: '' };

  it('accepts an address and a long-enough password, with no name', () => {
    expect(validateRegisterForm(base)).toEqual({});
  });

  it('rejects a password shorter than the shared minimum and says the number', () => {
    const errors = validateRegisterForm({ ...base, password: 'a'.repeat(SHOPPER_PASSWORD_MIN - 1) });
    expect(errors.password).toContain(String(SHOPPER_PASSWORD_MIN));
  });

  it('accepts a password exactly at the minimum', () => {
    expect(validateRegisterForm({ ...base, password: 'a'.repeat(SHOPPER_PASSWORD_MIN) })).toEqual({});
  });

  it('rejects a password past the shared maximum', () => {
    // The bound exists server-side so a megabyte of "password" cannot be fed
    // to scrypt; rejecting it here saves the shopper a 400 they cannot read.
    const errors = validateRegisterForm({ ...base, password: 'a'.repeat(SHOPPER_PASSWORD_MAX + 1) });
    expect(errors.password).toBeTruthy();
    expect(validateRegisterForm({ ...base, password: 'a'.repeat(SHOPPER_PASSWORD_MAX) })).toEqual({});
  });

  it('rejects a name over 120 characters but accepts a blank one', () => {
    expect(validateRegisterForm({ ...base, name: 'a'.repeat(121) }).name).toBeTruthy();
    expect(validateRegisterForm({ ...base, name: '   ' })).toEqual({});
  });
});

describe('validateEmailOnlyForm', () => {
  it('accepts an address and rejects a blank one', () => {
    expect(validateEmailOnlyForm('ana@example.com')).toEqual({});
    expect(validateEmailOnlyForm('  ').email).toBeTruthy();
  });
});

describe('validateNewPasswordForm', () => {
  it('accepts two matching, long-enough entries', () => {
    expect(validateNewPasswordForm({ password: 'contrasena1', confirm: 'contrasena1' })).toEqual({});
  });

  it('flags a mismatch — the reset link is single-use, so a typo is unrecoverable', () => {
    const errors = validateNewPasswordForm({ password: 'contrasena1', confirm: 'contrasena2' });
    expect(errors.confirm).toBeTruthy();
    expect(errors.password).toBeUndefined();
  });

  it('reports only the length problem when the password is too short, even if the entries also differ', () => {
    // Two errors at once is noise on a two-field form: the shopper is going
    // to retype both anyway.
    const errors = validateNewPasswordForm({ password: 'abc', confirm: 'xyz' });
    expect(errors.password).toBeTruthy();
    expect(errors.confirm).toBeUndefined();
  });
});

describe('signInErrorMessage', () => {
  it('maps INVALID_CREDENTIALS to the single no-blame message', () => {
    expect(signInErrorMessage(new AccountApiError(401, 'INVALID_CREDENTIALS'))).toBe(SIGN_IN_FAILED);
  });

  it('does not blame the credentials for a server fault', () => {
    // Telling a shopper their password is wrong while the API is down sends
    // them off to reset a password that was fine.
    expect(signInErrorMessage(new AccountApiError(500, 'UNKNOWN'))).toBe(GENERIC_ERROR);
    expect(signInErrorMessage(new TypeError('network'))).toBe(GENERIC_ERROR);
  });
});

describe('linkErrorMessage', () => {
  it('maps LINK_INVALID to the "pide uno nuevo" message', () => {
    expect(linkErrorMessage(new AccountApiError(400, 'LINK_INVALID'))).toBe(LINK_INVALID);
  });

  it('falls back to the generic message for anything else', () => {
    expect(linkErrorMessage(new AccountApiError(500, 'UNKNOWN'))).toBe(GENERIC_ERROR);
    expect(linkErrorMessage('not an error at all')).toBe(GENERIC_ERROR);
  });
});

describe('tokenFromSearchParams', () => {
  it('reads a plain token', () => {
    expect(tokenFromSearchParams('abc123')).toBe('abc123');
  });

  it('takes the first of a repeated key rather than crashing', () => {
    // These URLs come out of a mail client, which is free to mangle them, and
    // these are public pages.
    expect(tokenFromSearchParams(['abc', 'def'])).toBe('abc');
  });

  it('trims surrounding whitespace a mail client may have introduced', () => {
    expect(tokenFromSearchParams(' abc ')).toBe('abc');
  });

  it('returns null for a missing, blank or whitespace-only token', () => {
    // Null, not '', so the page can say "this link is incomplete" instead of
    // sending an empty string for a guaranteed 400.
    expect(tokenFromSearchParams(undefined)).toBeNull();
    expect(tokenFromSearchParams('')).toBeNull();
    expect(tokenFromSearchParams('   ')).toBeNull();
    expect(tokenFromSearchParams([])).toBeNull();
  });
});
