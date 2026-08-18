/**
 * Generates the value for `Order.reference` — the string handed to a payment
 * gateway, and the only identifier a webhook settle is resolved through.
 *
 * Full reasoning:
 * docs/superpowers/specs/2026-08-15-per-order-gateway-references.md
 *
 * ## Why random rather than derived
 *
 * The obvious alternative — `{tenantSlug}-{orderNumber}`, or a truncated
 * tenant uuid — also makes the reference globally unique, and was the first
 * idea. It is guessable, and that matters concretely: ePayco's `x_extra1`
 * (the field carrying this value on its confirmation webhook) is NOT covered
 * by ePayco's confirmation hash, so the reference is attacker-supplied until
 * the gateway's own lookup corroborates it. A guessable reference lets someone
 * name an order that is not theirs; a random one names nothing.
 *
 * A derived reference would also leak a tenant identifier into a third
 * party's dashboard, logs and customer emails. This value's only job is to be
 * matched, so it should carry no information at all.
 *
 * ## Shape
 *
 * `vr_` + 26 lowercase base32 characters, e.g.
 * `vr_k3n8q2rr7vd5wmxc4b6ftz9puy`.
 *
 *  - **The prefix is what makes the transitional numeric branch in
 *    `webhooks.controller.ts` unambiguous.** References issued before this
 *    existed were bare order numbers; a new reference can never be all-digits,
 *    so the handler can tell the two apart with certainty rather than by
 *    heuristic.
 *  - **Base32, not base64 or hex.** These strings travel through URL query
 *    strings, form-encoded webhook bodies and at least one gateway dashboard.
 *    Base64's `+/=` need escaping in some of those; base32's alphabet is safe
 *    in all of them untouched. Hex would be safe too but needs ~1.6x the
 *    characters for the same entropy, and gateway reference fields have length
 *    limits this stays comfortably inside.
 *  - **16 random bytes (128 bits).** Not a compromise between guessability
 *    and length — at this size guessing is not a threat model, it is
 *    arithmetic. Collision across every order the platform will ever write is
 *    likewise negligible, and the column's UNIQUE constraint is the backstop
 *    if that reasoning is ever wrong.
 */
const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

export const ORDER_REFERENCE_PREFIX = 'vr_';

export function generateOrderReference(): string {
  // Web Crypto, not `node:crypto`. This module lives in `@ventia/core`, which
  // the admin and storefront apps also import — a `node:crypto` import makes
  // webpack fail the browser build outright ("Reading from 'node:crypto' is
  // not handled by plugins"). `globalThis.crypto.getRandomValues` is the same
  // CSPRNG, present in Node 18+ and every browser, and needs no import at all.
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let bits = 0;
  let value = 0;
  let out = '';

  // Standard base32 accumulate-and-drain: pull 5 bits at a time out of a
  // rolling buffer. No padding — nothing decodes these, they are compared as
  // opaque strings.
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }

  return `${ORDER_REFERENCE_PREFIX}${out}`;
}

/**
 * Whether a reference string is one this system issued.
 *
 * Used by the webhook handler to separate a current reference from the
 * transitional bare-order-number form. Deliberately a shape check and nothing
 * more — it says "this looks like ours", never "this names a real order",
 * which only a database lookup can answer.
 */
export function isOrderReference(value: string): boolean {
  return value.startsWith(ORDER_REFERENCE_PREFIX) && value.length > ORDER_REFERENCE_PREFIX.length;
}
