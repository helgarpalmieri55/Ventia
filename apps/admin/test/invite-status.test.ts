import { describe, expect, it } from 'vitest';
import { inviteStatus } from '../lib/invite-status';

describe('inviteStatus', () => {
  const now = new Date('2026-07-25T12:00:00.000Z');

  it('returns pendiente when expiresAt is in the future relative to now', () => {
    expect(inviteStatus({ expiresAt: new Date('2026-08-01T00:00:00.000Z') }, now)).toBe('pendiente');
  });

  it('returns expirada when expiresAt is in the past relative to now', () => {
    expect(inviteStatus({ expiresAt: new Date('2026-07-01T00:00:00.000Z') }, now)).toBe('expirada');
  });

  it('returns expirada on the exact boundary (expiresAt === now)', () => {
    expect(inviteStatus({ expiresAt: new Date(now) }, now)).toBe('expirada');
  });

  it('accepts an ISO date string, same as the API returns over JSON', () => {
    expect(inviteStatus({ expiresAt: '2026-08-01T00:00:00.000Z' }, now)).toBe('pendiente');
    expect(inviteStatus({ expiresAt: '2026-07-01T00:00:00.000Z' }, now)).toBe('expirada');
  });

  it('defaults `now` to the current time when omitted', () => {
    const farFutureIso = new Date(Date.now() + 1000 * 60 * 60 * 24 * 365).toISOString();
    const farPastIso = new Date(Date.now() - 1000 * 60 * 60 * 24 * 365).toISOString();
    expect(inviteStatus({ expiresAt: farFutureIso })).toBe('pendiente');
    expect(inviteStatus({ expiresAt: farPastIso })).toBe('expirada');
  });
});
