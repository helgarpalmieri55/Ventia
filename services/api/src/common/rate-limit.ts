import type { NextFunction, Request, Response } from 'express';
import type Redis from 'ioredis';

/**
 * Redis-backed request rate limiting, required by `docs/SPEC.md` §9
 * ("rate limiting (Redis) on auth, checkout, agent, webhooks"). All four are
 * wired in `main.ts`.
 *
 * The agent surface carries a SECOND limit that does not live here — a
 * per-conversation one, in `agent/agent-throttle.service.ts`. The two answer
 * different questions: this file bounds how much one ADDRESS can ask for,
 * which is what stops a script from opening ten thousand conversations; that
 * one bounds how fast a single CONVERSATION can spend the merchant's AI
 * budget, which is what an IP key cannot express when a whole carrier sits
 * behind one address.
 *
 * ## Express middleware, not a Nest guard
 *
 * `/v1/auth/*` is handled by better-auth's `toNodeHandler`, mounted directly on
 * the Express adapter BEFORE Nest routing (see main.ts) — a Nest guard never
 * runs for it. The auth endpoints are also the ones that most need limiting
 * (credential stuffing, signup spam, email-verification floods), so the limiter
 * has to live at the same layer they do.
 *
 * ## Fixed window, not a sliding log
 *
 * `INCR` + `EXPIRE` on one key per window: two O(1) commands, one round trip,
 * and nothing accumulates in Redis beyond a single integer per caller per
 * window. A sliding-window log (a sorted set of timestamps) is more precise at
 * the boundary — a caller can spend a full budget at the end of one window and
 * again at the start of the next, so the true worst case is 2× the limit over a
 * short span — but it stores one member per request, which is unbounded memory
 * driven by exactly the traffic a limiter exists to survive. For abuse control
 * the cruder bound is the right trade; the limits below are chosen with the 2×
 * boundary case in mind rather than in spite of it.
 *
 * ## Fail OPEN
 *
 * If Redis is unreachable or errors, the request proceeds. This is deliberate
 * and, for one route, essential: a rejected payment webhook is a settle that
 * did not happen, so a Redis outage must never turn into lost payments. It also
 * matches what this limiter is for — it is abuse control, not authorization.
 * Nothing here decides whether a caller is ALLOWED to do something, only
 * whether they are doing it too fast, and failing closed would convert a cache
 * outage into a total outage.
 */
export interface RateLimitOptions {
  /** Distinguishes one limiter's keyspace from another's, so the checkout
   * limiter and the auth limiter never share a counter. */
  name: string;
  /** Requests permitted per window, per key. */
  limit: number;
  windowSeconds: number;
  /**
   * What to count per. Returning `null` skips limiting entirely for that
   * request — used by the webhook limiter, which will not limit a request it
   * cannot attribute to a tenant rather than lumping every unattributable
   * delivery into one shared bucket.
   */
  key: (req: Request) => string | null;
  /** Body of the 429. Shaped like every other error this API returns. */
  errorCode: string;
}

/**
 * The client address to attribute a request to.
 *
 * Express's `req.ip` already honours the `trust proxy` setting configured in
 * main.ts, which is what makes this the real client address rather than the
 * reverse proxy's. That setting is load-bearing: without it every request
 * behind Caddy shares one address, so one abusive client would exhaust the
 * budget for everybody — a limiter that converts abuse into a global outage is
 * worse than no limiter.
 *
 * Falls back to a constant when the address is somehow absent (a socket that
 * has already gone away). That means such requests share one bucket, which is
 * acceptable precisely because it is the rare case, and the alternative —
 * skipping the limit — would hand an attacker a trivial bypass.
 */
export function clientIp(req: Request): string {
  return req.ip ?? req.socket?.remoteAddress ?? 'unknown';
}

/**
 * Per-limiter budgets, overridable by env.
 *
 * ## Why these numbers
 *
 * The keying is per-IP for auth and checkout, and a large share of Colombian
 * retail traffic is mobile — where carriers run CGNAT, so many unrelated
 * shoppers genuinely share one public address. A limit tuned as though one IP
 * meant one person would reject real customers during exactly the traffic
 * spike a merchant most wants (a promotion, a payday weekend). These are
 * therefore set to bound abuse rather than to be tight:
 *
 *  - `auth` 60/min — an attacker gets 60 attempts a minute from one address,
 *    which is far too slow for credential stuffing to be worth running, while
 *    leaving room for a shared address's normal sign-in traffic.
 *  - `checkout` 60/min — each accepted request decrements stock and holds it
 *    for 15 minutes, so this bounds inventory-exhaustion; 60 is well above
 *    what a NAT'd office or a carrier gateway produces legitimately.
 *  - `agent` 30/min — each accepted request can cost a model call against the
 *    merchant's monthly AI allowance, so this is the tightest of the four.
 *    Still well above a human conversation's pace (a shopper types a message
 *    every few seconds at most), and the per-conversation throttle is what
 *    actually shapes a single chat; this exists so one address cannot fan out
 *    across fresh conversations to escape that throttle.
 *  - `webhooks` 600/min PER TENANT — deliberately far above any real store's
 *    settlement rate. A 429 here is a delivery refused, i.e. a payment whose
 *    settle is postponed to the gateway's retry, so this exists only to stop a
 *    pathological loop, never to shape normal traffic.
 *
 * Overridable because the right value depends on deployment shape (how many
 * shoppers sit behind one address, how many stores share one API), and
 * discovering a limit is wrong should not require a code change. The env var
 * is read once at boot.
 *
 * Tests raise these so the suite's own bursts — which all originate from one
 * address — are not throttled. `test/rate-limit.test.ts` exercises the limiter
 * directly with its own small limits, and `test/rate-limit-wiring.test.ts`
 * lowers them deliberately to prove the middleware really is mounted on the
 * routes claimed here.
 */
function envLimit(name: string, fallback: number): number {
  const raw = process.env[`RATE_LIMIT_${name.toUpperCase()}_PER_MINUTE`];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  // A malformed value falls back rather than becoming NaN — a NaN limit would
  // make `count > limit` always false, i.e. silently no limiting at all.
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export const RATE_LIMITS = {
  auth: () => envLimit('auth', 60),
  checkout: () => envLimit('checkout', 60),
  agent: () => envLimit('agent', 30),
  webhooks: () => envLimit('webhooks', 600),
};

export function createRateLimiter(redis: Redis, options: RateLimitOptions) {
  const { name, limit, windowSeconds, key, errorCode } = options;

  return function rateLimit(req: Request, res: Response, next: NextFunction): void {
    const subject = key(req);
    if (subject === null) {
      next();
      return;
    }

    // The window is part of the KEY, not tracked as state: every caller in the
    // same wall-clock window lands on the same key, and the key simply stops
    // being written to when the window rolls over. Combined with the TTL below
    // that means expiry is Redis's job and there is nothing to sweep.
    const window = Math.floor(Date.now() / 1000 / windowSeconds);
    const redisKey = `ratelimit:${name}:${subject}:${window}`;

    void redis
      .multi()
      .incr(redisKey)
      // Set on every request rather than only on the first. Setting it only
      // when the counter comes back as 1 leaves a key with no TTL if the
      // process dies between INCR and EXPIRE — a counter that never resets,
      // which locks that caller out permanently. Re-setting an already-set TTL
      // is idempotent here because the key itself changes each window, so this
      // cannot extend a window indefinitely.
      .expire(redisKey, windowSeconds)
      .exec()
      .then((results) => {
        // ioredis returns [[err, value], ...] per queued command, so a failure
        // of the INCR shows up here rather than as a rejection.
        const incr = results?.[0];
        const count = incr && incr[0] === null ? Number(incr[1]) : null;
        if (count === null || Number.isNaN(count)) {
          next();
          return;
        }

        if (count > limit) {
          // Seconds until this window ends — a real number the caller can act
          // on, not a fixed guess.
          const retryAfter = Math.max(1, (window + 1) * windowSeconds - Math.floor(Date.now() / 1000));
          res.setHeader('Retry-After', String(retryAfter));
          res.status(429).json({ error: errorCode, details: { retryAfterSeconds: retryAfter } });
          return;
        }

        next();
      })
      .catch((err: unknown) => {
        // Fail open — see the module comment. Logged so an outage is visible
        // as a loss of protection rather than passing silently.
        console.error(`[ratelimit] ${name} check failed, allowing request`, {
          error: err instanceof Error ? err.message : String(err),
        });
        next();
      });
  };
}
