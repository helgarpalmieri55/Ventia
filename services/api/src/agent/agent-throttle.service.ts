import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../common/redis.module';

/**
 * Per-conversation throttling for the AI agent (docs/SPEC.md §7: "20 mensajes
 * por conversación cada 5 minutos" plus a cool-down on repeated identical
 * messages).
 *
 * ## Why this is not the Express rate limiter
 *
 * `common/rate-limit.ts` keys on the client address, which is the right unit
 * for credential stuffing and checkout spam. It is the wrong unit here twice
 * over: a large share of Colombian shopper traffic is mobile and shares one
 * CGNAT address, so an IP budget tight enough to matter would cut off real
 * conversations; and the thing being protected is not the server but the
 * merchant's per-message AI budget, which is spent per CONVERSATION. An IP
 * limiter still sits in front of this route (see main.ts) to bound how many
 * conversations one address can start — the two limits answer different
 * questions and both are needed.
 *
 * Enforced inside `AgentService.respond` rather than in the controller so that
 * every channel inherits it. The web widget is the first caller; WhatsApp
 * (P5) will call the same method in-process and must not have to remember to
 * re-implement this.
 *
 * ## Fails open
 *
 * Same reasoning as the request limiter: this is abuse control, not
 * authorization. A Redis outage must not take a merchant's storefront chat
 * down with it. The budget hard cap — the limit that actually protects money —
 * lives in Postgres precisely because it may never fail open.
 */

/** SPEC.md §7's per-conversation budget. */
const MESSAGE_LIMIT = 20;
const WINDOW_SECONDS = 5 * 60;

/**
 * How long the same text from the same conversation is treated as a repeat.
 *
 * This is aimed at a client stuck in a retry loop, or a shopper double-tapping
 * send — not at someone deliberately asking the same question twice, which is
 * why the response is the previous answer rather than a refusal. Long enough
 * to swallow a retry storm, short enough that "¿hola?" thirty seconds later is
 * a genuinely new question.
 */
const DUPLICATE_WINDOW_SECONDS = 30;

export type ThrottleDecision =
  | { kind: 'allow' }
  /** Over the per-conversation message budget. */
  | { kind: 'rate_limited'; retryAfterSeconds: number }
  /** The identical message arrived again inside the cool-down window. */
  | { kind: 'duplicate' };

/** What the shopper sees when they have outrun the per-conversation budget.
 * Deliberately not an error code: this is a chat window, and the person on the
 * other end is usually a real customer typing too fast, not an attacker. */
export const THROTTLED_REPLY =
  'Vas muy rápido y no alcanzo a responderte. Espera un momento y vuelve a escribirme.';

@Injectable()
export class AgentThrottleService {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /**
   * Decides whether this message may reach the model.
   *
   * Called AFTER the conversation is resolved (it is keyed on the
   * conversation) but BEFORE anything is persisted or any model call is made —
   * a throttled message costs the merchant neither a row nor a token.
   */
  async check(conversationId: string, message: string): Promise<ThrottleDecision> {
    try {
      const duplicate = await this.isDuplicate(conversationId, message);
      // Checked first: a client retry loop sends the same text, and reporting
      // it as "too fast" would send the client into an exponential backoff for
      // something that is really "you already asked me this".
      if (duplicate) return { kind: 'duplicate' };

      const window = Math.floor(Date.now() / 1000 / WINDOW_SECONDS);
      const key = `agent:conv:${conversationId}:${window}`;
      const [incr] = (await this.redis.multi().incr(key).expire(key, WINDOW_SECONDS).exec()) ?? [];
      const count = incr && incr[0] === null ? Number(incr[1]) : NaN;
      if (Number.isNaN(count)) return { kind: 'allow' };

      if (count > MESSAGE_LIMIT) {
        const retryAfterSeconds = Math.max(
          1,
          (window + 1) * WINDOW_SECONDS - Math.floor(Date.now() / 1000),
        );
        return { kind: 'rate_limited', retryAfterSeconds };
      }
      return { kind: 'allow' };
    } catch (err) {
      console.error('[agent-throttle] check failed, allowing message', {
        error: err instanceof Error ? err.message : String(err),
      });
      return { kind: 'allow' };
    }
  }

  /**
   * `SET NX` on a hash of the message: the first sender writes the key and is
   * allowed through, an identical message inside the TTL finds it already
   * there. One round trip, self-expiring, and nothing to sweep.
   *
   * Hashed rather than stored verbatim so a shopper's message text is not
   * sitting in a cache key — Redis here is shared infrastructure and its
   * keyspace shows up in logs and dashboards.
   */
  private async isDuplicate(conversationId: string, message: string): Promise<boolean> {
    const digest = createHash('sha256').update(message.trim().toLowerCase()).digest('hex').slice(0, 32);
    const key = `agent:dup:${conversationId}:${digest}`;
    const set = await this.redis.set(key, '1', 'EX', DUPLICATE_WINDOW_SECONDS, 'NX');
    return set === null;
  }
}
