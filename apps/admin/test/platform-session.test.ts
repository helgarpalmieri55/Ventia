import { describe, expect, it } from 'vitest';
import { platformAccessFromStatus } from '../lib/platform-session';

describe('platformAccessFromStatus', () => {
  it('grants the console only on a 200 from the guarded endpoint', () => {
    expect(platformAccessFromStatus(200)).toBe('operator');
  });

  it('sends an unauthenticated visitor to log in', () => {
    expect(platformAccessFromStatus(401)).toBe('anonymous');
  });

  it('shows a plain refusal to a signed-in non-operator', () => {
    expect(platformAccessFromStatus(403)).toBe('denied');
  });

  it('fails closed on every other status, including ones this app has never seen', () => {
    // The dangerous default is the one that falls through to `operator`: a
    // 500, a 502 from a restarting API, or a 302 into a login page would then
    // render an operator console. None of them may.
    for (const status of [0, 204, 301, 302, 400, 404, 418, 429, 500, 502, 503, 504]) {
      expect(platformAccessFromStatus(status)).toBe('unavailable');
    }
  });

  it('grants on 200 and on nothing else in the 2xx range', () => {
    expect(platformAccessFromStatus(201)).toBe('unavailable');
    expect(platformAccessFromStatus(299)).toBe('unavailable');
  });
});
