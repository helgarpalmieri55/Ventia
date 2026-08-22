import { describe, expect, it } from 'vitest';
import { OVERAGE_CEILING_MULTIPLIER, PLANS } from '@ventia/core';
import {
  asistenteAviso,
  consumoBarras,
  consumoEstado,
  consumoResumen,
  consumoTono,
  lineasConsumo,
  mesLargo,
  preguntasRestantes,
  reglaTope,
  type CreditsUsage,
} from '../lib/agent-usage-api';

/**
 * The consumption screen's judgement, tested where it lives: in pure
 * functions, with no React and no network.
 *
 * What these tests are really protecting is one promise. Reaching the plan
 * allowance no longer silences the agent — credits past it are billed as
 * overage — so this screen is the ONLY place a merchant can find out they are
 * spending more than they planned. Every assertion below is either "the
 * merchant is told the truth about their money" or "the merchant is not made
 * to think their store is broken when it is selling".
 */

/** A month's usage, shaped like the API's `credits` block. `plan` sets the
 * allowance from the real plan table so the numbers here are numbers a store
 * can actually have. */
function usage(over: Partial<CreditsUsage> & { used: number; limit?: number }): CreditsUsage {
  const limit = over.limit ?? PLANS.emprende.aiCreditsMonth;
  const ceiling = limit * OVERAGE_CEILING_MULTIPLIER;
  const reserve = Math.ceil(limit * 0.2);
  const base: CreditsUsage = {
    used: over.used,
    limit,
    remaining: Math.max(0, limit - over.used),
    overage: Math.max(0, over.used - limit),
    ceiling,
    ceilingMultiplier: OVERAGE_CEILING_MULTIPLIER,
    warning: limit > 0 && over.used >= Math.floor(limit * 0.8),
    allowed: over.used < ceiling,
    percentUsed: limit > 0 ? Math.round((over.used / limit) * 100) : null,
    cost: { shopperMessage: 1, merchantQuery: 2 },
    breakdown: { shopperTurns: over.used, merchantQueries: 0 },
    merchantAssistant: {
      reserve,
      remaining: Math.max(0, limit - reserve - over.used),
      pausedReason: null,
    },
  };
  return { ...base, ...over, limit };
}

describe('consumoEstado', () => {
  it('reads a quiet month as normal', () => {
    expect(consumoEstado(usage({ used: 100 }))).toBe('normal');
  });

  it('raises the aviso at 80%, not at 100%', () => {
    // The warning moved earlier precisely because it now warns about money
    // about to be spent rather than about a wall about to be hit.
    expect(consumoEstado(usage({ used: 399 }))).toBe('normal');
    expect(consumoEstado(usage({ used: 400 }))).toBe('aviso');
  });

  it('calls a store exactly on its allowance normal-with-a-warning, never excedente', () => {
    // 500 of 500 has spent nothing extra yet. Announcing an overage of zero
    // would charge the merchant, in their head, for money they have not spent.
    const atLimit = usage({ used: 500 });
    expect(atLimit.overage).toBe(0);
    expect(consumoEstado(atLimit)).toBe('aviso');
  });

  it('switches to excedente on the first credit past the allowance', () => {
    expect(consumoEstado(usage({ used: 501 }))).toBe('excedente');
  });

  it('lets tope win over excedente — a stopped agent is not merely "over"', () => {
    // At 3x the allowance the agent really has stopped. Reporting only
    // "excedente" here would tell a merchant whose shop is silent that
    // everything is still being answered.
    const stopped = usage({ used: 1_500 });
    expect(stopped.allowed).toBe(false);
    expect(stopped.overage).toBeGreaterThan(0);
    expect(consumoEstado(stopped)).toBe('tope');
  });

  it('lets excedente win over aviso — the money is already spent, not approaching', () => {
    const over = usage({ used: 700 });
    expect(over.warning).toBe(true);
    expect(consumoEstado(over)).toBe('excedente');
  });

  it('calls an unprovisioned store sin_plan rather than 0% of nothing', () => {
    // A limit of 0 is what AgentBudgetService treats as "not provisioned",
    // which it enforces as no agent at all. "0% usado" would read as healthy.
    expect(consumoEstado(usage({ used: 0, limit: 0 }))).toBe('sin_plan');
  });
});

describe('consumoTono', () => {
  it('never paints excedente as a warning or an error', () => {
    // THE rule of this screen. A store paying overage is a store selling more
    // than its plan assumed, with the agent still answering. Amber teaches the
    // merchant to fear their best week; red says something broke.
    expect(consumoTono('excedente')).toBe('info');
  });

  it('reserves error for the two states where the agent is genuinely not talking', () => {
    expect(consumoTono('tope')).toBe('error');
    expect(consumoTono('sin_plan')).toBe('error');
  });

  it('keeps the 80% nudge amber and a healthy month quiet', () => {
    expect(consumoTono('aviso')).toBe('warning');
    expect(consumoTono('ok' === 'ok' ? 'normal' : 'normal')).toBe('ok');
  });
});

describe('consumoResumen', () => {
  it('tells a merchant in overage that the agent kept working', () => {
    const r = consumoResumen(usage({ used: 640 }));
    expect(r.estado).toBe('excedente');
    expect(r.titulo).toContain('140 créditos');
    expect(r.detalle).toContain('no se apagó');
    // The bill is named. A merchant who finds out from the invoice instead of
    // from this screen is the failure the whole page exists to prevent.
    expect(r.detalle).toContain('excedente');
  });

  it('warns at 80% about a cost, not about a shutdown', () => {
    const r = consumoResumen(usage({ used: 400 }));
    expect(r.titulo).toContain('80%');
    expect(r.detalle).toContain('NO se apaga');
  });

  it('promises the normal month that hitting the cupo will not mute the store', () => {
    const r = consumoResumen(usage({ used: 50 }));
    expect(r.titulo).toContain('450 créditos');
    expect(r.detalle).toContain('sigue atendiendo');
  });

  it('says plainly that the agent has stopped once the tope is reached', () => {
    const r = consumoResumen(usage({ used: 1_500 }));
    expect(r.estado).toBe('tope');
    expect(r.detalle).toContain('dejó de responder');
    // And why: 3x is a runaway-spend backstop, not the plan's limit.
    expect(r.detalle).toContain(`${OVERAGE_CEILING_MULTIPLIER} veces tu cupo`);
  });

  it('says "1 crédito" and not "1 créditos"', () => {
    expect(consumoResumen(usage({ used: 499 })).titulo).toContain('quedan 1 crédito.');
    expect(consumoResumen(usage({ used: 501 })).titulo).toContain('1 crédito por encima');
  });

  it('never tells an unprovisioned store a percentage', () => {
    const r = consumoResumen(usage({ used: 0, limit: 0 }));
    expect(r.titulo).not.toMatch(/\d+%/);
    expect(r.detalle).toContain('plan');
  });
});

describe('consumoBarras', () => {
  it('fills the allowance bar proportionally below the cupo', () => {
    expect(consumoBarras(usage({ used: 250 })).cupoPercent).toBe(50);
  });

  it('pins the allowance bar at 100 rather than overflowing it', () => {
    expect(consumoBarras(usage({ used: 900 })).cupoPercent).toBe(100);
  });

  it('scales the overage bar against the room between the cupo and the tope', () => {
    // 500-credit plan: 1000 credits of room before the agent stops. 250 over
    // is a quarter of the way there — NOT "50% used" and not "150% of plan",
    // both of which a single bar would have to claim.
    const barras = consumoBarras(usage({ used: 750 }));
    expect(barras.margenExcedente).toBe(1_000);
    expect(barras.excedentePercent).toBe(25);
  });

  it('leaves the overage bar empty when there is no overage', () => {
    expect(consumoBarras(usage({ used: 400 })).excedentePercent).toBe(0);
  });

  it('fills the overage bar exactly at the tope', () => {
    expect(consumoBarras(usage({ used: 1_500 })).excedentePercent).toBe(100);
  });

  it('divides by nothing for an unprovisioned store', () => {
    const barras = consumoBarras(usage({ used: 0, limit: 0 }));
    expect(barras.cupoPercent).toBe(0);
    expect(barras.excedentePercent).toBe(0);
    expect(barras.margenExcedente).toBe(0);
  });
});

describe('asistenteAviso', () => {
  it('says the customers are still being served when the reserve kicks in', () => {
    // The single most important sentence on the page. The merchant assistant
    // stops at cupo - 20% while the storefront keeps the full allowance, so
    // the merchant's own questions are refused while credits visibly remain.
    // Without this the only available reading is "se cayó la tienda".
    const aviso = asistenteAviso(
      usage({ used: 400, merchantAssistant: { reserve: 100, remaining: 0, pausedReason: 'shopper_reserve' } }),
    );
    expect(aviso.titulo).toContain('Tus clientes siguen atendidos');
    expect(aviso.detalle).toContain('no se cayó');
    expect(aviso.detalle).toContain('100 créditos');
    // Never red: nothing is broken and the merchant did nothing wrong.
    expect(aviso.tono).toBe('info');
  });

  it('does not claim a courtesy reserve once the whole allowance is gone', () => {
    // There is no reserve left to protect, and shoppers are being answered on
    // overage. Saying "lo estoy guardando para tus clientes" would be a lie
    // the merchant could check.
    const aviso = asistenteAviso(
      usage({ used: 520, merchantAssistant: { reserve: 100, remaining: 0, pausedReason: 'exhausted' } }),
    );
    expect(aviso.titulo).toContain('Tus clientes siguen atendidos');
    expect(aviso.detalle).toContain('excedente');
    expect(aviso.detalle).not.toContain('reservad');
  });

  it('counts the merchant remainder in questions, not in credits', () => {
    // The API reports credits and a question costs two. Printing the credit
    // figure under the word "preguntas" promises exactly twice as many
    // questions as the merchant gets.
    const credits = usage({ used: 100, merchantAssistant: { reserve: 100, remaining: 61, pausedReason: null } });
    expect(preguntasRestantes(credits)).toBe(30);
    expect(asistenteAviso(credits).titulo).toContain('30 preguntas');
  });

  it('says "1 pregunta" in the singular', () => {
    const credits = usage({ used: 100, merchantAssistant: { reserve: 100, remaining: 2, pausedReason: null } });
    expect(asistenteAviso(credits).titulo).toContain('queda 1 pregunta');
  });

  it('explains the 2-credit price rather than leaving it to be discovered', () => {
    const credits = usage({ used: 10, merchantAssistant: { reserve: 100, remaining: 200, pausedReason: null } });
    expect(asistenteAviso(credits).detalle).toContain('2 créditos');
  });
});

describe('lineasConsumo', () => {
  it('splits the month into shopper turns and merchant questions, priced', () => {
    const lineas = lineasConsumo(
      usage({ used: 140, breakdown: { shopperTurns: 100, merchantQueries: 20 } }),
    );
    expect(lineas.map((l) => [l.cantidad, l.precio, l.creditos])).toEqual([
      [100, 1, 100],
      [20, 2, 40],
    ]);
  });

  it('adds up to the credits actually consumed', () => {
    // The property the table is read for: if these two lines do not sum to
    // `used`, the merchant is looking at an explanation of a different month.
    const credits = usage({ used: 140, breakdown: { shopperTurns: 100, merchantQueries: 20 } });
    expect(lineasConsumo(credits).reduce((sum, l) => sum + l.creditos, 0)).toBe(credits.used);
  });
});

describe('mesLargo', () => {
  it('renders the month key as a merchant reads it', () => {
    expect(mesLargo('2026-08')).toBe('agosto de 2026');
  });

  it('does not slip a month backwards for a merchant west of Greenwich', () => {
    // `new Date('2026-01')` is UTC midnight; formatted in Bogotá it is 31
    // December. Every merchant this product has would see the wrong month.
    expect(mesLargo('2026-01')).toBe('enero de 2026');
  });

  it('falls back to the raw key rather than rendering nonsense', () => {
    expect(mesLargo('2026-13')).toBe('2026-13');
  });
});

describe('reglaTope', () => {
  it('states the ceiling in the same multiple the API enforces', () => {
    expect(reglaTope(500)).toContain(`${OVERAGE_CEILING_MULTIPLIER} veces`);
    expect(reglaTope(500)).toContain(`${500 * OVERAGE_CEILING_MULTIPLIER} créditos`);
  });
});
