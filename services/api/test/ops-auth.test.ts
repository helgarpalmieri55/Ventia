import { describe, expect, it } from 'vitest';
import {
  MIN_TOKEN_LENGTH,
  OPS_TOKEN_ENV,
  bearerToken,
  configuredToken,
  constantTimeEquals,
} from '../src/ops/ops-token.guard';
import {
  DEFAULT_PUSH_INTERVAL_MS,
  MIN_PUSH_INTERVAL_MS,
  OPS_PUSH_INTERVAL_ENV,
  OPS_PUSH_URL_ENV,
  pushConfig,
  pushIntervalMs,
  signPayload,
} from '../src/ops/ops-push.worker';

const TOKEN = 'x'.repeat(MIN_TOKEN_LENGTH);

/**
 * The OPS feed's credential handling.
 *
 * This endpoint hands over every tenant's cost and health in one response, and
 * the credential is a long-lived secret sitting in another application's config
 * file. Everything here is about failing in the safe direction.
 */

describe('configuredToken', () => {
  it('accepts a token of sufficient length', () => {
    expect(configuredToken({ [OPS_TOKEN_ENV]: TOKEN })).toBe(TOKEN);
  });

  it('treats absent, blank, and too-short as NOT configured', () => {
    // Fails closed: a missing secret must deny everyone, not open the feed.
    expect(configuredToken({})).toBeNull();
    expect(configuredToken({ [OPS_TOKEN_ENV]: '' })).toBeNull();
    expect(configuredToken({ [OPS_TOKEN_ENV]: '    ' })).toBeNull();
    expect(configuredToken({ [OPS_TOKEN_ENV]: 'short' })).toBeNull();
    expect(configuredToken({ [OPS_TOKEN_ENV]: 'y'.repeat(MIN_TOKEN_LENGTH - 1) })).toBeNull();
  });
});

describe('bearerToken', () => {
  it('extracts the credential, case-insensitively on the scheme', () => {
    expect(bearerToken(`Bearer ${TOKEN}`)).toBe(TOKEN);
    expect(bearerToken(`bearer ${TOKEN}`)).toBe(TOKEN);
    expect(bearerToken(`  BEARER   ${TOKEN}  `)).toBe(TOKEN);
  });

  it('rejects anything that is not a bearer credential', () => {
    expect(bearerToken(undefined)).toBeNull();
    expect(bearerToken('')).toBeNull();
    expect(bearerToken(TOKEN)).toBeNull();
    expect(bearerToken(`Basic ${TOKEN}`)).toBeNull();
  });
});

describe('constantTimeEquals', () => {
  it('is an equality check', () => {
    expect(constantTimeEquals(TOKEN, TOKEN)).toBe(true);
    expect(constantTimeEquals(TOKEN, TOKEN.replace(/x$/, 'y'))).toBe(false);
  });

  it('does not throw on differing lengths, and still says no', () => {
    // `timingSafeEqual` throws outright on a length mismatch, which would make
    // a wrong-length guess a 500 and a right-length guess a 401 — the response
    // code alone would leak the secret's length.
    expect(constantTimeEquals('short', TOKEN)).toBe(false);
    expect(constantTimeEquals(TOKEN, 'short')).toBe(false);
    expect(constantTimeEquals('', TOKEN)).toBe(false);
    expect(constantTimeEquals('', '')).toBe(true);
  });

  it('does not treat a prefix as a match', () => {
    expect(constantTimeEquals(TOKEN.slice(0, -1), TOKEN)).toBe(false);
  });

  it('does not let NUL padding make a shorter secret compare equal', () => {
    // Both sides are zero-padded to a common width before `timingSafeEqual`,
    // so without the explicit length comparison a value that is the real token
    // followed by NUL bytes would pad to an identical buffer and authenticate.
    // Node's HTTP parser rejects NUL in a header value, so this is not
    // reachable through the guard today — which is a reason to keep the check,
    // not a reason to trust the parser forever.
    expect(constantTimeEquals(`${TOKEN}\u0000`, TOKEN)).toBe(false);
    expect(constantTimeEquals(TOKEN, `${TOKEN}\u0000\u0000`)).toBe(false);
  });
});

describe('pushConfig', () => {
  const base = { [OPS_TOKEN_ENV]: TOKEN, [OPS_PUSH_URL_ENV]: 'https://ops.example.com/ingest' };

  it('reads a complete configuration', () => {
    expect(pushConfig(base)).toEqual({
      url: 'https://ops.example.com/ingest',
      intervalMs: DEFAULT_PUSH_INTERVAL_MS,
      secret: TOKEN,
    });
  });

  it('refuses to push without a token to sign with', () => {
    // An unsigned feed the receiver cannot authenticate is worse than none,
    // because it gets trusted anyway.
    expect(pushConfig({ [OPS_PUSH_URL_ENV]: base[OPS_PUSH_URL_ENV] })).toBeNull();
    expect(pushConfig({ ...base, [OPS_TOKEN_ENV]: 'short' })).toBeNull();
  });

  it('is simply off when no URL is set, which is a supported state', () => {
    expect(pushConfig({ [OPS_TOKEN_ENV]: TOKEN })).toBeNull();
  });

  it('refuses a URL that is not absolute http(s)', () => {
    // Caught here rather than at push time, so a typo is a startup log line
    // instead of a recurring runtime error nobody reads.
    expect(pushConfig({ ...base, [OPS_PUSH_URL_ENV]: '/ingest' })).toBeNull();
    expect(pushConfig({ ...base, [OPS_PUSH_URL_ENV]: 'ops.example.com' })).toBeNull();
    expect(pushConfig({ ...base, [OPS_PUSH_URL_ENV]: 'file:///etc/passwd' })).toBeNull();
  });
});

describe('pushIntervalMs', () => {
  it('defaults when unset or unparseable, rather than disabling the push', () => {
    expect(pushIntervalMs({})).toBe(DEFAULT_PUSH_INTERVAL_MS);
    expect(pushIntervalMs({ [OPS_PUSH_INTERVAL_ENV]: 'cada minuto' })).toBe(DEFAULT_PUSH_INTERVAL_MS);
    expect(pushIntervalMs({ [OPS_PUSH_INTERVAL_ENV]: '0' })).toBe(DEFAULT_PUSH_INTERVAL_MS);
    expect(pushIntervalMs({ [OPS_PUSH_INTERVAL_ENV]: '-30' })).toBe(DEFAULT_PUSH_INTERVAL_MS);
  });

  it('accepts a configured cadence in seconds', () => {
    expect(pushIntervalMs({ [OPS_PUSH_INTERVAL_ENV]: '300' })).toBe(300_000);
  });

  it('clamps up, so nobody can turn monitoring into a load test', () => {
    expect(pushIntervalMs({ [OPS_PUSH_INTERVAL_ENV]: '1' })).toBe(MIN_PUSH_INTERVAL_MS);
  });
});

describe('signPayload', () => {
  it('covers the timestamp as well as the body', () => {
    // A signature over the body alone lets a captured POST be replayed
    // forever, and the receiver could not tell a replay from an unchanged
    // snapshot repeating.
    const body = '{"stores":[]}';
    expect(signPayload(TOKEN, '2026-08-21T00:00:00.000Z', body)).not.toBe(
      signPayload(TOKEN, '2026-08-21T00:01:00.000Z', body),
    );
  });

  it('changes with the body and with the secret', () => {
    const ts = '2026-08-21T00:00:00.000Z';
    expect(signPayload(TOKEN, ts, '{"a":1}')).not.toBe(signPayload(TOKEN, ts, '{"a":2}'));
    expect(signPayload(TOKEN, ts, '{"a":1}')).not.toBe(signPayload('z'.repeat(40), ts, '{"a":1}'));
  });

  it('is deterministic, so a receiver can recompute it', () => {
    const ts = '2026-08-21T00:00:00.000Z';
    expect(signPayload(TOKEN, ts, '{"a":1}')).toBe(signPayload(TOKEN, ts, '{"a":1}'));
  });
});
