import { describe, expect, it } from 'vitest';
import { ApiError } from '../lib/api';
import {
  PLAN_LABELS,
  TENANT_STATUS_BADGE,
  TENANT_STATUS_LABELS,
  aiUsageLabel,
  aiUsageLevel,
  buildTenantListQuery,
  formatMonthCO,
  planChangeSummary,
  platformErrorMessage,
  platformErrorText,
  platformTenantPath,
  storefrontEffectMessage,
  suspendConfirmationMatches,
  suspendConfirmationToken,
  type PlatformAiUsage,
  type SetStatusResult,
} from '../lib/platform-api';

function ai(overrides: Partial<PlatformAiUsage> = {}): PlatformAiUsage {
  return {
    messages: 0,
    messagesLimit: 500,
    inputTokens: 0,
    outputTokens: 0,
    costCents: 0,
    percentUsed: 0,
    ...overrides,
  };
}

function statusResult(overrides: Partial<SetStatusResult> = {}): SetStatusResult {
  return {
    id: 't1',
    status: 'suspended',
    previousStatus: 'live',
    storefrontEffective: 'immediate',
    ...overrides,
  };
}

describe('buildTenantListQuery', () => {
  it('always sends page and perPage, defaulting to the API defaults', () => {
    expect(buildTenantListQuery()).toBe('page=1&perPage=25');
  });

  it('omits an empty or whitespace-only search rather than sending q=""', () => {
    // platformTenantListQuerySchema declares q as .min(1), so a blank q is a
    // 400, not "no filter". Sending it would break the page on every clear.
    expect(buildTenantListQuery({ q: '' })).toBe('page=1&perPage=25');
    expect(buildTenantListQuery({ q: '   ' })).toBe('page=1&perPage=25');
  });

  it('trims the search term it does send', () => {
    expect(buildTenantListQuery({ q: '  moda bogotá  ' })).toContain('q=moda+bogot%C3%A1');
  });

  it('omits the "Todos" option of each filter (empty string is not in the enum)', () => {
    expect(buildTenantListQuery({ status: '', plan: '' })).toBe('page=1&perPage=25');
  });

  it('sends the filters that are set, plus paging', () => {
    expect(buildTenantListQuery({ q: 'ana', status: 'suspended', plan: 'pro', page: 3, perPage: 10 })).toBe(
      'q=ana&status=suspended&plan=pro&page=3&perPage=10',
    );
  });
});

describe('suspendConfirmationMatches', () => {
  const tenant = { slug: 'moda-bogota' };

  it('requires the tenant\'s own slug — not a fixed word an operator can type from memory', () => {
    // The point of the per-tenant token: the word that confirms suspending
    // THIS store must not confirm suspending any other one.
    expect(suspendConfirmationToken(tenant)).toBe('moda-bogota');
    expect(suspendConfirmationMatches('moda-bogota', tenant)).toBe(true);
    expect(suspendConfirmationMatches('SUSPENDER', tenant)).toBe(false);
    expect(suspendConfirmationMatches('otra-tienda', tenant)).toBe(false);
  });

  it('never accepts an empty or blank confirmation', () => {
    expect(suspendConfirmationMatches('', tenant)).toBe(false);
    expect(suspendConfirmationMatches('   ', tenant)).toBe(false);
    // …and a tenant whose slug were somehow blank must not be suspendable by
    // an empty box either.
    expect(suspendConfirmationMatches('', { slug: '' })).toBe(false);
  });

  it('forgives case and surrounding whitespace: this is a transcribed identifier, not a password', () => {
    expect(suspendConfirmationMatches('  Moda-Bogota ', tenant)).toBe(true);
  });

  it('does not accept a prefix, a suffix, or a substring of the slug', () => {
    expect(suspendConfirmationMatches('moda', tenant)).toBe(false);
    expect(suspendConfirmationMatches('moda-bogota-2', tenant)).toBe(false);
    expect(suspendConfirmationMatches('la-moda-bogota', tenant)).toBe(false);
  });
});

describe('aiUsageLevel', () => {
  it('calls a zero limit "sin-cupo" rather than 0 % used', () => {
    // A tenant with no TenantLimits row is hard-capped at zero messages: its
    // agent refuses every shopper. "0 %" would read as healthy.
    expect(aiUsageLevel(ai({ messagesLimit: 0, percentUsed: null }))).toBe('sin-cupo');
    expect(aiUsageLabel(ai({ messagesLimit: 0, percentUsed: null }))).toBe('Sin cupo de IA');
  });

  it('treats a null percentUsed as sin-cupo even if the limit looks non-zero', () => {
    expect(aiUsageLevel(ai({ messagesLimit: 500, percentUsed: null }))).toBe('sin-cupo');
  });

  it('warns at 90 % and reports the cap as reached at 100 %', () => {
    expect(aiUsageLevel(ai({ percentUsed: 89 }))).toBe('normal');
    expect(aiUsageLevel(ai({ percentUsed: 90 }))).toBe('alerta');
    expect(aiUsageLevel(ai({ percentUsed: 99 }))).toBe('alerta');
    expect(aiUsageLevel(ai({ percentUsed: 100 }))).toBe('excedido');
    expect(aiUsageLevel(ai({ percentUsed: 140 }))).toBe('excedido');
  });

  it('says "tope alcanzado" only once the cap is actually being enforced', () => {
    expect(aiUsageLabel(ai({ percentUsed: 95 }))).toBe('95 % del cupo');
    expect(aiUsageLabel(ai({ percentUsed: 100 }))).toBe('100 % · tope alcanzado');
  });
});

describe('storefrontEffectMessage', () => {
  it('says the store is already offline when the resolver cache was cleared', () => {
    const message = storefrontEffectMessage(statusResult());
    expect(message).toContain('fuera de línea');
    expect(message).not.toContain('60 segundos');
  });

  it('warns about the 60-second lag when Redis refused, without claiming the write failed', () => {
    const message = storefrontEffectMessage(statusResult({ storefrontEffective: 'within-60s' }));
    expect(message).toContain('quedó guardado');
    expect(message).toContain('60 segundos');
  });

  it('reads in the right direction for a reactivation', () => {
    expect(storefrontEffectMessage(statusResult({ status: 'live', previousStatus: 'suspended' }))).toContain(
      'en línea',
    );
  });
});

describe('planChangeSummary', () => {
  it('names both plans on a real change', () => {
    expect(
      planChangeSummary({ id: 't1', plan: 'premium', previousPlan: 'basico', limits: {} as never }),
    ).toBe('Plan cambiado de Básico a Premium. Sus límites se reescribieron para coincidir.');
  });

  it('reads as a repair when the plan did not change (the limits still got rewritten)', () => {
    expect(planChangeSummary({ id: 't1', plan: 'pro', previousPlan: 'pro', limits: {} as never })).toContain(
      'Se reescribieron sus límites',
    );
  });
});

describe('platformErrorMessage', () => {
  it('answers NOT_PLATFORM_ADMIN in operator terms, not merchant terms', () => {
    expect(platformErrorMessage(new ApiError(403, 'NOT_PLATFORM_ADMIN'))).toContain('consola de plataforma');
  });

  it('explains TENANT_NOT_SUSPENDED as "nothing to reactivate"', () => {
    expect(platformErrorMessage(new ApiError(409, 'TENANT_NOT_SUSPENDED'))).toContain('no está suspendida');
  });

  it('never tells an operator that "tu tienda" is suspended — that copy is for merchants', () => {
    // errors.ts maps TENANT_NOT_FOUND to "No encontramos la tienda." An
    // operator reading merchant-voiced copy about a company they have never
    // met is precisely the confusion this surface is built to prevent.
    expect(platformErrorMessage(new ApiError(404, 'TENANT_NOT_FOUND'))).toContain('cuenta de comercio');
  });

  it('falls back to the shared merchant table for codes it does not override', () => {
    expect(platformErrorMessage(new ApiError(0, 'NETWORK'))).toBe(
      'No pudimos conectar con el servidor. Verifica tu conexión.',
    );
    expect(platformErrorMessage(new ApiError(500, 'SOMETHING_NEW'))).toBe(
      'Ocurrió un error inesperado. Intenta de nuevo.',
    );
  });

  it('platformErrorText handles a non-ApiError throw without leaking it', () => {
    expect(platformErrorText(new TypeError('boom'))).toBe('Ocurrió un error inesperado. Intenta de nuevo.');
    expect(platformErrorText(new ApiError(403, 'NOT_PLATFORM_ADMIN'))).toContain('consola de plataforma');
  });
});

describe('formatMonthCO', () => {
  it('renders YYYY-MM as es-CO prose', () => {
    expect(formatMonthCO('2026-08')).toBe('agosto de 2026');
    expect(formatMonthCO('2026-01')).toBe('enero de 2026');
    expect(formatMonthCO('2025-12')).toBe('diciembre de 2025');
  });

  it('does not slip a month backwards for a UTC-05:00 reader', () => {
    // `new Date('2026-08')` is UTC midnight, which is July 31 in Colombia.
    expect(formatMonthCO('2026-08')).not.toContain('julio');
  });

  it('returns anything malformed untouched rather than "Invalid Date"', () => {
    expect(formatMonthCO('')).toBe('');
    expect(formatMonthCO('2026-13')).toBe('2026-13');
    expect(formatMonthCO('agosto')).toBe('agosto');
  });
});

describe('vocabulary', () => {
  it('labels every plan and status in es-CO', () => {
    expect(PLAN_LABELS).toEqual({ basico: 'Básico', pro: 'Pro', premium: 'Premium' });
    expect(TENANT_STATUS_LABELS).toEqual({
      draft: 'En configuración',
      live: 'Activa',
      suspended: 'Suspendida',
    });
  });

  it('badges a suspended tenant destructively — an offline store must not read as neutral', () => {
    expect(TENANT_STATUS_BADGE.suspended).toBe('destructive');
    expect(TENANT_STATUS_BADGE.live).not.toBe('destructive');
  });

  it('keeps the healthy majority quiet so the exceptions are what stand out', () => {
    // A console listing forty live stores must not paint forty accent-coloured
    // pills; the states worth stopping on are the other two.
    expect(TENANT_STATUS_BADGE.live).toBe('secondary');
    expect(TENANT_STATUS_BADGE.draft).not.toBe('secondary');
    expect(TENANT_STATUS_BADGE.suspended).not.toBe('secondary');
  });

  it('builds detail links under the platform prefix, never under a merchant route', () => {
    expect(platformTenantPath('abc-123')).toBe('/plataforma/abc-123');
  });
});
