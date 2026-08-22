import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';

/**
 * Password hashing and single-use secrets for shopper accounts.
 *
 * ## Why scrypt, and no new dependency
 *
 * `node:crypto` ships scrypt, which is memory-hard and is what a password
 * needs. Adding argon2 or bcrypt would mean a native module in the deploy for
 * a marginal difference at these parameters. better-auth handles MERCHANT
 * passwords and is deliberately not reused here — its tables are revoked from
 * `ventia_app` because merchant identity must stay unreachable from tenant
 * code, and shopper identity is the opposite kind of thing.
 *
 * ## Why secrets are stored hashed
 *
 * A session token and a magic link are bearer credentials: whoever holds one
 * IS the shopper. Only their SHA-256 goes in the database, so a dump — a
 * backup on a laptop, a replica someone can read, a mis-scoped query — yields
 * nothing that can be presented as a login. SHA-256 and not scrypt for these
 * two: the secret is already 256 bits of randomness, so there is nothing to
 * brute-force and no reason to make every request pay a KDF.
 */

/** scrypt CPU/memory cost. 2^15 keeps a single hash in the tens of
 * milliseconds on ordinary hardware — slow enough to make offline cracking
 * expensive, fast enough that a shopper signing in does not notice. */
const SCRYPT_COST = 32_768;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELISM = 1;
const SCRYPT_KEY_LENGTH = 64;
const SALT_LENGTH = 16;

/**
 * scrypt's working memory is roughly `128 * N * r` — about 33.5 MB at the
 * parameters above, which is OVER Node's 32 MB default `maxmem`. Left at the
 * default, every single hash throws `memory limit exceeded`, so this is not a
 * tuning knob: without it the cost parameters simply do not work. Set to twice
 * the requirement so a future bump of `r` does not silently reintroduce the
 * same failure.
 */
const SCRYPT_MAX_MEM = 64 * 1024 * 1024;

/** `node:util`'s `promisify` drops scrypt's options overload, so the wrapper
 * is written out rather than generated — the options are the whole point. */
function scryptAsync(password: string, salt: Buffer, keyLength: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(
      password,
      salt,
      keyLength,
      { N: SCRYPT_COST, r: SCRYPT_BLOCK_SIZE, p: SCRYPT_PARALLELISM, maxmem: SCRYPT_MAX_MEM },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

/** Bytes of entropy in a session token or link secret. 256 bits — unguessable,
 * and the reason the stored hash needs no salt. */
const SECRET_LENGTH = 32;

/** Marks the stored format so a future change of algorithm can be detected and
 * migrated rather than silently mis-verified. */
const PREFIX = 'scrypt';
const DELIMITER = '$';

/**
 * Hashes a password into `scrypt$<salt-b64>$<key-b64>`.
 *
 * A fresh random salt per call, so two shoppers who choose the same password
 * do not get the same hash — which is what stops one crack from being a
 * platform-wide crack.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const key = await scryptAsync(password, salt, SCRYPT_KEY_LENGTH);
  return [PREFIX, salt.toString('base64'), key.toString('base64')].join(DELIMITER);
}

/**
 * Whether `password` produced `stored`.
 *
 * Returns `false` — never throws — for a malformed, empty or `null` stored
 * value. An account with no password (magic-link only) is a legitimate state,
 * and a caller must be able to ask this question about one without a special
 * case; the answer is simply "no".
 *
 * The comparison is constant-time. A `===` on the derived key leaks, through
 * timing, how much of it matched.
 */
export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (typeof stored !== 'string') return false;
  const parts = stored.split(DELIMITER);
  if (parts.length !== 3 || parts[0] !== PREFIX) return false;

  const salt = Buffer.from(parts[1], 'base64');
  const expected = Buffer.from(parts[2], 'base64');
  if (salt.length === 0 || expected.length === 0) return false;

  let actual: Buffer;
  try {
    actual = await scryptAsync(password, salt, expected.length);
  } catch {
    // A stored value whose recorded key length is absurd would make scrypt
    // throw. That is a corrupt row, not an authentication success.
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * A fresh bearer secret and the hash to store beside it.
 *
 * Returned together, once, because the plaintext must never be recoverable
 * afterwards — the caller sends it in a cookie or an email and then forgets
 * it. Any code path that needs to "look up someone's token" is a design error
 * this shape makes hard to write.
 */
export function issueSecret(): { secret: string; hash: string } {
  const secret = randomBytes(SECRET_LENGTH).toString('base64url');
  return { secret, hash: hashSecret(secret) };
}

/** The stored form of a bearer secret. Deterministic, so a presented secret
 * can be looked up directly by its hash. */
export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/**
 * Normalises an email for storage and lookup.
 *
 * Lowercased and trimmed so `Ana@Example.com` and `ana@example.com ` are the
 * same account rather than two — which matters more here than usual, because
 * the uniqueness constraint is per tenant and a duplicate would let one person
 * hold two logins at the same store with the same address.
 *
 * Deliberately does NOT strip Gmail-style dots or `+tags`: those are
 * provider-specific rules, applying them to every domain would merge addresses
 * that really are distinct, and a shopper who wants a second account at a
 * store is entitled to one.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
