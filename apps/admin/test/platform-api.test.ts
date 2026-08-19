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
  parseSubscriptionForm,
  subscriptionDueNotice,
  subscriptionFormValues,
  subscriptionSaveNotice,
  suspendConfirmationMatches,
  suspendConfirmationToken,
  type PlatformAiUsage,
  type PlatformSubscription,
  type SetStatusResult,
  type SubscriptionFormValues,
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

// ---- subscription ---------------------------------------------------

/**
 * A subscription exactly as the API returns one. Every default here was read
 * off a direct run of `subscriptionWindow` from
 * `services/api/src/platform/subscription-window.ts` for
 * `paidUntil = 2026-09-01` (Bogotá) with the default 7-day grace, so these
 * fixtures are the real wire values rather than plausible-looking ones.
 */
function subscription(overrides: Partial<PlatformSubscription> = {}): PlatformSubscription {
  return {
    plan: 'pro',
    priceCents: 8900000,
    paidUntil: '2026-09-02T04:59:59.999Z',
    notes: null,
    updatedAt: '2026-08-19T15:00:00.000Z',
    dueState: 'al_dia',
    suspendsOn: '2026-09-09T04:59:59.999Z',
    warnsOn: '2026-09-06T04:59:59.999Z',
    daysPastDue: 0,
    graceDays: 7,
    ...overrides,
  };
}

describe('subscriptionDueNotice', () => {
  it('names the server-computed suspension day, in Bogotá time', () => {
    // `suspendsOn` is 2026-09-09T04:59:59.999Z, which is the EIGHTH in
    // Colombia. This is the assertion that keeps the console from telling an
    // operator the wrong day for a store going offline.
    const notice = subscriptionDueNotice(subscription());
    expect(notice.variant).toBe('success');
    expect(notice.text).toContain('el 8 de septiembre de 2026');
  });

  it('quotes the deployment’s grace window instead of assuming seven days', () => {
    // The whole reason `graceDays` is on the wire. A deployment with
    // SUBSCRIPTION_GRACE_DAYS=14 must not be described as having 7.
    const notice = subscriptionDueNotice(
      subscription({ graceDays: 14, suspendsOn: '2026-09-16T04:59:59.999Z' }),
    );
    expect(notice.text).toContain('14 días de gracia');
    // 2026-09-16T04:59:59.999Z is the FIFTEENTH in Bogotá — the same one-day
    // shift this whole surface is built to avoid.
    expect(notice.text).toContain('el 15 de septiembre de 2026');
    expect(notice.text).not.toContain('7 días');
  });

  it('says nothing about suspension when there is no date on file', () => {
    const notice = subscriptionDueNotice(
      subscription({ paidUntil: null, dueState: 'sin_fecha', suspendsOn: null, warnsOn: null }),
    );
    expect(notice.variant).toBe('info');
    expect(notice.text).toContain('Sin fecha de pago registrada');
  });

  it('reads "hoy" rather than "hace 0 días" on the day it lapses', () => {
    const notice = subscriptionDueNotice(subscription({ dueState: 'vencida', daysPastDue: 0 }));
    expect(notice.text).toContain('Venció hoy');
    expect(notice.text).not.toContain('0 días');
  });

  it('singularises one day', () => {
    const notice = subscriptionDueNotice(subscription({ dueState: 'vencida', daysPastDue: 1 }));
    expect(notice.text).toContain('hace 1 día.');
  });

  it('escalates to warning once the notice period has started', () => {
    const notice = subscriptionDueNotice(subscription({ dueState: 'por_suspender', daysPastDue: 4 }));
    expect(notice.variant).toBe('warning');
    expect(notice.text).toContain('hace 4 días');
  });

  it('escalates to error past the grace window', () => {
    const notice = subscriptionDueNotice(subscription({ dueState: 'suspendible', daysPastDue: 7 }));
    expect(notice.variant).toBe('error');
    expect(notice.text).toContain('pasó la ventana de gracia');
  });

  it('degrades to a date-less sentence instead of rendering "el null"', () => {
    const notice = subscriptionDueNotice(subscription({ suspendsOn: null }));
    expect(notice.text).toContain('al terminar la ventana de gracia');
    expect(notice.text).not.toContain('null');
  });
});

describe('subscriptionSaveNotice', () => {
  it('warns that recording a payment did NOT reactivate a suspended store', () => {
    // The reason `tenantStatus` is in the PUT response at all. An operator who
    // records "pagado hasta el 30 de septiembre" on a suspended tenant has
    // done half a job and nothing else on screen would tell them so.
    const notice = subscriptionSaveNotice({
      tenantId: 't1',
      tenantStatus: 'suspended',
      subscription: subscription(),
    });
    expect(notice.variant).toBe('warning');
    expect(notice.text).toContain('sigue suspendida');
    expect(notice.text).toContain('no la reactiva');
  });

  it('confirms plainly, with the new suspension date, for a live store', () => {
    const notice = subscriptionSaveNotice({
      tenantId: 't1',
      tenantStatus: 'live',
      subscription: subscription(),
    });
    expect(notice.variant).toBe('success');
    expect(notice.text).toContain('Suscripción guardada');
    expect(notice.text).toContain('8 de septiembre de 2026');
  });

  it('does not claim a draft tenant is suspended', () => {
    const notice = subscriptionSaveNotice({
      tenantId: 't1',
      tenantStatus: 'draft',
      subscription: subscription(),
    });
    expect(notice.variant).toBe('success');
  });
});

describe('subscriptionFormValues', () => {
  it('seeds from the row on file, in pesos and in the Bogotá calendar day', () => {
    expect(subscriptionFormValues(subscription({ notes: '  factura 0142 ' }), 'basico')).toEqual({
      plan: 'pro',
      price: '89000',
      paidUntil: '2026-09-01',
      notes: '  factura 0142 ',
    });
  });

  it('falls back to the tenant’s assigned plan when there is no subscription', () => {
    expect(subscriptionFormValues(null, 'premium')).toEqual({
      plan: 'premium',
      price: '',
      paidUntil: '',
      notes: '',
    });
  });

  it('leaves price blank rather than defaulting to 0, which is a real value here', () => {
    // A comped or pilot account is legitimately priced at 0 and the API
    // accepts it — so 0 has to be typed on purpose, not pre-filled.
    expect(subscriptionFormValues(null, 'basico').price).toBe('');
    expect(subscriptionFormValues(subscription({ priceCents: 0 }), 'basico').price).toBe('0');
  });

  it('shows an empty date field for a subscription with no paid-until', () => {
    expect(subscriptionFormValues(subscription({ paidUntil: null }), 'basico').paidUntil).toBe('');
  });
});

describe('parseSubscriptionForm', () => {
  function values(overrides: Partial<SubscriptionFormValues> = {}): SubscriptionFormValues {
    return { plan: 'pro', price: '89000', paidUntil: '2026-09-01', notes: '', ...overrides };
  }

  it('sends pesos as cents and the date as the plain Bogotá calendar day', () => {
    const parsed = parseSubscriptionForm(values());
    expect(parsed).toEqual({
      ok: true,
      body: { plan: 'pro', priceCents: 8900000, paidUntil: '2026-09-01', notes: null },
    });
  });

  it('turns an empty date into an explicit null, not an omission', () => {
    // PUT carries the whole resource; there is no "leave it alone". Sending
    // the field as null is how "no payment on record" is recorded on purpose.
    const parsed = parseSubscriptionForm(values({ paidUntil: '' }));
    expect(parsed.ok && parsed.body.paidUntil).toBeNull();
  });

  it('accepts a price of zero', () => {
    const parsed = parseSubscriptionForm(values({ price: '0' }));
    expect(parsed.ok && parsed.body.priceCents).toBe(0);
  });

  it('rejects a blank, negative or non-numeric price with a field error', () => {
    for (const price of ['', '   ', '-1', 'gratis']) {
      const parsed = parseSubscriptionForm(values({ price }));
      expect(parsed.ok).toBe(false);
      expect(!parsed.ok && parsed.errors.price).toBeTruthy();
    }
  });

  it('rejects a price above the API ceiling instead of taking a 400 for it', () => {
    const parsed = parseSubscriptionForm(values({ price: '10000001' }));
    expect(!parsed.ok && parsed.errors.price).toBeTruthy();
    // One peso under the ceiling is fine.
    expect(parseSubscriptionForm(values({ price: '10000000' })).ok).toBe(true);
  });

  it('rejects a day that does not exist rather than letting it roll forward', () => {
    // `new Date('2026-02-31T00:00:00Z')` silently becomes 3 March. On THIS
    // field that would mean a store staying online two days longer than
    // anyone agreed, from a typo nobody was told about.
    const parsed = parseSubscriptionForm(values({ paidUntil: '2026-02-31' }));
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.errors.paidUntil).toBeTruthy();
  });

  it('rejects malformed dates and out-of-range years', () => {
    for (const paidUntil of ['01/09/2026', '2026-9-1', '1999-09-01', '2200-09-01']) {
      expect(parseSubscriptionForm(values({ paidUntil })).ok).toBe(false);
    }
  });

  it('accepts a real leap day', () => {
    expect(parseSubscriptionForm(values({ paidUntil: '2028-02-29' })).ok).toBe(true);
    expect(parseSubscriptionForm(values({ paidUntil: '2026-02-29' })).ok).toBe(false);
  });

  it('trims notes and sends an empty note as null', () => {
    expect(parseSubscriptionForm(values({ notes: '  factura 0142  ' }))).toEqual({
      ok: true,
      body: { plan: 'pro', priceCents: 8900000, paidUntil: '2026-09-01', notes: 'factura 0142' },
    });
    const blank = parseSubscriptionForm(values({ notes: '   ' }));
    expect(blank.ok && blank.body.notes).toBeNull();
  });

  it('rejects a note past the API limit', () => {
    const parsed = parseSubscriptionForm(values({ notes: 'x'.repeat(1001) }));
    expect(!parsed.ok && parsed.errors.notes).toBeTruthy();
    expect(parseSubscriptionForm(values({ notes: 'x'.repeat(1000) })).ok).toBe(true);
  });

  it('reports every bad field at once rather than one per submit', () => {
    const parsed = parseSubscriptionForm(values({ price: 'gratis', paidUntil: '2026-02-31' }));
    expect(!parsed.ok && Object.keys(parsed.errors).sort()).toEqual(['paidUntil', 'price']);
  });
});
