import { describe, expect, it } from 'vitest';
import {
  INPUT_PRICE_ENV,
  OUTPUT_PRICE_ENV,
  agentPricing,
  microUsdToCents,
  priceMicroUsd,
} from '../src/agent/agent-pricing';

/**
 * Model pricing, driven directly.
 *
 * The behaviour under test is mostly about REFUSING to produce a number. The
 * bug this whole module exists to prevent already happened once: `costCents`
 * was a column nothing wrote, and the operator console read it and reported
 * every tenant on the platform as costing exactly zero. A confident wrong
 * figure is worse than an absent one, so every path that cannot compute a real
 * cost has to return null rather than fall back to 0.
 */

const priced = { [INPUT_PRICE_ENV]: '3', [OUTPUT_PRICE_ENV]: '15' };

describe('agentPricing', () => {
  it('reads both prices when both are set', () => {
    expect(agentPricing(priced)).toEqual({ inputUsdPerMTok: 3, outputUsdPerMTok: 15 });
  });

  it('refuses a half-configured pair', () => {
    // Accepting one and defaulting the other to zero would bill output tokens
    // at nothing — an error shaped exactly like a healthy margin.
    expect(agentPricing({ [INPUT_PRICE_ENV]: '3' })).toBeNull();
    expect(agentPricing({ [OUTPUT_PRICE_ENV]: '15' })).toBeNull();
    expect(agentPricing({})).toBeNull();
  });

  it('refuses values that are not usable prices', () => {
    expect(agentPricing({ ...priced, [INPUT_PRICE_ENV]: '' })).toBeNull();
    expect(agentPricing({ ...priced, [INPUT_PRICE_ENV]: '   ' })).toBeNull();
    expect(agentPricing({ ...priced, [INPUT_PRICE_ENV]: 'tres dólares' })).toBeNull();
    expect(agentPricing({ ...priced, [INPUT_PRICE_ENV]: '-3' })).toBeNull();
    expect(agentPricing({ ...priced, [OUTPUT_PRICE_ENV]: 'Infinity' })).toBeNull();
  });

  it('accepts a genuine zero, which is not the same as unset', () => {
    // A negotiated or promotional zero rate is a real price. Treating it as
    // "unconfigured" would hide a tenant's usage rather than report it as free.
    expect(agentPricing({ [INPUT_PRICE_ENV]: '0', [OUTPUT_PRICE_ENV]: '0' })).toEqual({
      inputUsdPerMTok: 0,
      outputUsdPerMTok: 0,
    });
  });
});

describe('priceMicroUsd', () => {
  it('prices a turn from both token counts', () => {
    // 1000 input @ $3/Mtok = $0.003; 500 output @ $15/Mtok = $0.0075.
    // Total $0.0105 = 10500 micro-USD.
    expect(priceMicroUsd({ inputTokens: 1000, outputTokens: 500 }, agentPricing(priced))).toBe(10_500);
  });

  it('returns null — never 0 — when prices are not configured', () => {
    // This is the whole point of the module. A caller that treats null as 0
    // reproduces the original bug; one that propagates it reports "unknown".
    expect(priceMicroUsd({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, null)).toBeNull();
  });

  it('keeps the precision a fraction of a cent needs', () => {
    // One small turn: 800 input, 120 output. In cents this rounds to 0 and
    // vanishes; in micro-USD it survives, which is why the column changed unit.
    const micro = priceMicroUsd({ inputTokens: 800, outputTokens: 120 }, agentPricing(priced));
    expect(micro).toBe(4200);
    expect(microUsdToCents(micro!)).toBe(0);
    // ...and a thousand of those turns is real money that did not get lost.
    expect(microUsdToCents(micro! * 1000)).toBe(420);
  });

  it('rounds the final figure rather than truncating it', () => {
    // 1 input token at $3.60/Mtok is 3.6 micro-USD. Truncating loses the
    // fraction on EVERY turn in the same direction, so a month of small turns
    // under-reports cost systematically rather than averaging out.
    expect(priceMicroUsd({ inputTokens: 1, outputTokens: 0 }, { inputUsdPerMTok: 3.6, outputUsdPerMTok: 0 })).toBe(4);
    expect(priceMicroUsd({ inputTokens: 1, outputTokens: 0 }, { inputUsdPerMTok: 3.4, outputUsdPerMTok: 0 })).toBe(3);
  });

  it('charges input and output at their own rates', () => {
    // Swapping the two rates must change the answer — output is the expensive
    // side, and pricing it as input understates every bill.
    const swapped = { inputUsdPerMTok: 15, outputUsdPerMTok: 3 };
    expect(priceMicroUsd({ inputTokens: 1000, outputTokens: 500 }, swapped)).toBe(16_500);
  });
});

describe('microUsdToCents', () => {
  it('rounds rather than truncates', () => {
    // 6000 micro-USD is 0.6 cents. Truncating reports a month that cost real
    // money as free.
    expect(microUsdToCents(6_000)).toBe(1);
    expect(microUsdToCents(4_000)).toBe(0);
    expect(microUsdToCents(1_234_567)).toBe(123);
  });
});
