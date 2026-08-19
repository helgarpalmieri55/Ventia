import { describe, expect, it } from 'vitest';
import { NO_PUBLISHED_POLICY_VERSION, privacyPolicyVersionFor } from '../src/checkout/privacy-consent';

/**
 * The pure half of the Ley 1581 art. 8 lit. e) *prueba de la autorización* —
 * no database, no container. The end-to-end behaviour (that a real checkout
 * writes this onto the order, and which value) lives in test/checkout.test.ts;
 * this file pins the properties that make the recorded value usable as
 * evidence at all.
 */
describe('privacyPolicyVersionFor', () => {
  const policy = { title: 'Política de tratamiento de datos personales', bodyMd: 'Texto de la política.' };

  it('is a stable, reproducible fingerprint of the exact published text', () => {
    // THE property. Evidence is only evidence if a third party can check it:
    // hand this function a candidate policy and it says whether that is the
    // text the shopper was pointed at. A random or time-derived value would
    // record that *something* was accepted and nothing about what.
    expect(privacyPolicyVersionFor(policy)).toBe(privacyPolicyVersionFor({ ...policy }));
    expect(privacyPolicyVersionFor(policy)).toMatch(/^sha256:[0-9a-f]{16}$/);
  });

  it('changes when the merchant changes one character of the body or the title', () => {
    const base = privacyPolicyVersionFor(policy);
    expect(privacyPolicyVersionFor({ ...policy, bodyMd: `${policy.bodyMd} ` })).not.toBe(base);
    expect(privacyPolicyVersionFor({ ...policy, title: `${policy.title}.` })).not.toBe(base);
  });

  it('cannot be fooled by re-cutting the same characters between title and body', () => {
    // The title and the body are joined with a NUL, which no Postgres `text`
    // value can contain — so ("Política", "de datos") and ("Política de",
    // "datos") are different documents and get different fingerprints. A
    // plain concatenation would call them the same one.
    const a = privacyPolicyVersionFor({ title: 'Política', bodyMd: 'de datos' });
    const b = privacyPolicyVersionFor({ title: 'Políticade', bodyMd: ' datos' });
    expect(a).not.toBe(b);
  });

  it('says so, in words, when the merchant has published no policy at all', () => {
    // Not null and not a plausible-looking hash: a merchant auditing their own
    // orders has to be able to SEE which of their sales were authorized
    // against nothing they wrote. The storefront shows the platform's generic
    // fallback in that case (lib/policy-defaults.ts), which deliberately
    // refuses to fabricate a policy in the merchant's name.
    expect(privacyPolicyVersionFor(null)).toBe(NO_PUBLISHED_POLICY_VERSION);
    expect(NO_PUBLISHED_POLICY_VERSION).not.toMatch(/^sha256:/);
  });

  it('treats an empty or whitespace-only body as "nothing published"', () => {
    // `TenantContent.bodyMd` defaults to `""`, so a row with a title and no
    // text is reachable. What the shopper can actually read is nothing either
    // way, and the evidence must describe what they saw rather than what
    // shape the database was in.
    expect(privacyPolicyVersionFor({ title: 'Privacidad', bodyMd: '' })).toBe(NO_PUBLISHED_POLICY_VERSION);
    expect(privacyPolicyVersionFor({ title: 'Privacidad', bodyMd: '   \n\n  ' })).toBe(
      NO_PUBLISHED_POLICY_VERSION,
    );
  });

  it('carries nothing about any shopper: it is a function of the merchant text alone', () => {
    // This is what makes the anonymizer's decision to LEAVE the column alone
    // on a supresión request correct (test/privacy-anonymize.test.ts). The
    // signature takes one argument, and it is the policy — there is nowhere
    // for a shopper's identity to enter.
    expect(privacyPolicyVersionFor.length).toBe(1);
    expect(privacyPolicyVersionFor(policy)).not.toMatch(/@/);
  });
});
