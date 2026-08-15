import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/env.js';

// Deterministic 32-byte test fixture (no need for real randomness in a test
// constant) — matches the shape loadEncryptionKey()/encrypt()/decrypt() in
// services/api/src/payments/encryption.ts expect.
const VALID_PAYMENTS_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');

describe('loadEnv', () => {
  it('parses a valid environment', () => {
    const env = loadEnv({
      DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
      REDIS_URL: 'redis://localhost:6379',
      AUTH_SECRET: 'secret',
      PLATFORM_ROOT_DOMAIN: 'ventia.localhost',
      PAYMENTS_ENCRYPTION_KEY: VALID_PAYMENTS_ENCRYPTION_KEY,
    });
    expect(env.PLATFORM_ROOT_DOMAIN).toBe('ventia.localhost');
    expect(env.API_PORT).toBe(4000); // default
  });

  it('throws on missing DATABASE_URL', () => {
    expect(() => loadEnv({ AUTH_SECRET: 'x' })).toThrow(/DATABASE_URL/);
  });

  it('provides S3 defaults for dev', () => {
    const env = loadEnv({
      DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
      REDIS_URL: 'redis://localhost:6379',
      AUTH_SECRET: 'secret',
      PAYMENTS_ENCRYPTION_KEY: VALID_PAYMENTS_ENCRYPTION_KEY,
    });
    expect(env.S3_ENDPOINT).toBe('http://localhost:9000');
    expect(env.S3_BUCKET).toBe('ventia');
    expect(env.S3_PUBLIC_URL).toBe('http://localhost:9000/ventia');
  });

  // A typo here used to pass boot AND the whole test suite, then 500 every
  // non-`cod` checkout for every tenant — the value is read per-request and
  // throws inside checkout, so the first signal was a shopper failing to pay.
  // Declaring it in the schema moves that failure to boot.
  it('throws on a misspelled STOREFRONT_PUBLIC_SCHEME rather than deferring to payment time', () => {
    expect(() =>
      loadEnv({
        DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
        REDIS_URL: 'redis://localhost:6379',
        AUTH_SECRET: 'secret',
        PAYMENTS_ENCRYPTION_KEY: VALID_PAYMENTS_ENCRYPTION_KEY,
        STOREFRONT_PUBLIC_SCHEME: 'htps',
      }),
    ).toThrow(/STOREFRONT_PUBLIC_SCHEME/);
  });

  it('accepts both valid STOREFRONT_PUBLIC_SCHEME values, and leaves it unset for inference', () => {
    const base = {
      DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
      REDIS_URL: 'redis://localhost:6379',
      AUTH_SECRET: 'secret',
      PAYMENTS_ENCRYPTION_KEY: VALID_PAYMENTS_ENCRYPTION_KEY,
    };
    expect(loadEnv({ ...base, STOREFRONT_PUBLIC_SCHEME: 'http' }).STOREFRONT_PUBLIC_SCHEME).toBe('http');
    expect(loadEnv({ ...base, STOREFRONT_PUBLIC_SCHEME: 'https' }).STOREFRONT_PUBLIC_SCHEME).toBe('https');
    // Unset is the normal case — the scheme is then inferred from the domain.
    expect(loadEnv(base).STOREFRONT_PUBLIC_SCHEME).toBeUndefined();
  });

  it('throws a clear error when PAYMENTS_ENCRYPTION_KEY is missing entirely', () => {
    expect(() =>
      loadEnv({
        DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
        REDIS_URL: 'redis://localhost:6379',
        AUTH_SECRET: 'secret',
      }),
    ).toThrow(/PAYMENTS_ENCRYPTION_KEY/);
  });

  it('throws a clear error when PAYMENTS_ENCRYPTION_KEY decodes to too few bytes', () => {
    expect(() =>
      loadEnv({
        DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
        REDIS_URL: 'redis://localhost:6379',
        AUTH_SECRET: 'secret',
        PAYMENTS_ENCRYPTION_KEY: Buffer.alloc(16, 1).toString('base64'),
      }),
    ).toThrow(/PAYMENTS_ENCRYPTION_KEY must base64-decode to exactly 32 bytes/);
  });

  it('throws a clear error when PAYMENTS_ENCRYPTION_KEY decodes to too many bytes', () => {
    expect(() =>
      loadEnv({
        DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
        REDIS_URL: 'redis://localhost:6379',
        AUTH_SECRET: 'secret',
        PAYMENTS_ENCRYPTION_KEY: Buffer.alloc(40, 1).toString('base64'),
      }),
    ).toThrow(/PAYMENTS_ENCRYPTION_KEY must base64-decode to exactly 32 bytes/);
  });

  it('throws a clear error when PAYMENTS_ENCRYPTION_KEY is non-base64 garbage', () => {
    expect(() =>
      loadEnv({
        DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
        REDIS_URL: 'redis://localhost:6379',
        AUTH_SECRET: 'secret',
        // Not valid base64 padding/length for 32 raw bytes either way — the
        // refine still catches it (Buffer.from with invalid base64 chars
        // just drops them rather than throwing, so the length check is what
        // actually rejects this, not a caught exception — worth the test).
        PAYMENTS_ENCRYPTION_KEY: 'not-valid-base64!!!',
      }),
    ).toThrow(/PAYMENTS_ENCRYPTION_KEY must base64-decode to exactly 32 bytes/);
  });
});
