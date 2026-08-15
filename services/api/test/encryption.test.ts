import { describe, expect, it } from 'vitest';
import { decrypt, encrypt, loadEncryptionKey } from '../src/payments/encryption';

// Deterministic 32-byte test fixture (no need for real randomness in a test
// constant) — same convention as packages/core/test/env.test.ts's fixture.
const KEY = Buffer.alloc(32, 1);

describe('encrypt/decrypt', () => {
  it('round-trips an empty string', () => {
    const ciphertext = encrypt('', KEY);
    expect(decrypt(ciphertext, KEY)).toBe('');
  });

  it('round-trips a unicode string', () => {
    const plaintext = 'Contraseña con acentos y emoji 🔒🎉 ñ';
    const ciphertext = encrypt(plaintext, KEY);
    expect(decrypt(ciphertext, KEY)).toBe(plaintext);
  });

  it('round-trips a realistic-length fake API key string', () => {
    const plaintext = 'prv_test_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefgh';
    expect(plaintext.length).toBeGreaterThanOrEqual(40);
    expect(plaintext.length).toBeLessThanOrEqual(60);
    const ciphertext = encrypt(plaintext, KEY);
    expect(decrypt(ciphertext, KEY)).toBe(plaintext);
  });

  it('produces the expected "base64(iv):base64(tag):base64(ciphertext)" format', () => {
    const ciphertext = encrypt('hello', KEY);
    const parts = ciphertext.split(':');
    expect(parts).toHaveLength(3);
    expect(Buffer.from(parts[0], 'base64')).toHaveLength(12); // IV
    expect(Buffer.from(parts[1], 'base64')).toHaveLength(16); // GCM auth tag
  });

  it('produces DIFFERENT ciphertexts for two encryptions of the identical plaintext with the identical key (random IV, not reused/hardcoded)', () => {
    const plaintext = 'same plaintext every time';
    expect(encrypt(plaintext, KEY)).not.toBe(encrypt(plaintext, KEY));
  });

  it('still decrypts correctly when the ciphertext is unmodified (control for the tamper test below)', () => {
    const plaintext = 'unmodified round-trip control';
    const ciphertext = encrypt(plaintext, KEY);
    expect(decrypt(ciphertext, KEY)).toBe(plaintext);
  });

  it('throws when the ciphertext portion is tampered with (GCM auth tag mismatch), rather than returning wrong plaintext', () => {
    const plaintext = 'do not tamper with me';
    const ciphertext = encrypt(plaintext, KEY);
    const [ivB64, tagB64, dataB64] = ciphertext.split(':');

    // Flip one byte in the ciphertext portion.
    const dataBuf = Buffer.from(dataB64, 'base64');
    dataBuf[0] = dataBuf[0] ^ 0xff;
    const tamperedData = [ivB64, tagB64, dataBuf.toString('base64')].join(':');

    expect(() => decrypt(tamperedData, KEY)).toThrow();
  });

  it('throws when the auth-tag portion is tampered with', () => {
    const plaintext = 'do not tamper with my tag';
    const ciphertext = encrypt(plaintext, KEY);
    const [ivB64, tagB64, dataB64] = ciphertext.split(':');

    const tagBuf = Buffer.from(tagB64, 'base64');
    tagBuf[0] = tagBuf[0] ^ 0xff;
    const tamperedTag = [ivB64, tagBuf.toString('base64'), dataB64].join(':');

    expect(() => decrypt(tamperedTag, KEY)).toThrow();
  });

  it('throws when the wrong key is used to decrypt', () => {
    const ciphertext = encrypt('some secret', KEY);
    const wrongKey = Buffer.alloc(32, 2);
    expect(() => decrypt(ciphertext, wrongKey)).toThrow();
  });

  it('throws on a malformed ciphertext string (wrong number of parts)', () => {
    expect(() => decrypt('not-a-valid-ciphertext', KEY)).toThrow();
  });
});

describe('loadEncryptionKey', () => {
  it('throws a clear error when the key is absent from source', () => {
    expect(() => loadEncryptionKey({})).toThrow(/PAYMENTS_ENCRYPTION_KEY is not set/);
  });

  it('throws a clear error when the key is present but too short', () => {
    expect(() =>
      loadEncryptionKey({ PAYMENTS_ENCRYPTION_KEY: Buffer.alloc(16, 1).toString('base64') }),
    ).toThrow(/PAYMENTS_ENCRYPTION_KEY must base64-decode to exactly 32 bytes/);
  });

  it('throws a clear error when the key is present but too long', () => {
    expect(() =>
      loadEncryptionKey({ PAYMENTS_ENCRYPTION_KEY: Buffer.alloc(40, 1).toString('base64') }),
    ).toThrow(/PAYMENTS_ENCRYPTION_KEY must base64-decode to exactly 32 bytes/);
  });

  it('throws a clear error when the key is non-base64 garbage', () => {
    expect(() =>
      loadEncryptionKey({ PAYMENTS_ENCRYPTION_KEY: 'not-valid-base64!!!' }),
    ).toThrow(/PAYMENTS_ENCRYPTION_KEY must base64-decode to exactly 32 bytes/);
  });

  it('succeeds and returns a 32-byte Buffer for a valid key', () => {
    const validKey = Buffer.alloc(32, 7).toString('base64');
    const key = loadEncryptionKey({ PAYMENTS_ENCRYPTION_KEY: validKey });
    expect(key).toBeInstanceOf(Buffer);
    expect(key).toHaveLength(32);
  });

  it('defaults to reading from process.env when no source is injected', () => {
    const original = process.env.PAYMENTS_ENCRYPTION_KEY;
    try {
      process.env.PAYMENTS_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
      const key = loadEncryptionKey();
      expect(key).toHaveLength(32);
    } finally {
      if (original === undefined) {
        delete process.env.PAYMENTS_ENCRYPTION_KEY;
      } else {
        process.env.PAYMENTS_ENCRYPTION_KEY = original;
      }
    }
  });
});
