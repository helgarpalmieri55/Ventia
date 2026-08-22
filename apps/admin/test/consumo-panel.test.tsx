import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { OVERAGE_CEILING_MULTIPLIER } from '@ventia/core';
import { ConsumoPanel } from '../components/consumo-panel';
import type { CreditsUsage } from '../lib/agent-usage-api';

/**
 * What the merchant actually sees, rendered.
 *
 * `lib/agent-usage-api.test.ts` pins the words and the thresholds; this file
 * pins the two things only the rendering can get wrong: the COLOUR the
 * overage state is painted in, and whether the second bar exists at all. Both
 * are decisions a future edit could quietly reverse without failing a single
 * copy assertion.
 */

function usage(over: Partial<CreditsUsage> & { used: number }): CreditsUsage {
  const limit = over.limit ?? 500;
  return {
    used: over.used,
    limit,
    remaining: Math.max(0, limit - over.used),
    overage: Math.max(0, over.used - limit),
    ceiling: limit * OVERAGE_CEILING_MULTIPLIER,
    ceilingMultiplier: OVERAGE_CEILING_MULTIPLIER,
    warning: limit > 0 && over.used >= Math.floor(limit * 0.8),
    allowed: over.used < limit * OVERAGE_CEILING_MULTIPLIER,
    percentUsed: limit > 0 ? Math.round((over.used / limit) * 100) : null,
    cost: { shopperMessage: 1, merchantQuery: 2 },
    breakdown: { shopperTurns: over.used, merchantQueries: 0 },
    merchantAssistant: { reserve: Math.ceil(limit * 0.2), remaining: 100, pausedReason: null },
    ...over,
  };
}

const render = (credits: CreditsUsage, mostrarAsistente = true) =>
  renderToStaticMarkup(React.createElement(ConsumoPanel, { credits, mostrarAsistente }));

describe('ConsumoPanel', () => {
  it('never paints the overage state in the destructive colour', () => {
    // The load-bearing visual decision on this screen. A merchant paying
    // overage has done nothing wrong — their store outsold the plan and the
    // agent kept answering — and a red panel says something broke.
    const html = render(usage({ used: 640 }));
    expect(html).toContain('140 créditos por encima');
    expect(html).not.toContain('bg-destructive');
    expect(html).not.toContain('text-amber');
  });

  it('does paint the tope state destructively — there the agent really has stopped', () => {
    const html = render(usage({ used: 1_500 }));
    expect(html).toContain('bg-destructive');
  });

  it('draws no overage bar when there is no overage', () => {
    // An empty second bar every month would read as a second quota to worry
    // about, for something that never happens to almost any store.
    const html = render(usage({ used: 200 }));
    expect(html).not.toContain('Excedente');
  });

  it('draws the overage bar against the room left before the agent stops', () => {
    const html = render(usage({ used: 750 }));
    expect(html).toContain('Excedente');
    expect(html).toContain('250 de 1000 créditos');
  });

  it('gives both bars an accessible progressbar role with a real value', () => {
    const html = render(usage({ used: 250 }));
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="50"');
    expect(html).toContain('aria-label="Tu cupo del mes"');
  });

  it('shows no banner at all on a healthy month', () => {
    // A permanent "vas bien" banner is noise the merchant learns to skip,
    // which is exactly what makes the amber one invisible when it matters.
    const html = render(usage({ used: 50 }));
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain('bg-amber');
  });

  it('says the customers are still served when the merchant assistant is paused', () => {
    const html = render(
      usage({ used: 400, merchantAssistant: { reserve: 100, remaining: 0, pausedReason: 'shopper_reserve' } }),
    );
    expect(html).toContain('Tus clientes siguen atendidos');
  });

  it('leaves the assistant notice out when the caller asks it to', () => {
    // Configuración → Asistente IA is about the SHOPPER agent's tone; why the
    // owner's own questions are paused is a digression there.
    const html = render(
      usage({ used: 400, merchantAssistant: { reserve: 100, remaining: 0, pausedReason: 'shopper_reserve' } }),
      false,
    );
    expect(html).not.toContain('Tus clientes siguen atendidos');
  });
});
