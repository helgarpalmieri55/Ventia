import { describe, expect, it } from 'vitest';
import {
  hashPassword,
  hashSecret,
  issueSecret,
  normalizeEmail,
  verifyPassword,
} from '../src/shopper/shopper-credentials';

/**
 * Shopper credentials.
 *
 * Everything here guards a bearer credential, so the tests are mostly about
 * the ways this can fail OPEN — a malformed stored value authenticating, a
 * missing password authenticating, two shoppers sharing a hash.
 */

describe('hashPassword / verifyPassword', () => {
  it('accepts the right password and rejects a wrong one', async () => {
    const stored = await hashPassword('una contraseña larga');
    expect(await verifyPassword('una contraseña larga', stored)).toBe(true);
    expect(await verifyPassword('otra contraseña', stored)).toBe(false);
  });

  it('salts, so the same password does not produce the same hash', async () => {
    // Without a per-password salt, cracking one account cracks every account
    // that chose the same password — across every store on the platform.
    const a = await hashPassword('12345678');
    const b = await hashPassword('12345678');
    expect(a).not.toBe(b);
    expect(await verifyPassword('12345678', a)).toBe(true);
    expect(await verifyPassword('12345678', b)).toBe(true);
  });

  it('handles a password long enough to exceed scrypt\'s default memory limit', async () => {
    // The cost parameters need ~33.5 MB, over Node's 32 MB default `maxmem`.
    // Without the explicit override every hash throws — so this asserts the
    // parameters actually run, not merely that they are declared.
    const stored = await hashPassword('a'.repeat(512));
    expect(await verifyPassword('a'.repeat(512), stored)).toBe(true);
  });

  it('says NO for an account that has no password at all', async () => {
    // Magic-link-only accounts are a legitimate state. The dangerous reading
    // is "no stored hash, nothing to compare against, let them in".
    expect(await verifyPassword('cualquier cosa', null)).toBe(false);
    expect(await verifyPassword('cualquier cosa', undefined)).toBe(false);
    expect(await verifyPassword('', null)).toBe(false);
  });

  it('says NO for a stored value it cannot parse, rather than throwing', async () => {
    // A corrupt row must be an authentication failure, not a 500 — and
    // certainly not a success.
    for (const bad of ['', 'garbage', 'scrypt$only-two', 'bcrypt$abc$def', 'scrypt$$', 'scrypt$abc$']) {
      expect(await verifyPassword('cualquier cosa', bad), bad).toBe(false);
    }
  });

  it('enforces the algorithm marker, not just the shape', async () => {
    // A hash whose salt and key are genuinely correct but whose prefix says
    // something else must NOT verify. Otherwise the marker is decoration, and
    // the day this moves off scrypt every old row silently verifies under the
    // new algorithm's rules. Built by relabelling a real hash, so the only
    // thing wrong with it is the prefix.
    const real = await hashPassword('la contraseña');
    const relabelled = real.replace(/^scrypt\$/, 'argon2$');

    expect(await verifyPassword('la contraseña', real)).toBe(true);
    expect(await verifyPassword('la contraseña', relabelled)).toBe(false);
  });

  it('is not fooled by an empty password against an empty-ish hash', async () => {
    const stored = await hashPassword('');
    expect(await verifyPassword('', stored)).toBe(true);
    expect(await verifyPassword('x', stored)).toBe(false);
  });
});

describe('issueSecret / hashSecret', () => {
  it('returns a secret and the hash to store beside it', () => {
    const { secret, hash } = issueSecret();
    expect(hashSecret(secret)).toBe(hash);
  });

  it('never repeats', () => {
    const seen = new Set(Array.from({ length: 200 }, () => issueSecret().secret));
    expect(seen.size).toBe(200);
  });

  it('produces a URL-safe secret, because it travels in a link', () => {
    // A `+` or `/` in a magic-link query string is a support ticket.
    for (let i = 0; i < 50; i++) {
      expect(issueSecret().secret).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it('stores something that cannot be presented as a credential', () => {
    // The whole point: a database dump yields hashes, and a hash is not a
    // login. The stored form must not be the secret itself.
    const { secret, hash } = issueSecret();
    expect(hash).not.toBe(secret);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('normalizeEmail', () => {
  it('folds case and trims, so one person has one account per store', () => {
    expect(normalizeEmail('  Ana@Example.COM ')).toBe('ana@example.com');
  });

  it('leaves dots and +tags alone', () => {
    // Provider-specific rules. Applying Gmail's to every domain would merge
    // addresses that really are distinct, and a shopper entitled to a second
    // account at a store would be refused one.
    expect(normalizeEmail('ana.maria+tienda@example.com')).toBe('ana.maria+tienda@example.com');
  });
});
