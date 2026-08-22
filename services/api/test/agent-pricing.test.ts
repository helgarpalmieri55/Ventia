import { describe, expect, it } from 'vitest';
import {
  CACHE_READ_PRICE_ENV,
  CACHE_WRITE_PRICE_ENV,
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
    expect(agentPricing(priced)).toMatchObject({ inputUsdPerMTok: 3, outputUsdPerMTok: 15 });
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

  it('falls back to the BASE INPUT rate for cache traffic, never to a guessed ratio', () => {
    // A cache read is never dearer than a fresh read, so this fallback can only
    // OVERSTATE cost. That direction is the whole point: an operator who
    // configures nothing gets a conservative figure and can only be pleasantly
    // surprised by the invoice. Applying a published discount ratio here would
    // be this module inventing a price — the one thing it exists not to do —
    // and being wrong in the cheap direction reports a margin nobody has.
    expect(agentPricing(priced)).toEqual({
      inputUsdPerMTok: 3,
      outputUsdPerMTok: 15,
      cacheWriteUsdPerMTok: 3,
      cacheReadUsdPerMTok: 3,
    });
  });

  it('uses the real cache rates when the operator supplies them', () => {
    expect(
      agentPricing({ ...priced, [CACHE_WRITE_PRICE_ENV]: '3.75', [CACHE_READ_PRICE_ENV]: '0.30' }),
    ).toMatchObject({ cacheWriteUsdPerMTok: 3.75, cacheReadUsdPerMTok: 0.3 });
  });

  it('does not let an unusable cache rate silently become zero', () => {
    // `Number('')` is 0. A cache rate that parsed to zero would report every
    // cached turn as free, which is the same class of bug as the dead column.
    expect(agentPricing({ ...priced, [CACHE_READ_PRICE_ENV]: 'gratis' })).toMatchObject({
      cacheReadUsdPerMTok: 3,
    });
    expect(agentPricing({ ...priced, [CACHE_READ_PRICE_ENV]: '' })).toMatchObject({ cacheReadUsdPerMTok: 3 });
    // Both halves, not just the read side: an unparseable write rate coerced
    // to NaN would make every priced turn NaN and wipe out the month's total.
    expect(agentPricing({ ...priced, [CACHE_WRITE_PRICE_ENV]: 'gratis' })).toMatchObject({
      cacheWriteUsdPerMTok: 3,
    });
    expect(agentPricing({ ...priced, [CACHE_WRITE_PRICE_ENV]: '-1' })).toMatchObject({
      cacheWriteUsdPerMTok: 3,
    });
  });

  it('accepts a genuine zero, which is not the same as unset', () => {
    // A negotiated or promotional zero rate is a real price. Treating it as
    // "unconfigured" would hide a tenant's usage rather than report it as free.
    expect(agentPricing({ [INPUT_PRICE_ENV]: '0', [OUTPUT_PRICE_ENV]: '0' })).toEqual({
      inputUsdPerMTok: 0,
      outputUsdPerMTok: 0,
      cacheWriteUsdPerMTok: 0,
      cacheReadUsdPerMTok: 0,
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
    expect(priceMicroUsd({ inputTokens: 1, outputTokens: 0 }, { inputUsdPerMTok: 3.6, outputUsdPerMTok: 0, cacheWriteUsdPerMTok: 0, cacheReadUsdPerMTok: 0 })).toBe(4);
    expect(priceMicroUsd({ inputTokens: 1, outputTokens: 0 }, { inputUsdPerMTok: 3.4, outputUsdPerMTok: 0, cacheWriteUsdPerMTok: 0, cacheReadUsdPerMTok: 0 })).toBe(3);
  });

  it('charges cache traffic at its own rates', () => {
    const pricing = agentPricing({ ...priced, [CACHE_WRITE_PRICE_ENV]: '3.75', [CACHE_READ_PRICE_ENV]: '0.3' })!;
    // 1000 fresh input @ $3 = 3000 micro; 8000 cache reads @ $0.30 = 2400;
    // 2000 cache writes @ $3.75 = 7500; 500 output @ $15 = 7500. Total 20400.
    expect(
      priceMicroUsd(
        { inputTokens: 1000, outputTokens: 500, cacheWriteTokens: 2000, cacheReadTokens: 8000 },
        pricing,
      ),
    ).toBe(20_400);
  });

  it('prices a cached turn well below the same turn uncached', () => {
    // The saving this change exists to produce, stated as an assertion rather
    // than assumed: 9000 tokens read from cache must not cost what 9000 fresh
    // input tokens cost.
    const pricing = agentPricing({ ...priced, [CACHE_READ_PRICE_ENV]: '0.3' })!;
    const cached = priceMicroUsd({ inputTokens: 1000, outputTokens: 0, cacheReadTokens: 9000 }, pricing)!;
    const uncached = priceMicroUsd({ inputTokens: 10_000, outputTokens: 0 }, pricing)!;
    expect(cached).toBeLessThan(uncached);
  });

  it('ignores absent cache counts, so a pre-caching caller needs no change', () => {
    const pricing = agentPricing(priced)!;
    expect(priceMicroUsd({ inputTokens: 1000, outputTokens: 500 }, pricing)).toBe(
      priceMicroUsd({ inputTokens: 1000, outputTokens: 500, cacheWriteTokens: 0, cacheReadTokens: 0 }, pricing),
    );
  });

  it('charges input and output at their own rates', () => {
    // Swapping the two rates must change the answer — output is the expensive
    // side, and pricing it as input understates every bill.
    const swapped = { inputUsdPerMTok: 15, outputUsdPerMTok: 3, cacheWriteUsdPerMTok: 15, cacheReadUsdPerMTok: 15 };
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

describe('agentModel', () => {
  it('defaults to the model of record when unset', async () => {
    const { AGENT_MODEL_ENV, DEFAULT_MODEL, agentModel } = await import('../src/agent/agent.service');
    expect(agentModel({})).toBe(DEFAULT_MODEL);
    expect(agentModel({ [AGENT_MODEL_ENV]: '' })).toBe(DEFAULT_MODEL);
    expect(agentModel({ [AGENT_MODEL_ENV]: '   ' })).toBe(DEFAULT_MODEL);
  });

  it('lets an operator move tiers without a code change', async () => {
    // The single largest lever on what this product costs to run. Someone
    // watching the OPS feed's cost figures has to be able to try a cheaper
    // tier, measure it, and move back — none of which should need a deploy.
    const { AGENT_MODEL_ENV, agentModel } = await import('../src/agent/agent.service');
    expect(agentModel({ [AGENT_MODEL_ENV]: 'claude-haiku-4-5-20251001' })).toBe('claude-haiku-4-5-20251001');
  });
});
