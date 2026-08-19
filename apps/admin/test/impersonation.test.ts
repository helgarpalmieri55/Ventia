import { describe, expect, it } from 'vitest';
import {
  CRITICAL_REMAINING_MS,
  formatRemaining,
  impersonationExitPath,
  impersonationReturnPath,
  isImpersonationFailure,
  readImpersonationContext,
  remainingLabel,
  remainingLevel,
  remainingMs,
  storeLabel,
  type ImpersonationContext,
} from '../lib/impersonation';

/** The assumed `/v1/admin/me` body while impersonating — see the header of
 * `lib/impersonation.ts`. Every field name in this file is an ASSUMPTION
 * about an endpoint that does not carry it yet; if the real shape differs,
 * `readImpersonationContext` is the only production code that changes, and
 * these fixtures are the only test code that changes with it. */
function meBody(impersonation: unknown): unknown {
  return {
    userId: 'usr_1',
    email: 'ana@ventia.co',
    tenantId: 'tnt_123',
    role: 'owner',
    emailVerified: true,
    impersonation,
  };
}

function context(overrides: Partial<ImpersonationContext> = {}): ImpersonationContext {
  return {
    tenantId: 'tnt_123',
    storeName: 'Moda Bogotá',
    operatorEmail: 'ana@ventia.co',
    expiresAt: '2026-08-19T15:30:00.000Z',
    ...overrides,
  };
}

describe('readImpersonationContext', () => {
  it('reads the assumed shape off the /v1/admin/me body', () => {
    expect(
      readImpersonationContext(
        meBody({
          tenantId: 'tnt_123',
          tenantName: 'Moda Bogotá',
          operatorEmail: 'ana@ventia.co',
          expiresAt: '2026-08-19T15:30:00.000Z',
        }),
      ),
    ).toEqual(context());
  });

  it('returns null when the server reports no impersonation', () => {
    // The ONLY condition under which the banner is absent: the server said so.
    expect(readImpersonationContext(meBody(undefined))).toBeNull();
    expect(readImpersonationContext(meBody(null))).toBeNull();
    expect(readImpersonationContext(meBody(false))).toBeNull();
    expect(readImpersonationContext({ userId: 'usr_1', email: 'a@b.co' })).toBeNull();
  });

  it('returns null for a body that is not an object at all', () => {
    for (const body of [null, undefined, 'nope', 42, []]) {
      expect(readImpersonationContext(body)).toBeNull();
    }
  });

  it('still reports impersonation when the payload is unreadable', () => {
    // The direction of failure that matters. A malformed context must degrade
    // the banner's COPY, never its presence: a banner that hides itself is
    // exactly the failure the spec's AC exists to prevent.
    expect(readImpersonationContext(meBody({}))).toEqual({
      tenantId: null,
      storeName: null,
      operatorEmail: null,
      expiresAt: null,
    });
    expect(readImpersonationContext(meBody('activa'))).toEqual({
      tenantId: null,
      storeName: null,
      operatorEmail: null,
      expiresAt: null,
    });
  });

  it('ignores fields of the wrong type instead of rendering them', () => {
    // e.g. `exp` arriving as an epoch NUMBER rather than an ISO string — the
    // most likely mismatch with the real endpoint (spec §2's token payload).
    // The banner survives it; only the countdown degrades.
    const parsed = readImpersonationContext(
      meBody({ tenantId: 'tnt_123', tenantName: 42, operatorEmail: null, expiresAt: 1_755_615_000 }),
    );
    expect(parsed).toEqual({
      tenantId: 'tnt_123',
      storeName: null,
      operatorEmail: null,
      expiresAt: null,
    });
  });

  it('treats a whitespace-only string as absent', () => {
    const parsed = readImpersonationContext(meBody({ tenantId: '  ', tenantName: '   ' }));
    expect(parsed?.tenantId).toBeNull();
    expect(parsed?.storeName).toBeNull();
  });
});

describe('remainingMs', () => {
  const expiresAt = '2026-08-19T15:30:00.000Z';

  it('counts down to the grant’s hard expiry', () => {
    expect(remainingMs(expiresAt, new Date('2026-08-19T15:00:00.000Z'))).toBe(30 * 60 * 1000);
    expect(remainingMs(expiresAt, new Date('2026-08-19T15:26:00.000Z'))).toBe(4 * 60 * 1000);
  });

  it('floors at zero rather than going negative', () => {
    expect(remainingMs(expiresAt, new Date('2026-08-19T16:00:00.000Z'))).toBe(0);
  });

  it('returns null — not zero — when the deadline is unknown', () => {
    // "Unknown" and "expired" are different things to tell an operator, and
    // collapsing them would mean an unreadable payload reads as a dead
    // session that is in fact live.
    expect(remainingMs(null)).toBeNull();
    expect(remainingMs('mañana a las tres')).toBeNull();
  });

  it('accepts a numeric now, for a ticking component', () => {
    expect(remainingMs(expiresAt, Date.parse('2026-08-19T15:29:00.000Z'))).toBe(60 * 1000);
  });
});

describe('remainingLevel', () => {
  it('turns critical under five minutes', () => {
    // Spec §5's own example: "an operator who can see four minutes left does
    // not start a long task". Four minutes must be inside the loud band.
    expect(remainingLevel(4 * 60 * 1000)).toBe('critical');
    expect(remainingLevel(CRITICAL_REMAINING_MS - 1)).toBe('critical');
    expect(remainingLevel(CRITICAL_REMAINING_MS)).toBe('normal');
    expect(remainingLevel(29 * 60 * 1000)).toBe('normal');
  });

  it('separates expired from unknown', () => {
    expect(remainingLevel(0)).toBe('expired');
    expect(remainingLevel(null)).toBe('unknown');
  });
});

describe('formatRemaining', () => {
  it('renders m:ss', () => {
    expect(formatRemaining(30 * 60 * 1000)).toBe('30:00');
    expect(formatRemaining(4 * 60 * 1000 + 3000)).toBe('4:03');
    expect(formatRemaining(9000)).toBe('0:09');
  });

  it('rounds up, so it never shows 0:00 while the grant is still live', () => {
    // A countdown that hits zero early teaches an operator that the number
    // lies — and the number is the only thing telling them not to start a
    // five-minute job with two minutes left.
    expect(formatRemaining(1)).toBe('0:01');
    expect(formatRemaining(1500)).toBe('0:02');
    expect(formatRemaining(0)).toBe('0:00');
  });
});

describe('remainingLabel', () => {
  it('says the time, the expiry, or that it does not know — never a fake number', () => {
    expect(remainingLabel(4 * 60 * 1000)).toBe('Quedan 4:00');
    expect(remainingLabel(0)).toBe('La sesión expiró');
    expect(remainingLabel(null)).toBe('Tiempo restante desconocido');
  });
});

describe('storeLabel', () => {
  it('names the store', () => {
    expect(storeLabel(context())).toBe('Moda Bogotá');
  });

  it('still reads as a warning when the name is missing', () => {
    expect(storeLabel(context({ storeName: null }))).toBe('una tienda de otro comercio');
  });
});

describe('the way out', () => {
  it('returns the operator to the console, not to the merchant root', () => {
    // `/` would run the (app) layout's tenant check against an operator who
    // usually has no store of their own, and bounce them into /onboarding —
    // i.e. invite a Ventia employee to create a shop.
    expect(impersonationReturnPath(context())).toBe('/plataforma/tnt_123');
    expect(impersonationReturnPath(context({ tenantId: null }))).toBe('/plataforma');
  });

  it('targets the DELETE the design spec defines, and nothing else', () => {
    expect(impersonationExitPath(context())).toBe('/v1/platform/tenants/tnt_123/impersonate');
  });

  it('has no exit call to make when the tenant id is unknown', () => {
    // Not a dead end: the grant is self-expiring by construction (§2), so the
    // fallback is navigating away and letting the token lapse.
    expect(impersonationExitPath(context({ tenantId: null }))).toBeNull();
  });
});

describe('isImpersonationFailure', () => {
  it('recognises every 403 the grant checks can produce', () => {
    for (const error of [
      'IMPERSONATION_EXPIRED',
      'IMPERSONATION_INVALID',
      'IMPERSONATION_NOT_BOUND',
      'IMPERSONATION_REVOKED',
    ]) {
      expect(isImpersonationFailure({ error })).toBe(true);
    }
  });

  it('does not mistake the OTHER 403 on the same endpoint for one', () => {
    // `NO_TENANT` and a lapsed grant both arrive as 403 from /v1/admin/me and
    // call for opposite responses — finish signing up vs. go back to the
    // console. Conflating them redirects a Ventia employee into the
    // create-your-store wizard.
    expect(isImpersonationFailure({ error: 'NO_TENANT' })).toBe(false);
    expect(isImpersonationFailure({ error: 'FORBIDDEN_ROLE' })).toBe(false);
  });

  it('is false for anything unreadable, so the existing behaviour is the default', () => {
    for (const body of [null, undefined, {}, [], 'IMPERSONATION_EXPIRED', { error: 42 }]) {
      expect(isImpersonationFailure(body)).toBe(false);
    }
  });
});
