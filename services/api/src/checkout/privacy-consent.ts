import { createHash } from 'node:crypto';

/**
 * The *prueba de la autorización* a checkout records — Ley 1581 de 2012 arts.
 * 8 and 9, SPEC.md §9.
 *
 * ## What has to be provable, and why a fingerprint proves it
 *
 * Art. 9 requires the Titular's authorization to be prior, express and
 * informed; art. 8 lit. e) then lets that same Titular demand "prueba de la
 * autorización otorgada", and Decreto 1377 art. 12 puts the duty to keep that
 * proof on the Responsable. Two facts have to survive the checkout to answer
 * that demand: WHEN the shopper authorized, and WHAT they were told when they
 * did. The first is a timestamp. The second is the problem this module
 * solves.
 *
 * A merchant can rewrite their política de tratamiento at any moment through
 * `PUT /v1/admin/content/policy_privacy`, and `TenantContent` keeps no
 * revision history and not even an `updatedAt` — so "the policy" is not a
 * stable thing to point at after the fact. Recording a fingerprint of the
 * exact bytes published at checkout time makes the claim FALSIFIABLE in the
 * only direction that matters: hand a candidate text to
 * {@link privacyPolicyVersionFor} and you learn whether it is the text that
 * shopper was pointed at. It cannot resurrect a policy the merchant later
 * overwrote — nothing short of storing ~8 KB of duplicate text on every
 * single order could, and that is a real, stated limit of this design rather
 * than an oversight — but it does mean a merchant cannot quietly claim a
 * NEWER, friendlier policy was the one in force.
 *
 * ## Why the version is computed here and never accepted from the client
 *
 * The browser is the party whose authorization is being evidenced. Letting it
 * name the policy version (or the timestamp) would make the evidence a copy
 * of the assertion it is supposed to corroborate. The storefront therefore
 * sends one boolean — "I ticked the box" — and the server records what was
 * actually published, at its own clock.
 */

/**
 * Recorded as the version when the tenant had NO política de tratamiento
 * published at the moment of checkout.
 *
 * Not a filler and not an error: it is the honest evidence that this
 * particular authorization was given against the storefront's generic
 * fallback copy (`POLICY_DEFAULTS.policy_privacy` in
 * apps/storefront/lib/policy-defaults.ts, which deliberately refuses to
 * fabricate a policy in the merchant's name and instead states the shopper's
 * rights and points at /contacto) rather than against a policy the merchant
 * wrote. A merchant auditing their own orders should be able to see exactly
 * which of their sales are in that state, and there is no way to see it if
 * the column is left null or filled with a plausible-looking hash.
 *
 * Spanish, like every other merchant-visible value in this codebase, and
 * deliberately not hash-shaped so it can never be mistaken for one.
 */
export const NO_PUBLISHED_POLICY_VERSION = 'sin-politica-publicada';

/** Prefix on every real fingerprint, so a reader of the column knows both
 * that it is a digest and which digest — and so a future change of algorithm
 * is distinguishable from this one rather than silently comparing unequal. */
const VERSION_PREFIX = 'sha256:';

/**
 * Hex characters kept from the digest.
 *
 * 16 hex characters is 64 bits. The thing this guards against is a merchant
 * substituting a different policy text after the fact and claiming it was the
 * one in force; finding a second text that collides on 64 bits is a targeted
 * second-preimage search, ~2^64 work, far past the effort anyone will spend
 * to win a SIC complaint — and the column is written by us, never by an
 * adversary who could grind a collision at leisure against a chosen target.
 * The full 64 hex characters would make the column four times larger on every
 * order to buy nothing at this threat level.
 */
const VERSION_HEX_LENGTH = 16;

/**
 * Fingerprints the policy a shopper was pointed at.
 *
 * `null` — no `TenantContent(policy_privacy)` row at all — and a row whose
 * body is empty or whitespace are the SAME case, and both answer
 * {@link NO_PUBLISHED_POLICY_VERSION}: what a shopper can actually read is
 * nothing either way, and the evidence has to describe what they saw, not
 * what shape the database was in. (`TenantContent.bodyMd` defaults to `""`,
 * so an empty row is reachable.)
 *
 * The title is hashed along with the body, separated by a NUL — a byte that
 * cannot occur in a Postgres `text` value — so no pair of (title, body) can
 * be re-cut into a different pair with the same concatenation.
 *
 * Pure: same input, same output, no clock and no database, so the checkout
 * path can be tested without either.
 */
export function privacyPolicyVersionFor(policy: { title: string; bodyMd: string } | null): string {
  if (policy === null || policy.bodyMd.trim().length === 0) return NO_PUBLISHED_POLICY_VERSION;
  const digest = createHash('sha256').update(`${policy.title}\0${policy.bodyMd}`, 'utf8').digest('hex');
  return `${VERSION_PREFIX}${digest.slice(0, VERSION_HEX_LENGTH)}`;
}
