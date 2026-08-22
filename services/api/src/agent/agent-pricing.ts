/**
 * What a model call costs, in millionths of a US dollar.
 *
 * ## Why the prices come from the environment and have no default
 *
 * This module deliberately ships with NO built-in price table. Model prices
 * change, differ between list price and whatever an account has actually
 * negotiated, and are the input to every margin decision the operator will
 * make. A hardcoded default would be wrong for somebody on day one and would
 * then be believed, because a number that renders looks like a measurement.
 *
 * So: unset prices mean cost is UNKNOWN, not zero. `priceMicroUsd` returns
 * `null`, `AgentUsage.costMicroUsd` stays at 0, and every reader is handed
 * `configured: false` so it can render "no configurado" instead of "$0". The
 * failure this exists to prevent is the one `costCents` already caused — a
 * column nothing wrote, read by an operator screen that reported every tenant
 * as free.
 *
 * ## Why per million tokens
 *
 * It is the unit model providers publish, so the operator copies a number off
 * a pricing page instead of converting it and getting the exponent wrong.
 *
 * ## Why micro-dollars out
 *
 * One shopper turn costs a small fraction of a cent. Cents round it to zero;
 * micro-dollars keep four more digits, and the accumulating column is a
 * BIGINT, so a busy month still adds up exactly.
 */

/** USD per 1,000,000 input tokens, e.g. `1.25`. */
export const INPUT_PRICE_ENV = 'AGENT_PRICE_INPUT_USD_PER_MTOK';
/** USD per 1,000,000 output tokens, e.g. `5.00`. */
export const OUTPUT_PRICE_ENV = 'AGENT_PRICE_OUTPUT_USD_PER_MTOK';
/** USD per 1,000,000 tokens WRITTEN into the prompt cache. Optional. */
export const CACHE_WRITE_PRICE_ENV = 'AGENT_PRICE_CACHE_WRITE_USD_PER_MTOK';
/** USD per 1,000,000 tokens READ from the prompt cache. Optional. */
export const CACHE_READ_PRICE_ENV = 'AGENT_PRICE_CACHE_READ_USD_PER_MTOK';

export interface AgentPricing {
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
  /** Cache rates. Both default to the BASE INPUT price when unset — see
   * {@link agentPricing} for why that direction and not the real ratios. */
  cacheWriteUsdPerMTok: number;
  cacheReadUsdPerMTok: number;
}

/**
 * The configured prices, or `null` when either is missing or unusable.
 *
 * BOTH or NEITHER, deliberately. A half-configured pair would silently bill
 * output tokens at zero, which understates cost by roughly the ratio between
 * the two prices — an error that looks like a healthy margin. Refusing the
 * pair makes the misconfiguration visible instead.
 *
 * A negative or non-finite value is treated as absent for the same reason: the
 * only thing worse than no cost figure is a confident wrong one.
 */
export function agentPricing(env: NodeJS.ProcessEnv = process.env): AgentPricing | null {
  const input = parsePrice(env[INPUT_PRICE_ENV]);
  const output = parsePrice(env[OUTPUT_PRICE_ENV]);
  if (input === null || output === null) return null;

  // The two cache rates are OPTIONAL, and an unset one falls back to the base
  // input price rather than to a hardcoded multiple of it.
  //
  // Providers do publish standard ratios (a cache read costs a fraction of a
  // fresh input token, a write slightly more than one), and applying them here
  // would produce a prettier number. It would also be this module inventing a
  // price, which is the one thing it exists not to do — and getting it wrong
  // in the cheap direction would report a margin the operator does not have.
  //
  // Falling back to the base input rate can only OVERSTATE cost, because a
  // cache read is never dearer than a fresh read. An operator who sets nothing
  // sees a conservative figure and can only be pleasantly surprised by the real
  // invoice; one who sets the real rates sees the truth. Neither ever believes
  // they are more profitable than they are.
  return {
    inputUsdPerMTok: input,
    outputUsdPerMTok: output,
    cacheWriteUsdPerMTok: parsePrice(env[CACHE_WRITE_PRICE_ENV]) ?? input,
    cacheReadUsdPerMTok: parsePrice(env[CACHE_READ_PRICE_ENV]) ?? input,
  };
}

function parsePrice(raw: string | undefined): number | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const value = Number(trimmed);
  // `Number('')` is 0 and `Number('abc')` is NaN — the empty case is already
  // handled above, and NaN/Infinity/negative are all refused here.
  if (!Number.isFinite(value) || value < 0) return null;
  return value;
}

/**
 * What one turn's tokens cost, in whole micro-USD, or `null` when prices are
 * not configured.
 *
 * Rounded (not truncated) at the very end rather than per token type, so the
 * two halves cannot each lose up to a micro-dollar. At these magnitudes that
 * is a rounding pedantry rather than real money; it costs nothing to be right.
 */
export function priceMicroUsd(
  tokens: TokenCounts,
  pricing: AgentPricing | null = agentPricing(),
): number | null {
  if (pricing === null) return null;
  const usd =
    (tokens.inputTokens * pricing.inputUsdPerMTok +
      tokens.outputTokens * pricing.outputUsdPerMTok +
      (tokens.cacheWriteTokens ?? 0) * pricing.cacheWriteUsdPerMTok +
      (tokens.cacheReadTokens ?? 0) * pricing.cacheReadUsdPerMTok) /
    1_000_000;
  return Math.round(usd * 1_000_000);
}

/** What one turn consumed. The cache halves are optional so a caller that
 * predates caching — or a turn whose prompt was too short to cache — needs no
 * change. */
export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens?: number;
  cacheReadTokens?: number;
}

/** Micro-USD to whole cents, for the operator views that still speak cents.
 * Rounds, so a month that cost 0.6 cents reports 1 rather than 0. */
export function microUsdToCents(microUsd: number): number {
  return Math.round(microUsd / 10_000);
}
