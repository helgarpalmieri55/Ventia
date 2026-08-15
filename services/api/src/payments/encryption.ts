import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// AES-256-GCM credential encryption for payment-provider secrets (Wompi's
// public/private keys, integrity secret) at rest in Tenant.settings JSON —
// see docs/superpowers/specs/2026-07-28-p3a-payments-infra-wompi-design.md
// decision 6. Only the ciphertext (+ IV + auth tag) is ever persisted; the
// plaintext is decrypted in-memory only at the moment a provider call needs
// it.

const ALGORITHM = 'aes-256-gcm';
// GCM's recommended IV length — a fresh random IV per encrypt() call, never
// reused, is what makes two encryptions of the same plaintext produce
// different ciphertext (semantic security), not a hardcoded/derived value.
const IV_LENGTH_BYTES = 12;
const DELIMITER = ':';

/**
 * Encrypts `plaintext` with AES-256-GCM under `key` (must be exactly 32
 * bytes — the caller is expected to have obtained it via
 * `loadEncryptionKey()`, which enforces this). Returns
 * "base64(iv):base64(tag):base64(ciphertext)" — `:` can't appear inside a
 * base64-encoded segment, so splitting on it in `decrypt` is unambiguous.
 */
export function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_LENGTH_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join(
    DELIMITER,
  );
}

/**
 * Reverses `encrypt`. Throws if `ciphertext` is malformed (wrong number of
 * `:`-delimited parts) or if GCM's authentication fails — a tampered
 * ciphertext/tag, or the wrong key, makes `decipher.final()` throw rather
 * than silently returning corrupted plaintext. That throw is allowed to
 * propagate as-is; it is NOT swallowed here.
 */
export function decrypt(ciphertext: string, key: Buffer): string {
  const parts = ciphertext.split(DELIMITER);
  if (parts.length !== 3) {
    throw new Error('Invalid ciphertext format: expected "iv:tag:ciphertext"');
  }
  const [ivB64, tagB64, dataB64] = parts;
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const data = Buffer.from(dataB64, 'base64');
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  // decipher.final() throws on auth-tag mismatch (tampered ciphertext/tag,
  // or wrong key) — this is GCM's built-in authentication, the entire point
  // of using it over a plain (non-authenticated) cipher mode.
  const plaintext = Buffer.concat([decipher.update(data), decipher.final()]);
  return plaintext.toString('utf8');
}

/**
 * Reads and base64-decodes `PAYMENTS_ENCRYPTION_KEY` from `source` (defaults
 * to `process.env`, matching `loadEnv`'s own `source` parameter convention so
 * a caller/test can inject a fake env object instead of mutating global
 * `process.env`). Throws a clear, specific `Error` if the var is missing or
 * doesn't decode to exactly 32 bytes (AES-256's key length) — never silently
 * returns a wrong-length buffer, which would otherwise fail cryptically deep
 * inside `crypto.createCipheriv`.
 *
 * Deliberately does NOT call `@ventia/core`'s `loadEnv()` — `loadEnv()`
 * validates the WHOLE env schema (every required-with-no-default field),
 * which breaks any test that doesn't set every one of those as a real
 * `process.env` value. This is a narrow, standalone reader of just this one
 * var. See the P2b Task 5 postmortem referenced in
 * services/api/src/mailer/mailer.module.ts for the exact failure mode this
 * avoids.
 */
export function loadEncryptionKey(
  source: Record<string, string | undefined> = process.env,
): Buffer {
  const raw = source.PAYMENTS_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error('PAYMENTS_ENCRYPTION_KEY is not set');
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error(
      `PAYMENTS_ENCRYPTION_KEY must base64-decode to exactly 32 bytes (got ${key.length})`,
    );
  }
  return key;
}
